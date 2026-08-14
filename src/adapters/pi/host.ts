/**
 * 纯 core 层使用的宿主窄接口（结构化的最小子集，逐字段核对真实类型）。
 *
 * 注：宿主注册层（src/adapters/pi/index.ts 与 .pi 入口）已直接使用真实类型
 * `import type { ExtensionAPI, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent"`
 * 与真实 `defineTool` / `Type`，并被 `npm run typecheck` 覆盖（tsconfig 已开 skipLibCheck、
 * include 含 .pi）。此处窄接口仅服务于 core 纯逻辑层，避免其耦合宿主全量类型图。
 *
 * 字段来源（本机安装包 0.84.1，逐条核对）：
 * - Skill：dist/core/skills.d.ts:9（name/description/filePath/baseDir/sourceInfo/disableModelInvocation）
 * - SourceScope：dist/core/source-info.d.ts:2（"user" | "project" | "temporary"）
 * - AgentToolResult：node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:316
 *   （content: (TextContent | ImageContent)[]; details: T）
 */

/** 宿主 Skill.sourceInfo.scope（source-info.d.ts:2）。 */
export type HostScope = "user" | "project" | "temporary";

/** 宿主 Skill 的结构化子集（skills.d.ts:9）。 */
export interface HostSkillLike {
  name: string;
  description: string;
  /** SKILL.md 绝对路径。 */
  filePath: string;
  /** skill 根目录绝对路径。 */
  baseDir: string;
  sourceInfo: { scope: HostScope };
  disableModelInvocation: boolean;
}

/** 工具 execute 的返回形状（AgentToolResult 的结构化子集，pi-agent-core types.d.ts:316）。 */
export interface HostToolResultLike {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

/**
 * 兼容导出（仅供测试桩）：宿主 ExtensionAPI 的结构化窄接口。
 * 生产注册层直接使用真实 `ExtensionAPI`（见 index.ts，tsc 全覆盖）；此接口仅用于
 * 外部测试（如 evaluation/phase1/adapter-integration.test.ts）构造宿主替身。
 */
export interface HostExtensionApiLike {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  registerTool(tool: unknown): void;
}

/** 兼容导出（仅供测试桩）：宿主 BeforeAgentStartEvent 的结构化窄接口。 */
export interface HostBeforeAgentStartEventLike {
  prompt: string;
  systemPrompt: string;
  systemPromptOptions: { skills?: HostSkillLike[] };
}
