/**
 * B3 host integration 证据（真实 Pi 0.84.1 extension runner 链上的 Practice observer）。
 *
 * 被断言路径全部为宿主真实实现：
 * - `loadExtensionFromFactory` + `ExtensionRunner`（dist/core/extensions/）：真实事件链；
 * - `SessionManager.inMemory()` 提供真实 ctx.sessionManager.getSessionId()；
 * - `loadSkillsFromDir`：解析真实 fixture SKILL.md；
 * - `buildSystemPrompt`（dist/core/system-prompt.js）：真实含原生全量 Skill catalog 的 base prompt；
 * - `registerSkillCortex` 的 phase12 seam：`onDiscovery` 回调（inject 成功才 exposedToAgent=true；
 *   shadow 恒 false）+ load_skill 成功 details 带真实 `source_hash`（返回前重验完整 revision）；
 * - `emitBeforeAgentStart` / `emitToolCall` / `emitToolResult` / `emit({type:"agent_settled"})`
 *   真实事件发射；observer 的 before_agent_start 在 cortex 之后执行（注册顺序）⇒ 同一次
 *   run 内 take 到 cortex push 的快照。
 *
 * 三条边界：
 * 1. seam 未接线（observer 无 routeSnapshotSource）⇒ 0 事件，onStatus 报告 unwired；
 * 2. 真实完整链路（inject + onDiscovery + 真实 load_skill）⇒ 1 个 provenance=real 事件，
 *    source_hash 绑定真实 SKILL.md 内容指纹，policy 通过，store round-trip；
 * 3. shadow 模式（候选未暴露给 Main Agent）⇒ observer fail-closed，0 事件。
 *
 * 约束：不写用户 .pi、不调用外部模型、不修改 production 逻辑。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  createEventBus,
  loadSkillsFromDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionFactory,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
  ExtensionRunner,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import { buildSystemPrompt } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import { computeSourceHash } from "../../core/registry/index.ts";
import { validatePracticeEvent } from "../../practice/policy/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import { registerSkillCortex } from "../../adapters/pi/index.ts";
import {
  createDiscoverySnapshotSource,
  registerPracticeObserver,
  type ObserverStatus,
} from "../../adapters/pi/practice-observer.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeFixtureProject(): { root: string; skills: Skill[] } {
  const root = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-observer-host-"));
  tempDirs.push(root);
  const names = ["docx-a", "docx-b", "pdf"];
  for (const name of names) {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${
        name === "pdf"
          ? "Read and merge PDF documents."
          : `Creates and reads Word docx files, variant ${name}.`
      }\n---\n\n# ${name}\n\nbody\n`,
    );
  }
  const { skills } = loadSkillsFromDir({ dir: root, source: "user" });
  assert.equal(skills.length, 3, "fixture 必须解析出 3 个真实 Skill");
  return { root, skills };
}

async function makeRunner(options: {
  cortexMode: "inject" | "shadow";
  buildObserver: (
    pi: Parameters<ExtensionFactory>[0],
    project: { root: string; skills: Skill[]; source: ReturnType<typeof createDiscoverySnapshotSource> },
  ) => void;
}): Promise<{ runner: ExtensionRunner; projectRoot: string; skills: Skill[]; basePrompt: string }> {
  const { root, skills } = makeFixtureProject();
  const source = createDiscoverySnapshotSource();
  // 真实部署形态：cortex 先注册（onDiscovery → source.push），observer 后注册。
  const factories: ExtensionFactory[] = [
    (pi) => registerSkillCortex(pi, { mode: options.cortexMode, onDiscovery: (r) => source.push(r) }),
    (pi) => options.buildObserver(pi, { root, skills, source }),
  ];
  const runtime = createExtensionRuntime();
  const extensions: Awaited<ReturnType<typeof loadExtensionFromFactory>>[] = [];
  for (const factory of factories) {
    extensions.push(
      await loadExtensionFromFactory(factory, root, createEventBus(), runtime, "<observer-test>"),
    );
  }
  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
    modelsPath: null,
    authPath: path.join(root, "auth.json"),
  });
  const sessionManager = SessionManager.inMemory(root);
  const runner = new ExtensionRunner(
    extensions,
    runtime,
    root,
    sessionManager,
    new ModelRegistry(modelRuntime),
  );
  const basePrompt = buildSystemPrompt({
    cwd: root,
    skills,
    contextFiles: [{ path: "AGENTS.md", content: "project context" }],
  });
  assert.ok(basePrompt.includes("<available_skills>"), "basePrompt 必须含原生全量 Skill block");
  return { runner, projectRoot: root, skills, basePrompt };
}

function promptOptions(
  root: string,
  skills: Skill[],
): Parameters<ExtensionRunner["emitBeforeAgentStart"]>[3] {
  return { cwd: root, skills, contextFiles: [] };
}

/** 真实执行 search_skills + load_skill，返回真实 pdf 身份与 load details。 */
async function realPdfLoad(
  runner: ExtensionRunner,
): Promise<{ skillId: string; skillRevision: string; details: Record<string, unknown> }> {
  const searchDef = runner.getToolDefinition("search_skills");
  const loadDef = runner.getToolDefinition("load_skill");
  assert.ok(searchDef, "search_skills 工具定义必须存在");
  assert.ok(loadDef, "load_skill 工具定义必须存在");
  const ctx = runner.createContext();
  const searchResult = await searchDef.execute("tid", { query: "pdf", limit: 1 }, undefined, undefined, ctx);
  const matches = (searchResult.details as {
    matches: Array<{ skillId: string; skillRevision: string }>;
  }).matches;
  assert.equal(matches.length, 1);
  const { skillId, skillRevision } = matches[0]!;
  const loadResult = await loadDef.execute(
    "tcid",
    { skill_id: skillId, skill_revision: skillRevision },
    undefined,
    undefined,
    ctx,
  );
  return { skillId, skillRevision, details: loadResult.details as Record<string, unknown> };
}

/** 真实事件序列：一次 prompt run（inject）→ 真实 load_skill 选中 → settled。 */
async function runRealSelection(
  runner: ExtensionRunner,
  projectRoot: string,
  skills: Skill[],
  basePrompt: string,
): Promise<{ skillId: string; skillRevision: string; details: Record<string, unknown> }> {
  // Run 0（预摄入）：cortex ingest，得到真实 pdf identity；observer 无快照 ⇒ unwired（不落盘）。
  await runner.emitBeforeAgentStart(
    "merge PDF documents",
    undefined,
    basePrompt,
    promptOptions(projectRoot, skills),
  );
  const pdf = await realPdfLoad(runner);
  assert.equal(pdf.details.category, "ok");
  assert.ok(
    typeof pdf.details.source_hash === "string" && /^(?:sha256:)?[0-9a-f]{64}$/.test(pdf.details.source_hash),
    "phase12 后的 load_skill details 必须带严格 sha256 source_hash",
  );

  // Run 1：cortex inject 成功 ⇒ onDiscovery push（exposedToAgent=true）⇒ observer take；
  // 主 Agent 真实调用 load_skill 选中 pdf。
  await runner.emitBeforeAgentStart(
    "merge PDF documents",
    undefined,
    basePrompt,
    promptOptions(projectRoot, skills),
  );
  await runner.emitToolCall({
    type: "tool_call",
    toolCallId: "tc1",
    toolName: "load_skill",
    input: { skill_id: pdf.skillId, skill_revision: pdf.skillRevision },
  });
  await runner.emitToolResult({
    type: "tool_result",
    toolCallId: "tc1",
    toolName: "load_skill",
    input: { skill_id: pdf.skillId },
    content: [{ type: "text", text: "ok" }],
    isError: false,
    details: pdf.details,
  });
  await runner.emitToolCall({ type: "tool_call", toolCallId: "tc2", toolName: "read", input: {} });
  await runner.emitToolResult({
    type: "tool_result",
    toolCallId: "tc2",
    toolName: "read",
    input: {},
    content: [{ type: "text", text: "ok" }],
    isError: false,
    details: undefined,
  });
  await runner.emit({ type: "agent_settled" });
  return pdf;
}

describe("B3 observer host integration（真实 0.84.1 extension runner 链）", () => {
  it("seam 未接线（observer 无 routeSnapshotSource）⇒ 0 事件，onStatus 报告 unwired", async () => {
    const events: PracticeEvent[] = [];
    const statuses: ObserverStatus[] = [];
    let store!: PracticeStore;
    const { runner, projectRoot, skills, basePrompt } = await makeRunner({
      cortexMode: "inject",
      buildObserver: (pi, project) => {
        store = new PracticeStore({
          rootDir: path.join(project.root, ".skill-cortex", "practice"),
          projectRoot: project.root,
        });
        registerPracticeObserver(pi, {
          store,
          projectRoot: project.root,
          onEvent: (e) => events.push(e),
          onStatus: (s) => statuses.push(s),
        });
      },
    });
    await runRealSelection(runner, projectRoot, skills, basePrompt);
    assert.equal(events.length, 0);
    assert.ok(statuses.some((s) => s.wired === false), "必须报告 unwired 状态");
    assert.equal(events.length, 0, "无 seam 不落盘");
  });

  it("真实完整链路（inject + onDiscovery + 真实 load_skill）⇒ 1 个 real 事件，source_hash 绑定真实指纹", async () => {
    const events: PracticeEvent[] = [];
    const statuses: ObserverStatus[] = [];
    let store!: PracticeStore;
    const { runner, projectRoot, skills, basePrompt } = await makeRunner({
      cortexMode: "inject",
      buildObserver: (pi, project) => {
        store = new PracticeStore({
          rootDir: path.join(project.root, ".skill-cortex", "practice"),
          projectRoot: project.root,
        });
        registerPracticeObserver(pi, {
          store,
          projectRoot: project.root,
          routeSnapshotSource: project.source,
          onEvent: (e) => events.push(e),
          onStatus: (s) => statuses.push(s),
        });
      },
    });

    const pdf = await runRealSelection(runner, projectRoot, skills, basePrompt);
    const mdBytes = await readFile(path.join(projectRoot, "pdf", "SKILL.md"));
    const expectedSourceHash = computeSourceHash(mdBytes);
    assert.equal(pdf.details.source_hash, expectedSourceHash, "真实 load details 必须是 SKILL.md 内容指纹");

    assert.equal(events.length, 1, "真实链必须产生 1 个事件");
    const event = events[0]!;
    assert.equal(event.provenance, "real");
    assert.equal(event.executionMode, "skill_md");
    assert.equal(event.sensitivity, "none");
    assert.equal(event.retentionClass, "project_manual");
    assert.equal(event.parentSkillId, pdf.skillId);
    assert.equal(event.parentSkillRevision, pdf.skillRevision);
    assert.equal(event.sourceHash, expectedSourceHash);
    assert.equal(event.attribution, "unknown", "无 verifier 不得产生 verified_skill_effect");
    assert.deepEqual(event.selectedSkillIds, [pdf.skillId]);
    assert.ok(event.candidateSkillIds.includes(pdf.skillId), "候选必须来自当次真实 discovery 快照");
    assert.ok(event.candidateSkillIds.length <= 5, "候选必须是有界 Top-K");
    assert.equal(event.stepSummaries.length, 2);
    assert.equal(event.stepSummaries[0]!.operationClass, "tool:load_skill");
    assert.equal(event.stepSummaries[1]!.operationClass, "tool:read");
    assert.match(event.redactedTaskFeatures[0]!, /^prompt-hash:[0-9a-f]{32}$/);
    assert.equal(validatePracticeEvent(event).ok, true);

    const persisted = await store.getEvent(event.tenantScope, event.eventId);
    assert.deepEqual(persisted, event, "store round-trip 一致");
    assert.equal((await store.queryEvidence(event.tenantScope)).length, 1);
    assert.ok(event.tenantScope.startsWith("project:"), "tenantScope 必须是 project 前缀");
    // Run 0（unwired）必须无落盘，Run 1 有且仅有一个事件。
    const all = await store.listProvenance(event.tenantScope, "real");
    assert.equal(all.length, 1);
  });

  it("shadow 模式（候选未暴露给 Main Agent）⇒ observer fail-closed，0 事件", async () => {
    const events: PracticeEvent[] = [];
    const statuses: ObserverStatus[] = [];
    let store!: PracticeStore;
    const { runner, projectRoot, skills, basePrompt } = await makeRunner({
      cortexMode: "shadow",
      buildObserver: (pi, project) => {
        store = new PracticeStore({
          rootDir: path.join(project.root, ".skill-cortex", "practice"),
          projectRoot: project.root,
        });
        registerPracticeObserver(pi, {
          store,
          projectRoot: project.root,
          routeSnapshotSource: project.source,
          onEvent: (e) => events.push(e),
          onStatus: (s) => statuses.push(s),
        });
      },
    });

    // shadow 模式：cortex 报告 exposedToAgent=false，observer 不得产生 real 事件。
    await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      basePrompt,
      promptOptions(projectRoot, skills),
    );
    const pdf = await realPdfLoad(runner);
    await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "tc1",
      toolName: "load_skill",
      input: { skill_id: pdf.skillId, skill_revision: pdf.skillRevision },
    });
    await runner.emitToolResult({
      type: "tool_result",
      toolCallId: "tc1",
      toolName: "load_skill",
      input: { skill_id: pdf.skillId },
      content: [{ type: "text", text: "ok" }],
      isError: false,
      details: pdf.details,
    });
    await runner.emit({ type: "agent_settled" });

    assert.equal(events.length, 0, "shadow 候选不得生成 provenance=real 事件");
    assert.equal(statuses.at(-1)?.wired, false);
    assert.equal(statuses.at(-1)?.reason, "not_exposed_to_agent");
  });
});
