/**
 * src/adapters/pi/index.ts（registerSkillCortex）测试。
 *
 * 覆盖：默认 shadow（不修改 systemPrompt、onShadow 收到有界候选且不含完整用户 prompt）、
 * inject Top-K（追加明确边界卡块、不出现全量）、Registry/Index 失败 fail-open（不注入、
 * onError 收到原始 error、不阻断）、search_skills（真实 defineTool+Type 工具：schema 边界、
 * 未初始化/构建失败脱敏诊断、有界搜索、敏感路径不泄漏）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import { registerSkillCortex } from "./index.ts";
import type { HostSkillLike } from "./host.ts";
import type { ShadowResult } from "./core.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-adapter-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeSkill(name: string): HostSkillLike {
  const root = makeTempDir();
  writeFileSync(path.join(root, "SKILL.md"), `# ${name}\n\ndefault body\n`);
  return {
    name,
    description: `Creates and reads Word docx files, variant of ${name}.`,
    filePath: path.join(root, "SKILL.md"),
    baseDir: root,
    sourceInfo: { scope: "user" },
    disableModelInvocation: false,
  };
}

function makeDocxFamily(count: number): HostSkillLike[] {
  return Array.from({ length: count }, (_, i) => makeSkill(`docx-${String.fromCharCode(97 + i)}`));
}

/** 提取文本中出现的 docx-* 名字（去重）；顺序无关断言用。 */
function extractedNames(text: string): string[] {
  return [...new Set(text.match(/docx-[a-l]/g) ?? [])];
}

interface FakePi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  registerTool(tool: ToolDefinition): void;
  _handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  _tools: ToolDefinition[];
}

function createFakePi(): FakePi {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools: ToolDefinition[] = [];
  return {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    _handlers: handlers,
    _tools: tools,
  };
}

function agentStartEvent(prompt: string, systemPrompt: string, skills: HostSkillLike[]): unknown {
  return { prompt, systemPrompt, systemPromptOptions: { skills } };
}

/** 断言辅助：工具结果 content 提取纯文本。 */
function toolText(result: { content: readonly (TextContent | ImageContent)[] }): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** 断言辅助：工具结果 details 具象化。 */
interface ToolDetails {
  ready: boolean;
  category?: string;
  query?: string;
  count?: number;
  matches: unknown[];
}

function detailsOf(result: { details: unknown }): ToolDetails {
  return result.details as ToolDetails;
}

/** 断言辅助：真实 TypeBox 构造的 parameters 形状。 */
interface SearchParamsSchema {
  type: "object";
  properties: {
    query: { type: "string"; minLength: number };
    limit: { type: "integer"; minimum: number; maximum: number };
  };
  required: string[];
}

describe("registerSkillCortex", () => {
  it("默认 shadow：注册 before_agent_start 与 search_skills；不修改 systemPrompt；onShadow 收到有界候选且不含完整 prompt", async () => {
    const pi = createFakePi();
    const shadows: ShadowResult[] = [];
    registerSkillCortex(pi as unknown as ExtensionAPI, { onShadow: (result) => shadows.push(result) });

    const handler = pi._handlers.get("before_agent_start");
    assert.ok(handler && handler.length === 1);
    const toolNames = pi._tools.map((t) => t.name);
    assert.deepEqual(toolNames, ["search_skills"]);

    const basePrompt = "base system prompt";
    const result = await handler![0]!(agentStartEvent("docx report", basePrompt, makeDocxFamily(8)), undefined);
    assert.equal(result, undefined, "shadow 必须不修改 systemPrompt");

    assert.equal(shadows.length, 1);
    assert.equal(shadows[0]!.recordCount, 8);
    assert.ok(shadows[0]!.candidates.length <= 5, "shadow 候选必须 ≤ 默认 topK=5");
    assert.match(shadows[0]!.cardText, /选择说明/);
    assert.ok(
      !("prompt" in shadows[0]!),
      "ShadowResult 不得暴露完整用户 prompt",
    );
  });

  it("inject：在原 systemPrompt 后追加有界 Top-K 卡块；绝不出现全量", async () => {
    const pi = createFakePi();
    registerSkillCortex(pi as unknown as ExtensionAPI, { mode: "inject", topK: 3 });
    const handler = pi._handlers.get("before_agent_start")![0]!;
    const basePrompt = "base system prompt";
    const skills = makeDocxFamily(12);

    const result = (await handler(agentStartEvent("docx", basePrompt, skills), undefined)) as {
      systemPrompt: string;
    };
    assert.ok(result.systemPrompt.startsWith(basePrompt), "必须追加在原始 systemPrompt 之后");
    assert.match(result.systemPrompt, /## Skill Cortex：prompt 外候选（有界 Top-K）/);
    assert.match(result.systemPrompt, /≤ 3/);
    assert.match(result.systemPrompt, /No-skill/);
    // 顺序无关：注入的候选名必须 ≤ topK（有界）且 < 全量 12（绝不注入完整 catalog）
    const shown = extractedNames(result.systemPrompt);
    assert.ok(shown.length >= 1 && shown.length <= 3, `注入必须是有界 Top-K，实际 ${shown.length}`);
    assert.ok(shown.length < skills.length, "注入的候选数量必须小于全量 catalog");
  });

  it("fail-open：Registry/Index 错误 ⇒ 不注入、systemPrompt 不变、onError 收到原始 error、不阻断", async () => {
    const pi = createFakePi();
    const errors: unknown[] = [];
    registerSkillCortex(pi as unknown as ExtensionAPI, {
      mode: "inject",
      onError: (error, context) => {
        errors.push({ error, context });
      },
    });
    const handler = pi._handlers.get("before_agent_start")![0]!;

    // 非法 skill：无 SKILL.md ⇒ Registry 拒绝
    const badRoot = makeTempDir();
    const bad: HostSkillLike = {
      name: "broken",
      description: "broken skill",
      filePath: path.join(badRoot, "SKILL.md"),
      baseDir: badRoot,
      sourceInfo: { scope: "user" },
      disableModelInvocation: false,
    };
    const basePrompt = "base system prompt";
    const result = await handler(agentStartEvent("anything", basePrompt, [bad]), undefined);
    assert.equal(result, undefined, "fail-open：不得注入");
    assert.equal(errors.length, 1);
    assert.deepEqual((errors[0] as { context: unknown }).context, { phase: "ingest" });
    assert.ok(
      (errors[0] as { error: Error }).error instanceof Error,
      "onError 必须收到原始 error（仅本地处理，不持久化/不注入）",
    );
  });

  it("fail-open 后 search_skills 给出脱敏诊断（稳定类别，不泄漏敏感绝对路径）", async () => {
    const pi = createFakePi();
    registerSkillCortex(pi as unknown as ExtensionAPI);
    const handler = pi._handlers.get("before_agent_start")![0]!;

    const sensitiveDir = path.join(PROJECT_ROOT, ".secret-victim", "docx");
    const bad: HostSkillLike = {
      name: "broken",
      description: "broken skill",
      filePath: path.join(sensitiveDir, "SKILL.md"),
      baseDir: sensitiveDir,
      sourceInfo: { scope: "user" },
      disableModelInvocation: false,
    };
    await handler(agentStartEvent("anything", "base", [bad]), undefined);

    const tool = pi._tools[0]!;
    const result = await tool.execute("id", { query: "docx" }, undefined, undefined, {} as unknown as ExtensionContext);
    const details = detailsOf(result);
    assert.equal(details.ready, false);
    assert.equal(details.category, "skill_ingest_failed");
    const text = toolText(result);
    assert.match(text, /skill_ingest_failed/);
    assert.ok(!text.includes(".secret-victim"), "content 不得泄漏敏感绝对路径");
    assert.ok(!text.includes("SKILL.md"), "content 不得泄漏文件名");
    assert.ok(!text.includes("Desktop"), "content 不得泄漏目录结构");
    assert.ok(!text.includes("broken"), "content 不得泄漏原始错误文本");
  });

  it("未初始化（从未触发 before_agent_start）时 search_skills 给出未初始化诊断", async () => {
    const pi = createFakePi();
    registerSkillCortex(pi as unknown as ExtensionAPI);
    const tool = pi._tools[0]!;
    const result = await tool.execute("id", { query: "docx" }, undefined, undefined, {} as unknown as ExtensionContext);
    assert.equal(detailsOf(result).ready, false);
    assert.match(toolText(result), /尚未初始化/);
  });

  it("正常：search_skills 候选有界（limit 边界）、空查询返回空", async () => {
    const pi = createFakePi();
    registerSkillCortex(pi as unknown as ExtensionAPI, { topK: 10 });
    const handler = pi._handlers.get("before_agent_start")![0]!;
    await handler(agentStartEvent("docx", "base", makeDocxFamily(6)), undefined);

    const tool = pi._tools[0]!;
    const r1 = await tool.execute("id", { query: "docx", limit: 100 }, undefined, undefined, {} as unknown as ExtensionContext);
    assert.equal(detailsOf(r1).ready, true);
    assert.ok(detailsOf(r1).matches.length <= 10, "limit 超界被 clamp 到 MAX_TOP_K");
    const r2 = await tool.execute("id", { query: "docx", limit: 2 }, undefined, undefined, {} as unknown as ExtensionContext);
    assert.ok(detailsOf(r2).matches.length <= 2);
    const r3 = await tool.execute("id", { query: "   " }, undefined, undefined, {} as unknown as ExtensionContext);
    assert.equal(detailsOf(r3).count, 0);
  });

  it("search_skills 工具定义：真实 TypeBox schema（query minLength=1，limit 1..10），promptSnippet 不宣称 path", () => {
    const pi = createFakePi();
    registerSkillCortex(pi as unknown as ExtensionAPI);
    const tool = pi._tools[0]!;
    assert.equal(tool.name, "search_skills");
    assert.equal(tool.promptSnippet, "Search loaded skills by name, description, and alias");
    assert.ok(!tool.promptSnippet.includes("path"), "promptSnippet 不得宣称按 path 搜索");
    const schema = tool.parameters as unknown as SearchParamsSchema;
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["query"]);
    assert.equal(schema.properties.query.minLength, 1);
    assert.equal(schema.properties.limit.minimum, 1);
    assert.equal(schema.properties.limit.maximum, 10);
  });

  it("disableModelInvocation 过滤：禁用 Skill 不进候选（shadow 可见 recordCount 不含它）", async () => {
    const pi = createFakePi();
    const shadows: ShadowResult[] = [];
    registerSkillCortex(pi as unknown as ExtensionAPI, { onShadow: (result) => shadows.push(result) });
    const handler = pi._handlers.get("before_agent_start")![0]!;

    const family = makeDocxFamily(4);
    family[1]!.disableModelInvocation = true; // docx-b 禁用
    await handler(agentStartEvent("docx", "base", family), undefined);

    assert.equal(shadows[0]!.recordCount, 3);
    assert.ok(!shadows[0]!.candidates.some((c) => c.name === "docx-b"));
  });

  it("topK 边界：非法 topK 被 clamp，不影响注册", async () => {
    const pi = createFakePi();
    registerSkillCortex(pi as unknown as ExtensionAPI, { mode: "inject", topK: 999 });
    const handler = pi._handlers.get("before_agent_start")![0]!;
    const result = (await handler(agentStartEvent("docx", "base", makeDocxFamily(20)), undefined)) as {
      systemPrompt: string;
    };
    assert.match(result.systemPrompt, /≤ 10/);
  });
});
