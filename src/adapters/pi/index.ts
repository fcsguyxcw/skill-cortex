/**
 * Phase 1 Pi 薄适配层 — 宿主注册层（真实类型接线，被 npm run typecheck 覆盖）。
 *
 * - 真实宿主类型：import type { ExtensionAPI, BeforeAgentStartEvent } 事件推断；
 * - 真实工具构造：defineTool（@earendil-works/pi-coding-agent）+ Type（@earendil-works/pi-ai）；
 * - before_agent_start：从 event.prompt 与 event.systemPromptOptions.skills 摄入，
 *   调用 Registry + BM25（纯逻辑在 core.ts）；
 * - shadow（默认）：有界候选只交给 onShadow（不含完整用户 prompt），返回 undefined；
 * - inject：移除 Pi 原生全量 Skill block（无法唯一定位/移除后仍残留 marker 时 fail open），
 *   再追加有界 Top-K candidate cards + single/multi/no-skill 选择说明；
 * - onDiscovery：有界候选快照回调（shadow 报告 exposedToAgent=false；inject 仅在最终 prompt
 *   确定后报告 exposedToAgent=true；rewrite 失败不产出快照，只走 onError(prompt_rewrite)）；
 * - 任何 Registry/Index 错误 fail open：不注入、不持久化；原始 error 仅交给 onError 本地处理；
 * - 模型可见诊断（search_skills）只含稳定错误类别，不泄漏绝对路径/文件内容/原始 Error.message。
 *
 * 本层不做：写用户级环境、appendEntry、创建 PracticeEvent、调用 LLM。
 */
import { defineTool, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

import type { SkillCandidate } from "../../core/contracts/index.ts";
import { MAX_TOP_K } from "../../discovery/index.ts";
import {
  buildInjectionBlock,
  clampTopK,
  createDiscoveryServices,
  DEFAULT_MODE,
  runLoadSkill,
  runSearchTool,
  type DiscoveryOutcome,
  type RegisterOptions,
  type ShadowResult,
} from "./core.ts";

export type { AdapterMode, DiscoveryResult, RegisterOptions, ShadowResult } from "./core.ts";
// 兼容导出：仅测试桩用（外部测试 import 旧窄接口）；生产签名以真实 ExtensionAPI 为准。
export type {
  HostBeforeAgentStartEventLike,
  HostExtensionApiLike,
  HostSkillLike,
  HostToolResultLike,
} from "./host.ts";

/**
 * 注册 Skill Cortex 适配层。pi 参数为真实 ExtensionAPI。
 * 默认 mode="shadow"：不注入候选卡、不修改 systemPrompt。
 */
export function registerSkillCortex(pi: ExtensionAPI, options: RegisterOptions = {}): void {
  const mode = options.mode ?? DEFAULT_MODE;
  const topK = clampTopK(options.topK);
  const services = createDiscoveryServices({
    topK,
    overlayProfiles: options.overlayProfiles,
    overlayOptions: options.overlayOptions,
  });
  const onShadow = options.onShadow;
  const onDiscovery = options.onDiscovery;
  const onSearchExposure = options.onSearchExposure;
  const onCatalog = options.onCatalog;
  const onError = options.onError;

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
    const outcome: DiscoveryOutcome = await services.run(
      event.prompt,
      event.systemPromptOptions?.skills ?? [],
    );

    if (!outcome.ok) {
      // fail open：原始 error 仅交给 onError 做本地处理；不注入、不持久化、不阻断主 Agent。
      onError?.(outcome.error, { phase: "ingest" });
      return undefined;
    }
    if (
      outcome.exposure === undefined ||
      outcome.candidateBudget === undefined ||
      outcome.cardProjection === undefined ||
      outcome.cache === undefined
    ) {
      onError?.(new Error("Exposure observation missing"), { phase: "ingest" });
      return undefined;
    }

    // 成功摄入后回调当次 catalog records（供 Phase 6 induction 取父 SkillRecord 作者字段）。
    if (onCatalog !== undefined && services.state.catalog !== undefined) {
      onCatalog([...services.state.catalog.values()].map((entry) => entry.record));
    }

    if (mode === "shadow") {
      // shadow：候选不进入 prompt，只作为未暴露快照报告（exposedToAgent=false）。
      onDiscovery?.({
        candidates: outcome.candidates,
        recordCount: outcome.recordCount,
        durationMs: outcome.durationMs,
        topK,
        exposedToAgent: false,
        deliveryMode: "shadow",
        exposure: outcome.exposure,
        candidateBudget: outcome.candidateBudget,
        cardProjection: outcome.cardProjection,
        cache: outcome.cache,
      });
      const result: ShadowResult = {
        candidateCount: outcome.candidates.length,
        candidates: outcome.candidates,
        cardText: buildInjectionBlock(outcome.candidates, topK),
        recordCount: outcome.recordCount,
        durationMs: outcome.durationMs,
      };
      onShadow?.(result);
      return undefined; // shadow：不修改 systemPrompt
    }

    // inject：先精确移除 Pi 0.84.1 已构建的原生全量 Skill block，再追加有界候选块。
    // 无法唯一移除或移除后仍残留 <available_skills> 时 fail open，避免返回
    // “可能仍含全量 metadata + Top-K”的 prompt。
    const nativeSkillBlock = formatSkillsForPrompt(event.systemPromptOptions?.skills ?? []);
    const hasNativeMarker = event.systemPrompt.includes("<available_skills>");
    let promptWithoutCatalog = event.systemPrompt;
    if (nativeSkillBlock !== "") {
      const first = event.systemPrompt.indexOf(nativeSkillBlock);
      const last = event.systemPrompt.lastIndexOf(nativeSkillBlock);
      if (first === -1 || first !== last) {
        onError?.(new Error("Pi native Skill block could not be uniquely removed"), {
          phase: "prompt_rewrite",
        });
        return undefined;
      }
      promptWithoutCatalog =
        event.systemPrompt.slice(0, first) + event.systemPrompt.slice(first + nativeSkillBlock.length);
    } else if (hasNativeMarker) {
      // skills 为空/未提供但 prompt 仍含原生 marker（异常/陈旧快照或其它扩展残留）：
      // 无法可靠移除，fail open，绝不产生“全量 + Top-K”混合。
      onError?.(new Error("Pi native Skill block present but skills unavailable for removal"), {
        phase: "prompt_rewrite",
      });
      return undefined;
    }
    if (promptWithoutCatalog.includes("<available_skills>")) {
      // 唯一 block 已移除但仍有残留 marker（第二份/外来块）：不得静默保留任何全量 metadata。
      onError?.(new Error("Pi native Skill block could not be fully removed"), {
        phase: "prompt_rewrite",
      });
      return undefined;
    }

    const finalPrompt = `${promptWithoutCatalog}\n\n${buildInjectionBlock(outcome.candidates, topK)}`;
    // 归因边界：只有最终 prompt 确定（原生 block 已成功移除、Top-K 已注入）才报告
    // exposedToAgent=true 的快照；上述任何 rewrite 失败路径均已 return undefined，
    // 不产出 route snapshot（失败状态已由 onError(prompt_rewrite) 报告）。
    onDiscovery?.({
      candidates: outcome.candidates,
      recordCount: outcome.recordCount,
      durationMs: outcome.durationMs,
      topK,
      exposedToAgent: true,
      deliveryMode: "inject",
      exposure: outcome.exposure,
      candidateBudget: outcome.candidateBudget,
      cardProjection: outcome.cardProjection,
      cache: outcome.cache,
    });
    return { systemPrompt: finalPrompt };
  });

  pi.registerTool(
    defineTool({
      name: "search_skills",
      label: "Search Skills",
      description:
        "按关键词搜索已加载的 Skill（名称/描述/别名），返回有界候选列表；绝不返回完整 catalog。用于补搜与诊断。",
      promptSnippet: "Search loaded skills by name, description, and alias",
      promptGuidelines: [
        "Use search_skills when the Skill Cortex candidate cards do not include a skill you suspect is relevant.",
        "search_skills returns at most 10 candidates; it never returns the full catalog.",
      ],
      parameters: Type.Object({
        query: Type.String({
          minLength: 1,
          description: "能力关键词，与 Skill 名称/描述/别名匹配（支持中英文）",
        }),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_TOP_K,
            description: "候选数量上限（1..10，默认 5）",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const result = runSearchTool(services.state, params);
        const details = result.details as { ready?: unknown; matches?: unknown } | undefined;
        if (details?.ready === true && Array.isArray(details.matches)) {
          onSearchExposure?.(details.matches as SkillCandidate[]);
        }
        return result;
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "load_skill",
      label: "Load Skill",
      description:
        "按 skill_id + skill_revision 加载候选 Skill 的完整 SKILL.md 正文（只读、revision 与路径校验、大小上限）。仅用于慢路径需要完整说明时。",
      promptSnippet: "Load a selected skill's full SKILL.md by skill_id and skill_revision",
      promptGuidelines: [
        "Call load_skill only after selecting a candidate skill (single or multi), and only when you need the full SKILL.md for the slow path.",
        "Pass skill_id and skill_revision exactly as shown on the candidate card or search_skills result.",
        "load_skill is fail-closed: unknown id, revision mismatch, source drift, oversized or non-UTF-8 files are refused.",
      ],
      parameters: Type.Object({
        skill_id: Type.String({
          minLength: 1,
          description: "候选卡/补搜结果中的 skill_id",
        }),
        skill_revision: Type.String({
          minLength: 1,
          description: "候选卡/补搜结果中的 skill_revision（必须与当前 catalog 一致）",
        }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        return runLoadSkill(services.state, params);
      },
    }),
  );
}
