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
import { lstat, readFile, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import type { ActivationProfile, SkillCandidate, SkillRecord } from "../../core/contracts/index.ts";
import type { DependencyEntry, SkillPackageInput } from "../../core/registry/index.ts";
import {
  buildSkillRecord,
  compareManifestEntries,
  computeContentHash,
  computeSkillRevision,
  computeSourceHash,
  enumerateManifest,
  INSTRUCTION_LOCATOR,
  isPathInside,
} from "../../core/registry/index.ts";
import {
  buildIndex,
  DEFAULT_TOP_K,
  MAX_TOP_K,
  type DiscoveryIndex,
} from "../../discovery/index.ts";
import { formatCandidateCards } from "../../discovery/index.ts";
import { applyActiveProfiles } from "../../activation/overlay.ts";
import type { RerankOptions } from "../../activation/rerank.ts";
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
  /** 每次成功摄入+检索后触发的有界快照回调（inject 与 shadow 都触发；B3 observer 用当次候选快照）。 */
  onDiscovery?: (result: DiscoveryResult) => void;
  /** 每次成功摄入后回调（当次 catalog SkillRecord；供 Phase 6 induction 取父 SkillRecord 作者字段）。 */
  onCatalog?: (records: readonly SkillRecord[]) => void;
  /** active discovery overlay：返回当次 active ActivationProfile（静态 BM25 候选后软重排）。 */
  overlayProfiles?: () => readonly ActivationProfile[];
  /** overlay 重排参数（与 rerank 一致；未提供用默认关闭）。 */
  overlayOptions?: RerankOptions;
  /** 摄入/检索失败回调（fail open，不阻断主 Agent）。 */
  onError?: (error: unknown, context: { phase: "ingest" | "prompt_rewrite" }) => void;
}
export interface ShadowResult {
  candidateCount: number;
  /** 有界候选（≤ topK）。不含完整用户 prompt（onShadow 不暴露原始任务文本）。 */
  candidates: readonly SkillCandidate[];
  cardText: string;
  recordCount: number;
  durationMs: number;
}

/**
 * onDiscovery 快照：与注入块/onShadow 完全同源的当次候选（≤ topK），供 B3 observer
 * 构造 PracticeEvent 的 `candidateSkillIds` 快照。绝不包含原始用户 prompt、systemPrompt
 * 或全量 catalog；候选卡字段即 SkillCandidate 合同（§4.2），不含正文/路径/内容指纹。
 *
 * 归因边界：只有候选真正进入 Main Agent 的最终 prompt 时 `exposedToAgent` 才为 true。
 * - shadow：候选不注入 prompt，恒为 false；
 * - inject：仅当原生全量 block 成功移除、最终 prompt 确定后才为 true；
 *   prompt rewrite 失败（fail open）时不产出本快照（只走 onError(prompt_rewrite)），
 *   避免 real observer 把从未展示给 Main Agent 的候选误记为已暴露。
 */
export interface DiscoveryResult {
  /** 本次成功摄入+检索的有界候选（≤ topK；无匹配时为空数组）。 */
  candidates: readonly SkillCandidate[];
  /** 本次实际摄入的 record 数（不含 disableModelInvocation=true）。 */
  recordCount: number;
  /** 摄入+检索耗时（ms）。 */
  durationMs: number;
  /** 本次实际应用的候选预算。 */
  topK: number;
  /** 候选是否已进入 Main Agent 的最终 prompt（shadow=false；inject 成功=true）。 */
  exposedToAgent: boolean;
  /** 候选暴露/注入方式："shadow"（未进入 prompt）| "inject"（已进入最终 prompt）。 */
  deliveryMode: "shadow" | "inject";
}

/** 摄入/索引构建失败的稳定错误类别（模型可见诊断只用类别，绝不泄漏路径/内容/原始 message）。 */
export const INGEST_ERROR_CATEGORY = "skill_ingest_failed";

/**
 * 从当次宿主 skills 派生 skillId → sourceHash 表（per-call current source 的 Point A 接线）。
 *
 * 契约边界：
 * - 与 catalog 摄入用同一 buildSkillRecord 逻辑（同一输入 ⇒ 同一 skillId/sourceHash），
 *   保证与 onDiscovery 候选卡的 skillId 键一致；
 * - 只暴露内容指纹（sha256），不落盘、不进 prompt、不暴露路径/正文；
 * - disabled/摄入失败项跳过 ⇒ 缺失项由调用方 fail-closed（不臆造匹配）；
 * - 只读：不修改任何 Skill 文件。
 */
export async function deriveDiscoverySourceHashes(
  skills: readonly HostSkillLike[],
): Promise<ReadonlyMap<string, string>> {
  const map = new Map<string, string>();
  for (const skill of skills) {
    if (skill.disableModelInvocation === true) continue;
    try {
      const record = await buildSkillRecord({
        name: skill.name,
        description: skill.description,
        scope: skill.sourceInfo.scope,
        baseDir: skill.baseDir,
        skillMdPath: skill.filePath,
        disableModelInvocation: skill.disableModelInvocation,
        declaredAliases: [],
        declaredPermissions: [],
        declaredEffects: [],
      });
      map.set(record.skillId, record.sourceHash);
    } catch {
      // 摄入失败的 skill 不在 catalog ⇒ 也不在本表（缺失 ⇒ 调用方 fail-closed）。
    }
  }
  return map;
}

/**
 * load_skill 单次返回的 SKILL.md 正文大小上限（字节，安全常量，非统计/门阈值）。
 * 256 KiB 对合法 instruction 文件（含内嵌示例）足够宽松，同时保证慢路径单次读取
 * 不会把无界内容注入模型上下文。超限一律拒绝。
 */
export const MAX_SKILL_MD_BYTES = 256 * 1024;

/** load_skill 可加载的 catalog 条目：SkillRecord + 父 baseDir（合同不保存 baseDir，仅 adapter 持有用于加载时路径包含校验）。 */
export interface LoadableSkill {
  record: SkillRecord;
  /** 父 Skill 根目录绝对路径。 */
  baseDir: string;
}

/** search_skills 工具的可观察状态。 */
export interface AdapterState {
  /** 最近一次摄入+索引是否成功。 */
  ready: boolean;
  /** 最近一次失败的稳定错误类别（未失败则为 undefined）。不含绝对路径、文件内容或原始 Error.message。 */
  lastErrorCategory?: string;
  index?: DiscoveryIndex;
  /** 成功摄入的 catalog（skillId → record + baseDir）；load_skill 只接受此集合中的条目。 */
  catalog?: ReadonlyMap<string, LoadableSkill>;
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
export function createDiscoveryServices(options: {
  topK: number;
  overlayProfiles?: () => readonly ActivationProfile[];
  overlayOptions?: RerankOptions;
}): DiscoveryServices {
  const state: AdapterState = { ready: false, recordCount: 0 };
  return {
    topK: options.topK,
    state,
    async run(prompt, skills): Promise<DiscoveryOutcome> {
      const started = Date.now();
      try {
        const inputs = mapSkills(skills);
        const catalog = new Map<string, LoadableSkill>();
        for (const input of inputs) {
          if (input.disableModelInvocation === true) continue;
          const record = await buildSkillRecord(input);
          catalog.set(record.skillId, { record, baseDir: input.baseDir });
        }
        const records = [...catalog.values()].map((entry) => entry.record);
        const index = buildIndex(records);
        const staticCandidates = index.search(prompt, { limit: options.topK });
        // active discovery overlay：静态候选后软重排（仅 revision 匹配的 active profile 生效；
        // 未提供 overlayProfiles ⇒ 纯静态，无损回静态）。
        const candidates = options.overlayProfiles
          ? applyActiveProfiles(staticCandidates, options.overlayProfiles(), prompt, options.overlayOptions)
          : staticCandidates;
        state.ready = true;
        state.lastErrorCategory = undefined;
        state.index = index;
        state.catalog = catalog;
        state.recordCount = records.length;
        return { ok: true, candidates, recordCount: records.length, durationMs: Date.now() - started };
      } catch (error) {
        state.ready = false;
        state.index = undefined;
        state.catalog = undefined;
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
              `${index + 1}. ${candidate.name} [skill_id=${candidate.skillId}, scope=${candidate.scope}, skill_revision=${candidate.skillRevision}]`,
          ),
          "",
          "本列表为有界候选，不代表完整 catalog。",
        ].join("\n");
  return {
    content: [{ type: "text", text }],
    details: { ready: true, query, count: matches.length, matches },
  };
}

/** load_skill 参数（工具 schema 校验后的形状；snake_case 匹配 ADR-0007 与候选卡）。 */
export interface LoadSkillParams {
  skill_id: string;
  skill_revision: string;
}

/** load_skill 稳定结果类别（模型可见只含类别，绝不泄漏路径/内容/原始 error）。 */
export type LoadSkillCategory =
  | "ok"
  | "not_initialized"
  | "ingest_failed"
  | "unknown_skill"
  | "revision_mismatch"
  | "revision_drift"
  | "source_drift"
  | "size_exceeded"
  | "encoding_failed"
  | "path_failure";

const LOAD_FAILURE_TEXT: Readonly<Record<Exclude<LoadSkillCategory, "ok">, string>> = {
  not_initialized: "load_skill 不可用：尚未初始化（未收到 before_agent_start 摄入）。",
  ingest_failed: "load_skill 不可用：摄入/索引构建失败，无可用 catalog。",
  unknown_skill: "load_skill 被拒绝：skill_id 不在当前成功摄入的 catalog 中。",
  revision_mismatch: "load_skill 被拒绝：skill_revision 与当前 catalog 不一致。",
  revision_drift: "load_skill 被拒绝：Skill package 依赖（scripts/references/assets 或 SKILL.md）在摄入后发生变化（revision drift）。",
  source_drift: "load_skill 被拒绝：SKILL.md 内容与摄入时不一致（source drift）。",
  size_exceeded: "load_skill 被拒绝：SKILL.md 超过大小上限。",
  encoding_failed: "load_skill 被拒绝：SKILL.md 不是合法 UTF-8。",
  path_failure: "load_skill 被拒绝：SKILL.md 路径不可安全访问（绝对路径/符号链接/逃逸校验失败）。",
};

function loadFailure(
  ready: boolean,
  category: Exclude<LoadSkillCategory, "ok">,
): HostToolResultLike {
  return {
    content: [{ type: "text", text: LOAD_FAILURE_TEXT[category] }],
    details: { ready, category },
  };
}

function decodeUtf8Strict(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * load_skill 执行（fail closed）：
 * - 只接受当前成功摄入 catalog 中的 skill_id；
 * - 校验精确 skill_revision（catalog 重建/源变化后旧 revision 拒绝）；
 * - sourceLocator 必须绝对、常规文件、非 symlink/junction，且 realpath 保持在父 baseDir 内；
 * - 只读 SKILL.md，不授予任何 declared permission/effect；
 * - 大小 ≤ MAX_SKILL_MD_BYTES，严格 UTF-8 解码，超限/解码失败拒绝；
 * - 重算 SKILL.md sourceHash 与摄入时一致（SKILL.md source drift 拒绝）；
 * - 重算完整 dependency manifest + skillRevision（合同 §3.1：revision 覆盖 scripts/references/assets，
 *   非 instruction 依赖变化同样使缓存 revision 失效，revision_drift 拒绝）；
 * - 成功只返回正文 + 最小 provenance（name/scope/revision/source_hash 内容指纹），不泄漏绝对路径或其它 catalog 条目。
 */
export async function runLoadSkill(
  state: AdapterState,
  params: LoadSkillParams,
): Promise<HostToolResultLike> {
  if (!state.ready || state.catalog === undefined) {
    return loadFailure(false, state.lastErrorCategory === undefined ? "not_initialized" : "ingest_failed");
  }

  const entry = state.catalog.get(params.skill_id);
  if (entry === undefined) {
    return loadFailure(true, "unknown_skill");
  }
  if (params.skill_revision !== entry.record.skillRevision) {
    return loadFailure(true, "revision_mismatch");
  }

  const locator = entry.record.sourceLocator;
  const baseDir = entry.baseDir;

  if (!path.isAbsolute(locator)) return loadFailure(true, "path_failure");
  let stat: Stats;
  try {
    stat = await lstat(locator);
  } catch {
    return loadFailure(true, "path_failure");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return loadFailure(true, "path_failure");
  try {
    const realLocator = await realpath(locator);
    const realBaseDir = await realpath(baseDir);
    if (!isPathInside(realBaseDir, realLocator)) return loadFailure(true, "path_failure");
  } catch {
    return loadFailure(true, "path_failure");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(locator);
  } catch {
    return loadFailure(true, "path_failure");
  }
  if (bytes.length > MAX_SKILL_MD_BYTES) return loadFailure(true, "size_exceeded");

  let body: string;
  try {
    body = decodeUtf8Strict(bytes);
  } catch {
    return loadFailure(true, "encoding_failed");
  }

  if (computeSourceHash(bytes) !== entry.record.sourceHash) {
    return loadFailure(true, "source_drift");
  }

  // 完整依赖 manifest 复核：skillRevision 覆盖整个 package（合同 §3.1），scripts/references/assets
  // 变化会使缓存 revision 失效。枚举失败（权限/IO/符号链接等）一律 fail closed。
  let roleEntries: DependencyEntry[];
  try {
    roleEntries = await enumerateManifest(baseDir);
  } catch {
    return loadFailure(true, "path_failure");
  }
  const instructionEntry: DependencyEntry = {
    locator: INSTRUCTION_LOCATOR,
    contentHash: computeContentHash(bytes),
    role: "instruction",
  };
  const currentManifest = [instructionEntry, ...roleEntries].sort(compareManifestEntries);
  if (computeSkillRevision(currentManifest) !== entry.record.skillRevision) {
    return loadFailure(true, "revision_drift");
  }

  const header = `Loaded skill "${entry.record.name}" (scope=${entry.record.scope}, revision=${entry.record.skillRevision})`;
  return {
    content: [{ type: "text", text: `${header}\n\n${body}` }],
    details: {
      ready: true,
      category: "ok" as const,
      skill_id: entry.record.skillId,
      skill_revision: entry.record.skillRevision,
      name: entry.record.name,
      scope: entry.record.scope,
      // 内容指纹（sha256:…），可审计；不是路径/正文/declared*，不承担身份语义。
      source_hash: entry.record.sourceHash,
      bytes: bytes.length,
    },
  };
}
