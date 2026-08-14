/**
 * Phase 1 Pi 薄适配层 — 宿主注册层（真实类型接线，被 npm run typecheck 覆盖）。
 *
 * - 真实宿主类型：import type { ExtensionAPI, BeforeAgentStartEvent } 事件推断；
 * - 真实工具构造：defineTool（@earendil-works/pi-coding-agent）+ Type（@earendil-works/pi-ai）；
 * - before_agent_start：从 event.prompt 与 event.systemPromptOptions.skills 摄入，
 *   调用 Registry + BM25（纯逻辑在 core.ts）；
 * - shadow（默认）：有界候选只交给 onShadow（不含完整用户 prompt），返回 undefined；
 * - inject：在原 systemPrompt 后追加有界 Top-K candidate cards + single/multi/no-skill 选择说明；
 * - 任何 Registry/Index 错误 fail open：不注入、不持久化；原始 error 仅交给 onError 本地处理；
 * - 模型可见诊断（search_skills）只含稳定错误类别，不泄漏绝对路径/文件内容/原始 Error.message。
 *
 * 本层不做：写用户级环境、appendEntry、创建 PracticeEvent、调用 LLM。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

import { MAX_TOP_K } from "../../discovery/index.ts";
import {
  buildInjectionBlock,
  clampTopK,
  createDiscoveryServices,
  DEFAULT_MODE,
  runSearchTool,
  type DiscoveryOutcome,
  type RegisterOptions,
  type ShadowResult,
} from "./core.ts";

export type { AdapterMode, RegisterOptions, ShadowResult } from "./core.ts";
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
  const services = createDiscoveryServices({ topK });
  const onShadow = options.onShadow;
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

    if (mode === "shadow") {
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

    // inject：在原 systemPrompt 后追加有界候选块。
    return { systemPrompt: `${event.systemPrompt}\n\n${buildInjectionBlock(outcome.candidates, topK)}` };
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
        return runSearchTool(services.state, params);
      },
    }),
  );
}
