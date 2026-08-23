import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

import type { LearningControls } from "../../activation/learning-controls.ts";

function result(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

/** 注册显式用户控制；变更状态或删除记忆的工具只能在用户明确要求时调用。 */
export function registerLearningControls(pi: ExtensionAPI, controls: LearningControls): void {
  pi.registerTool(defineTool({
    name: "skill_memory_status",
    label: "Skill Memory Status",
    description: "查看项目内 Skill 学习开关及 Activation Memory 数量摘要。",
    promptSnippet: "Inspect Skill learning and memory status",
    promptGuidelines: ["Use when the user asks whether Skill learning or Activation Memory is enabled."],
    parameters: Type.Object({}),
    async execute() {
      const status = await controls.status();
      return result(JSON.stringify(status), status);
    },
  }));

  pi.registerTool(defineTool({
    name: "skill_memory_set_learning",
    label: "Pause or Resume Skill Learning",
    description: "持久化暂停或恢复项目内 Skill 学习；暂停不关闭静态发现，也不移除已有 active overlay。",
    promptSnippet: "Pause or resume Skill learning",
    promptGuidelines: ["Call only when the user explicitly asks to pause or resume Skill learning."],
    parameters: Type.Object({
      enabled: Type.Boolean({ description: "true 恢复学习；false 暂停学习" }),
    }),
    async execute(_toolCallId, params) {
      const state = await controls.setLearning(params.enabled);
      return result(state.learningEnabled ? "learning_resumed" : "learning_paused", state);
    },
  }));

  pi.registerTool(defineTool({
    name: "skill_memory_list",
    label: "List Skill Memory",
    description: "列出项目内 Activation Memory 的脱敏摘要；可按 parent skill_id 过滤。",
    promptSnippet: "List redacted Activation Memory summaries",
    promptGuidelines: ["Use when the user asks what Skill memories exist; do not infer raw task text from summaries."],
    parameters: Type.Object({
      skill_id: Type.Optional(Type.String({ minLength: 1, description: "可选 parent skill_id" })),
    }),
    async execute(_toolCallId, params) {
      const summaries = await controls.list({ skillId: params.skill_id });
      return result(JSON.stringify(summaries), { summaries });
    },
  }));

  pi.registerTool(defineTool({
    name: "skill_memory_forget",
    label: "Forget Skill Memory",
    description: "按 evidence_id 或 profile_id 遗忘项目内 Skill 记忆；必须且只能提供一个目标。",
    promptSnippet: "Forget one Skill memory evidence or profile",
    promptGuidelines: [
      "Call only when the user explicitly asks to forget a specific evidence_id or profile_id.",
      "Provide exactly one target. Evidence deletion cascades to dependent profiles; profile deletion creates a retired tombstone.",
    ],
    parameters: Type.Object({
      evidence_id: Type.Optional(Type.String({ minLength: 1, description: "要遗忘的 evidence id" })),
      profile_id: Type.Optional(Type.String({ minLength: 1, description: "要遗忘的 profile id" })),
    }),
    async execute(_toolCallId, params) {
      const outcome = await controls.forget({
        evidenceId: params.evidence_id,
        profileId: params.profile_id,
      });
      return result(JSON.stringify(outcome), outcome);
    },
  }));
}
