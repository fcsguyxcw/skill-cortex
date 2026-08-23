/**
 * Phase 1 adapter — black-box integration & safety acceptance tests.
 *
 * Tests `registerSkillCortex` (now bound to the real `ExtensionAPI` type) against
 * a fake host that captures the `before_agent_start` handler and the
 * `search_skills` tool. The fake is cast to `ExtensionAPI` via `as unknown as
 * ExtensionAPI` at each call boundary (no `any`, no `ts-ignore`); production
 * signatures are never modified.
 *
 * All Skill packages are project-local fixtures created under this test's
 * directory and cleaned up afterward; nothing touches the user's real skill
 * environment.
 *
 * Safety focus:
 * - shadow mode never mutates systemPrompt, still captures bounded candidates,
 *   and its ShadowResult never exposes the raw user prompt;
 * - inject mode injects only the bounded Top-K cards (full description of the
 *   selected candidates + single/multi/no-skill instructions), never the whole
 *   catalog and never unselected descriptions;
 * - disabled skills are not ingested;
 * - search_skills is bounded, returns empty on no-match (not the full catalog),
 *   and gives a bounded diagnostic before initialization;
 * - invalid path / Registry failure fails open: no prompt mutation, no throw to
 *   the host, error surfaced via onError; the model-visible diagnostic never
 *   leaks the broken skill's absolute path;
 * - the adapter production wiring uses the real ExtensionAPI + defineTool +
 *   Type.Object and performs no Router LLM / appendEntry / PracticeEvent writes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
// 真实 prompt 构建路径：buildSystemPrompt 未从包顶层 export（exports map 仅 "." /
// "./rpc-entry" / "./client"），改用项目 node_modules 内已验证 dist 文件的相对文件 URL。
// 仅测试使用；生产 adapter 不依赖此内部路径。
import { buildSystemPrompt } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import { registerSkillCortex } from "../../adapters/pi/index.ts";
import type { ShadowResult } from "../../adapters/pi/index.ts";
import type { HostSkillLike, HostToolResultLike } from "../../adapters/pi/host.ts";

const PHASE1_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Minimal host stand-in. Cast to `ExtensionAPI` at the call boundary. */
class FakePi {
  readonly handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  readonly tools: unknown[] = [];

  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerTool(tool: unknown): void {
    this.tools.push(tool);
  }
}

async function emit(pi: FakePi, event: unknown): Promise<unknown> {
  const handlers = pi.handlers.get("before_agent_start") ?? [];
  assert.equal(handlers.length, 1, "expected exactly one before_agent_start handler");
  return Promise.resolve(handlers[0]!(event, undefined));
}

interface SearchToolLike {
  name: string;
  promptSnippet?: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<HostToolResultLike>;
}

function getSearchTool(pi: FakePi): SearchToolLike {
  const tool = pi.tools.find((t) => (t as { name?: string }).name === "search_skills");
  assert.ok(tool, "search_skills tool not registered");
  return tool as SearchToolLike;
}

function getLoadTool(pi: FakePi): SearchToolLike {
  const tool = pi.tools.find((t) => (t as { name?: string }).name === "load_skill");
  assert.ok(tool, "load_skill tool not registered");
  return tool as SearchToolLike;
}

interface SearchDetails {
  ready: boolean;
  category?: string;
  count?: number;
  query?: string;
  matches: unknown[];
}

function detailsOf(result: HostToolResultLike): SearchDetails {
  return result.details as SearchDetails;
}

interface LoadDetails {
  ready: boolean;
  category?: string;
  name?: string;
  scope?: string;
}

function loadDetailsOf(result: HostToolResultLike): LoadDetails {
  return result.details as LoadDetails;
}

function resultText(result: HostToolResultLike): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

function makeEvent(prompt: string, skills: HostSkillLike[], systemPrompt = "BASE_SYSTEM_PROMPT") {
  return { prompt, systemPrompt, systemPromptOptions: { skills } };
}

/** 用真实 buildSystemPrompt 构造含全量 catalog 的 base system prompt（Pi 原生路径）。 */
function buildNativePrompt(cwd: string, skills: HostSkillLike[]): string {
  return buildSystemPrompt({
    cwd,
    skills: skills as unknown as Skill[],
    contextFiles: [{ path: "CLAUDE.md", content: "PROJECT_RULE_MARKER" }],
  });
}

async function makePackage(
  root: string,
  name: string,
  description: string,
  opts: { disable?: boolean } = {},
): Promise<HostSkillLike> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `# ${name}\n\n${description}\n`, "utf8");
  return {
    name,
    description,
    filePath: path.join(dir, "SKILL.md"),
    baseDir: dir,
    sourceInfo: { scope: "user" },
    disableModelInvocation: opts.disable ?? false,
  };
}

describe("Phase 1 adapter integration/safety (black-box)", () => {
  let root: string;
  let pdf: HostSkillLike;
  let docx: HostSkillLike;
  let chart: HostSkillLike;
  let codeReview: HostSkillLike;
  let disabled: HostSkillLike;

  before(async () => {
    root = await mkdtemp(path.join(PHASE1_DIR, ".adapter-fixtures-"));
    pdf = await makePackage(root, "pdf", "Read and merge PDF documents.");
    docx = await makePackage(root, "docx", "Create Word documents with formatting.");
    chart = await makePackage(root, "chart-visualization", "Generate charts and data visualizations.");
    codeReview = await makePackage(root, "code-review", "Review code changes for bugs.");
    disabled = await makePackage(root, "internal-admin", "Run destructive admin operations.", {
      disable: true,
    });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("shadow: bounded candidates, no systemPrompt change, no raw prompt in ShadowResult", async () => {
    const pi = new FakePi();
    const shadows: ShadowResult[] = [];
    registerSkillCortex(pi as unknown as ExtensionAPI, {
      mode: "shadow",
      topK: 5,
      onShadow: (r) => shadows.push(r),
    });

    const result = await emit(pi, makeEvent("merge PDF files", [pdf, docx, chart, codeReview, disabled]));

    assert.equal(result, undefined, "shadow mode must not modify systemPrompt");
    assert.equal(shadows.length, 1);
    const shadow = shadows[0]!;
    assert.ok(shadow.candidateCount <= 5);
    assert.ok(!("prompt" in shadow), "ShadowResult must not expose the raw user prompt");
    assert.deepEqual(shadow.candidates.map((c) => c.name), ["pdf"]);
    assert.ok(shadow.cardText.includes("Read and merge PDF documents."));
  });

  it("inject: removes Pi native full-catalog block; final prompt keeps only bounded Top-K (no unselected name/description/location)", async () => {
    const pi = new FakePi();
    registerSkillCortex(pi as unknown as ExtensionAPI, { mode: "inject", topK: 5 });

    const skills = [pdf, docx, chart, codeReview, disabled];
    const result = await emit(
      pi,
      makeEvent("merge PDF files", skills, buildNativePrompt(root, skills)),
    );

    assert.ok(result && typeof result === "object", "inject must return a result object");
    const injected = (result as { systemPrompt?: string }).systemPrompt;
    assert.equal(typeof injected, "string");

    // 原生全量 catalog block（含全部可见 Skill 的 name/description/location）必须被完整移除。
    assert.ok(
      !injected!.includes(formatSkillsForPrompt(skills as unknown as Skill[])),
      "full native catalog block must be removed",
    );

    // 选中的 pdf：完整描述出现在候选卡中。
    assert.ok(injected!.includes("Read and merge PDF documents."), "selected skill description present");

    // 未选中 Skill 的 name / description / location 均不得出现。
    for (const unselected of [docx, chart, codeReview]) {
      assert.ok(!injected!.includes(`<name>${unselected.name}</name>`), `${unselected.name} name must be absent`);
      assert.ok(!injected!.includes(unselected.description), `${unselected.name} description must be absent`);
      assert.ok(!injected!.includes(unselected.filePath), `${unselected.name} location must be absent`);
    }
    // 禁用 Skill 既不进原生 block，也不进候选。
    assert.ok(!injected!.includes("Run destructive admin operations."), "disabled skill description must be absent");

    // 保留 project context 与 CWD（移除必须外科式，不得误删非 skills 内容）。
    assert.ok(injected!.includes("PROJECT_RULE_MARKER"), "project context preserved");
    assert.ok(injected!.includes("Current working directory:"), "CWD line preserved");

    // 选择说明仍在。
    assert.ok(injected!.includes("Single skill"));
    assert.ok(injected!.includes("Multi-skill"));
    assert.ok(injected!.includes("No-skill"));
  });

  it("inject prompt_rewrite failure (native block not found) fails open: no injection, no candidate block", async () => {
    const pi = new FakePi();
    const errors: Array<{ error: unknown; context: { phase: string } }> = [];
    registerSkillCortex(pi as unknown as ExtensionAPI, {
      mode: "inject",
      onError: (error, context) => errors.push({ error, context }),
    });

    // 模拟 buildSystemPrompt 未嵌入 skills 的路径（如 read 工具不可用）：base prompt 不含原生 block。
    const result = await emit(pi, makeEvent("merge PDF files", [pdf, docx], "You are an expert coding assistant."));

    assert.equal(result, undefined, "prompt_rewrite 失败必须 fail open：不注入、不追加、保留原生慢路径");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.context.phase, "prompt_rewrite");
    assert.ok(errors[0]!.error instanceof Error);
  });

  it("inject prompt_rewrite failure (native block non-unique) fails open: no injection, no candidate block", async () => {
    const pi = new FakePi();
    const errors: Array<{ error: unknown; context: { phase: string } }> = [];
    registerSkillCortex(pi as unknown as ExtensionAPI, {
      mode: "inject",
      onError: (error, context) => errors.push({ error, context }),
    });

    // 原生 block 出现两次：无法唯一定位，必须 fail open，绝不返回“全量 + Top-K”。
    const skills = [pdf, docx];
    const block = formatSkillsForPrompt(skills as unknown as Skill[]);
    const duplicatedPrompt = `prefix\n${block}\nsuffix\n${block}`;

    const result = await emit(pi, makeEvent("merge PDF files", skills, duplicatedPrompt));

    assert.equal(result, undefined, "非唯一原生 block 必须 fail open：不注入、不追加");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.context.phase, "prompt_rewrite");
    assert.ok(errors[0]!.error instanceof Error);
  });

  it("inject with empty skills: no native block to remove, emits no-skill guidance only", async () => {
    const pi = new FakePi();
    registerSkillCortex(pi as unknown as ExtensionAPI, { mode: "inject", topK: 5 });

    const result = await emit(pi, makeEvent("anything", [], buildNativePrompt(root, [])));

    assert.ok(result && typeof result === "object", "inject must return a result object");
    const injected = (result as { systemPrompt?: string }).systemPrompt;
    assert.equal(typeof injected, "string");
    assert.match(injected!, /no matching skills/);
    assert.match(injected!, /No-skill/);
    // 空 skills 无任何 Skill 元数据可泄漏。
    assert.ok(!injected!.includes("<available_skills>"), "no native block when no skills");
  });

  it("disabled skill is not ingested into candidates", async () => {
    const pi = new FakePi();
    const shadows: ShadowResult[] = [];
    registerSkillCortex(pi as unknown as ExtensionAPI, { mode: "shadow", onShadow: (r) => shadows.push(r) });

    await emit(pi, makeEvent("run destructive admin operations", [pdf, disabled]));

    assert.equal(shadows.length, 1);
    assert.equal(shadows[0]!.recordCount, 1, "only the enabled pdf skill should be ingested");
    assert.ok(!shadows[0]!.candidates.some((c) => c.name === "internal-admin"));
  });

  it("search_skills: bounded, no-match empty (not full catalog), diagnostic before init", async () => {
    const pi = new FakePi();
    registerSkillCortex(pi as unknown as ExtensionAPI, { topK: 3 });
    const tool = getSearchTool(pi);
    assert.equal(tool.name, "search_skills");

    const schema = tool.parameters as {
      required?: string[];
      properties?: Record<string, { maximum?: number }>;
    };
    assert.deepEqual(schema.required, ["query"]);
    assert.equal(schema.properties?.["limit"]?.maximum, 10);

    // Before initialization: bounded diagnostic, no candidates, no throw.
    const pre = await tool.execute("tcid", { query: "pdf" }, undefined, undefined, {});
    const preDetails = detailsOf(pre);
    assert.equal(preDetails.ready, false);
    assert.equal(preDetails.category, "not_initialized");
    assert.deepEqual(preDetails.matches, []);

    // Initialize with a valid catalog.
    await emit(pi, makeEvent("merge PDF files", [pdf, docx, chart, codeReview]));

    // Match: bounded to the requested limit.
    const hit = await tool.execute("tcid", { query: "pdf", limit: 1 }, undefined, undefined, {});
    const hitDetails = detailsOf(hit);
    assert.equal(hitDetails.ready, true);
    assert.equal(hitDetails.count, 1);
    assert.equal(hitDetails.matches.length, 1);
    assert.equal((hitDetails.matches[0] as { name: string }).name, "pdf");

    // No-match: empty, not the full catalog.
    const miss = await tool.execute("tcid", { query: "zzzqqq", limit: 10 }, undefined, undefined, {});
    const missDetails = detailsOf(miss);
    assert.equal(missDetails.ready, true);
    assert.equal(missDetails.count, 0);
    assert.deepEqual(missDetails.matches, []);
  });

  it("onDiscovery attribution: rewrite 失败不产出 route snapshot；成功注入才报告 exposedToAgent=true", async () => {
    // 失败路径（native block 缺失）：Main Agent 实际看不到 Top-K，不得留下可误归因快照。
    const pi = new FakePi();
    const snaps: Array<{ exposedToAgent?: boolean }> = [];
    const errors: Array<{ error: unknown; context: { phase: string } }> = [];
    registerSkillCortex(pi as unknown as ExtensionAPI, {
      mode: "inject",
      onDiscovery: (r) => snaps.push(r),
      onError: (error, context) => errors.push({ error, context }),
    });
    const result = await emit(pi, makeEvent("merge PDF files", [pdf, docx], "You are an expert coding assistant."));
    assert.equal(result, undefined, "rewrite 失败必须 fail open");
    assert.equal(snaps.length, 0, "rewrite 失败不得产出 onDiscovery 快照");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.context.phase, "prompt_rewrite");

    // 成功路径：最终 prompt 确定后报告 exposedToAgent=true / deliveryMode=inject。
    const pi2 = new FakePi();
    const snaps2: Array<{ exposedToAgent?: boolean; deliveryMode?: string }> = [];
    registerSkillCortex(pi2 as unknown as ExtensionAPI, {
      mode: "inject",
      topK: 3,
      onDiscovery: (r) => snaps2.push(r),
    });
    const skills = [pdf, docx, chart, codeReview];
    const okResult = await emit(pi2, makeEvent("merge PDF files", skills, buildNativePrompt(root, skills)));
    assert.ok(okResult && typeof okResult === "object", "inject 必须成功");
    assert.equal(snaps2.length, 1);
    assert.equal(snaps2[0]!.exposedToAgent, true);
    assert.equal(snaps2[0]!.deliveryMode, "inject");
  });

  it("load_skill: project-owned on-demand load — bounded, revision-checked, fail-closed", async () => {
    const pi = new FakePi();
    registerSkillCortex(pi as unknown as ExtensionAPI, { topK: 5 });

    const loadTool = getLoadTool(pi);
    const searchTool = getSearchTool(pi);

    // 摄入前：fail closed（not_initialized）。
    const pre = await loadTool.execute("tcid", { skill_id: "skill:x", skill_revision: "rev:y" }, undefined, undefined, {});
    assert.equal(loadDetailsOf(pre).category, "not_initialized");

    // 摄入（fake host before_agent_start，shadow 模式也会填充 catalog）。
    await emit(pi, makeEvent("merge PDF files", [pdf, docx, chart, codeReview]));

    // search_skills → skillId/skillRevision（候选卡同源）。
    const hit = await searchTool.execute("tcid", { query: "pdf", limit: 1 }, undefined, undefined, {});
    const match = detailsOf(hit).matches[0] as { skillId: string; skillRevision: string; name: string };
    assert.equal(match.name, "pdf");

    // 成功加载：正文 + 最小 provenance，不泄漏其它 catalog 条目/绝对路径。
    const ok = await loadTool.execute("tcid", { skill_id: match.skillId, skill_revision: match.skillRevision }, undefined, undefined, {});
    assert.equal(loadDetailsOf(ok).category, "ok");
    assert.equal(loadDetailsOf(ok).name, "pdf");
    assert.match(resultText(ok), /Read and merge PDF documents\./);
    assert.ok(!resultText(ok).includes("Create Word documents with formatting."), "不得泄漏其它 catalog 条目");

    // unknown id → fail closed。
    const unknown = await loadTool.execute("tcid", { skill_id: "skill:unknown", skill_revision: match.skillRevision }, undefined, undefined, {});
    assert.equal(loadDetailsOf(unknown).category, "unknown_skill");

    // revision mismatch → fail closed。
    const mismatch = await loadTool.execute("tcid", { skill_id: match.skillId, skill_revision: "rev:wrong" }, undefined, undefined, {});
    assert.equal(loadDetailsOf(mismatch).category, "revision_mismatch");
  });

  it("invalid path / Registry failure fails open: no prompt change, no throw, onError", async () => {
    const pi = new FakePi();
    const errors: Array<{ error: unknown; context: { phase: string } }> = [];
    registerSkillCortex(pi as unknown as ExtensionAPI, {
      mode: "inject",
      onError: (error, context) => errors.push({ error, context }),
    });

    const broken: HostSkillLike = {
      name: "broken",
      description: "broken skill",
      filePath: path.join(root, "no-such-dir", "SKILL.md"),
      baseDir: path.join(root, "no-such-dir"),
      sourceInfo: { scope: "user" },
      disableModelInvocation: false,
    };

    const result = await emit(pi, makeEvent("anything", [broken], "BASE_SYSTEM_PROMPT"));

    assert.equal(result, undefined, "failure must not inject or modify systemPrompt");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.context.phase, "ingest");
    assert.ok(errors[0]!.error instanceof Error);
  });

  it("failure diagnostic does not leak the broken skill's absolute path", async () => {
    const pi = new FakePi();
    registerSkillCortex(pi as unknown as ExtensionAPI);

    const brokenRoot = path.join(root, "no-such-dir");
    const broken: HostSkillLike = {
      name: "broken",
      description: "broken skill",
      filePath: path.join(brokenRoot, "SKILL.md"),
      baseDir: brokenRoot,
      sourceInfo: { scope: "user" },
      disableModelInvocation: false,
    };
    await emit(pi, makeEvent("anything", [broken]));

    const tool = getSearchTool(pi);
    const result = await tool.execute("tcid", { query: "docx" }, undefined, undefined, {});
    const details = detailsOf(result);
    assert.equal(details.ready, false);
    assert.equal(details.category, "skill_ingest_failed");

    const text = resultText(result);
    assert.ok(!text.includes(brokenRoot), "content must not leak the broken skill's absolute path");
    assert.ok(!text.includes("SKILL.md"), "content must not leak the file name");
    assert.ok(!text.includes("broken"), "content must not leak raw error text");
    assert.ok(
      !JSON.stringify(details).includes(brokenRoot),
      "details must not leak the broken skill's absolute path",
    );
  });

  it("production wiring uses real ExtensionAPI + defineTool + Type.Object, no appendEntry/LLM/PracticeEvent writes", () => {
    const indexSource = readFileSync(new URL("../../adapters/pi/index.ts", import.meta.url), "utf8");
    const coreSource = readFileSync(new URL("../../adapters/pi/core.ts", import.meta.url), "utf8");
    const production = `${indexSource}\n${coreSource}`;

    // Real host wiring (not a narrow interface).
    assert.match(indexSource, /@earendil-works\/pi-coding-agent/);
    assert.match(indexSource, /registerSkillCortex\(pi: ExtensionAPI/);
    assert.match(indexSource, /defineTool/);
    assert.match(indexSource, /Type\.Object/);

    // No Router LLM, no appendEntry, no PracticeEvent persistence, no file writes.
    const bannedCalls = [
      "appendEntry(",
      "sendMessage(",
      "sendUserMessage(",
      "callLLM(",
      "ModelRuntime(",
      ".complete(",
      "createAgentSession(",
      "new PracticeEvent",
      "writeFile(",
      "appendFile(",
      "createWriteStream(",
    ];
    for (const token of bannedCalls) {
      assert.equal(production.includes(token), false, `production adapter must not call ${token}`);
    }
  });
});
