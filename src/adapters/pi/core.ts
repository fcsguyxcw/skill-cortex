/**
 * Phase 1 Pi 薄适配层 — 核心逻辑（纯、可测、零宿主运行时依赖）。
 *
 * 职责：
 * - 把宿主 Skill（HostSkillLike）映射为 Registry 的 SkillPackageInput；
 * - 摄入（Registry.buildSkillCatalog）+ 本地 BM25 检索（Discovery.buildIndex/search）；
 * - 构造有界 Top-K candidate cards 注入块（含 single/multi/no-skill 选择说明）；
 * - search_skills 补搜执行（有界、未初始化/构建失败给有界诊断、绝不返回全量 catalog）；
 * - 一切 Registry/Index 错误 fail open：outcome.ok=false，由 register 层负责不注入。
 *
 * 安全边界：declared* 一律空数组（不做任何推断）；不写文件、不持久化、不调用 LLM。
 */
import type { SkillCandidate } from "../../core/contracts/index.ts";
import type { SkillPackageInput } from "../../core/registry/index.ts";
import { buildSkillCatalog } from "../../core/registry/index.ts";
import {
  buildIndex,
  DEFAULT_TOP_K,
  MAX_TOP_K,
  type DiscoveryIndex,
} from "../../discovery/index.ts";
import { formatCandidateCards } from "../../discovery/index.ts";
import type { HostSkillLike, HostToolResultLike } from "./host.ts";

export type AdapterMode = "shadow" | "inject";

/** 默认模式：shadow —— 只把有界候选交给 onShadow，不修改 systemPrompt。 */
export const DEFAULT_MODE: AdapterMode = "shadow";

export interface RegisterOptions {
  /** "shadow"（默认，不注入）| "inject"（在原 systemPrompt 后追加有界候选卡）。 */
  mode?: AdapterMode;
  /** 候选预算，clamp 到 [1, MAX_TOP_K]；默认 DEFAULT_TOP_K。 */
  topK?: number;
  /** shadow 模式回调：只收到有界候选与诊断，不给全量 catalog。 */
  onShadow?: (result: ShadowResult) => void;
  /** 摄入/检索失败回调（fail open，不阻断主 Agent）。 */
  onError?: (error: unknown, context: { phase: "ingest" }) => void;
}
export interface ShadowResult {
  candidateCount: number;
  /** 有界候选（≤ topK）。不含完整用户 prompt（onShadow 不暴露原始任务文本）。 */
  candidates: readonly SkillCandidate[];
  cardText: string;
  recordCount: number;
  durationMs: number;
}

/** 摄入/索引构建失败的稳定错误类别（模型可见诊断只用类别，绝不泄漏路径/内容/原始 message）。 */
export const INGEST_ERROR_CATEGORY = "skill_ingest_failed";

/** search_skills 工具的可观察状态。 */
export interface AdapterState {
  /** 最近一次摄入+索引是否成功。 */
  ready: boolean;
  /** 最近一次失败的稳定错误类别（未失败则为 undefined）。不含绝对路径、文件内容或原始 Error.message。 */
  lastErrorCategory?: string;
  index?: DiscoveryIndex;
  recordCount: number;
}

export interface DiscoveryOutcome {
  ok: boolean;
  error?: unknown;
  /** 有界候选（≤ topK；空查询/无匹配为空数组，绝不回退全量）。 */
  candidates: SkillCandidate[];
  recordCount: number;
  durationMs: number;
}

export interface DiscoveryServices {
  readonly topK: number;
  readonly state: AdapterState;
  run(prompt: string, skills: readonly HostSkillLike[]): Promise<DiscoveryOutcome>;
}

/** 候选预算边界：undefined → 默认；<1 或非有限 → 1；上限 MAX_TOP_K。 */
export function clampTopK(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TOP_K;
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), MAX_TOP_K);
}

/**
 * 宿主 Skill → Registry 输入映射。declared* 一律为空数组（只接收作者显式解析结果，
 * 此处不解析 frontmatter、不推断）；disableModelInvocation 原样保留（buildSkillCatalog 过滤）。
 */
export function mapSkills(skills: readonly HostSkillLike[]): SkillPackageInput[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    scope: skill.sourceInfo.scope,
    baseDir: skill.baseDir,
    skillMdPath: skill.filePath,
    disableModelInvocation: skill.disableModelInvocation,
    declaredAliases: [],
    declaredPermissions: [],
    declaredEffects: [],
  }));
}

/**
 * 创建摄入+检索服务。每次 run() 重新摄入并重建索引（反映最新 skills）；
 * 失败时 state 置为不可用（ready=false、index 清空），绝不静默复用旧索引；
 * state 只记录稳定错误类别（脱敏），原始 error 保留在 outcome.error 供 onError 本地处理，
 * 不进入模型可见诊断、不持久化、不注入。
 */
export function createDiscoveryServices(options: { topK: number }): DiscoveryServices {
  const state: AdapterState = { ready: false, recordCount: 0 };
  return {
    topK: options.topK,
    state,
    async run(prompt, skills): Promise<DiscoveryOutcome> {
      const started = Date.now();
      try {
        const records = await buildSkillCatalog(mapSkills(skills));
        const index = buildIndex(records);
        const candidates = index.search(prompt, { limit: options.topK });
        state.ready = true;
        state.lastErrorCategory = undefined;
        state.index = index;
        state.recordCount = records.length;
        return { ok: true, candidates, recordCount: records.length, durationMs: Date.now() - started };
      } catch (error) {
        state.ready = false;
        state.index = undefined;
        state.recordCount = 0;
        state.lastErrorCategory = INGEST_ERROR_CATEGORY;
        return { ok: false, error, candidates: [], recordCount: 0, durationMs: Date.now() - started };
      }
    },
  };
}

/**
 * inject 模式注入块：明确边界的有界 Top-K 候选卡 + single/multi/no-skill 选择说明。
 * 只接收已裁剪的候选数组，结构上不可能注入全量 catalog。
 */
export function buildInjectionBlock(candidates: readonly SkillCandidate[], topK: number): string {
  const cardBlock = formatCandidateCards(candidates);
  return [
    "## Skill Cortex：prompt 外候选（有界 Top-K）",
    `本块仅包含 ≤ ${topK} 个候选 Skill 卡（本地 BM25，无额外 LLM）；完整 catalog 不在上下文中。`,
    cardBlock,
    "### 选择说明",
    "- Single skill：恰好一个候选适用时，选择它并 load_skill。",
    "- Multi-skill：多个候选互补时，选择互补组合。",
    "- No-skill：无候选适用时继续普通执行，不要强行调用 search_skills / load_skill。",
    "未列出的 Skill 仍可通过 search_skills 补搜。",
  ].join("\n");
}

/** search_skills 参数（由工具 schema 校验后的形状）。 */
export interface SearchParams {
  query: string;
  limit?: number;
}

/**
 * search_skills 执行：有界、未初始化/构建失败给有界诊断（仅稳定类别，不泄漏路径/内容）、
 * 空查询返回空、绝不返回全量。
 */
export function runSearchTool(state: AdapterState, params: SearchParams): HostToolResultLike {
  if (!state.ready || state.index === undefined) {
    const reason =
      state.lastErrorCategory === undefined
        ? "尚未初始化（未收到 before_agent_start 摄入）"
        : `摄入/索引构建失败（类别：${state.lastErrorCategory}）`;
    return {
      content: [{ type: "text", text: `search_skills 不可用：${reason}。未返回任何候选。` }],
      details: { ready: false, category: state.lastErrorCategory ?? "not_initialized", matches: [] },
    };
  }

  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (query === "") {
    return {
      content: [{ type: "text", text: "search_skills：查询为空，未返回任何候选。" }],
      details: { ready: true, query: "", count: 0, matches: [] },
    };
  }

  const limit = clampTopK(params.limit);
  const matches = state.index.search(query, { limit });
  const text =
    matches.length === 0
      ? `未找到匹配 "${query}" 的 Skill。可尝试英文同义词，或换用更具体的能力关键词。`
      : [
          `找到 ${matches.length} 个匹配 Skill（有界 Top-K，≤ ${limit}）：`,
          "",
          ...matches.map(
            (candidate, index) =>
              `${index + 1}. ${candidate.name} [scope=${candidate.scope}, revision=${candidate.skillRevision}]`,
          ),
          "",
          "本列表为有界候选，不代表完整 catalog。",
        ].join("\n");
  return {
    content: [{ type: "text", text }],
    details: { ready: true, query, count: matches.length, matches },
  };
}
