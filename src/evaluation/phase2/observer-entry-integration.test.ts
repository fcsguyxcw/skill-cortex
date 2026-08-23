/**
 * B3 入口集成测试：真实 loadExtensions([.pi entry]) + ExtensionRunner 验证生产入口。
 *
 * 与 observer-integration.test.ts（工厂注册）不同，本测试直接加载生产入口
 * `.pi/extensions/skill-cortex/index.ts`（真实 loader + jiti），验证入口确实按顺序连接：
 *
 *   registerSkillCortex({ mode: "inject", onDiscovery: push })
 *     → createDiscoverySnapshotSource
 *     → registerPracticeObserver({ store: <cwd>/.skill-cortex/practice, projectRoot: process.cwd() })
 *     → PracticeStore
 *
 * 断言：一次真实 run（before_agent_start + 真实 load_skill + agent_settled）在
 * `<fixture>/.skill-cortex/practice` 产生且仅产生 1 个 provenance=real 事件；
 * 该事件通过 Practice policy 校验，parent/revision/source 绑定真实 load details，
 * candidate 来自当次真实 discovery 快照，attribution=unknown（无 verifier）。
 *
 * 注意：入口用 process.cwd() 作为 projectRoot，本测试在 before 中 chdir 到隔离 fixture
 * 根目录，after 恢复并清理；node --test 每个测试文件独立进程，chdir 不影响其他文件。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createEventBus,
  loadSkillsFromDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  createExtensionRuntime,
  loadExtensions,
  ExtensionRunner,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import { buildSystemPrompt } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import { computeSourceHash } from "../../core/registry/index.ts";
import { validatePracticeEvent } from "../../practice/policy/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import { defaultTenantScope } from "../../adapters/pi/practice-observer.ts";
import { ExposureObservationStore } from "../../exposure/index.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SKILL_CORTEX_ENTRY = path.join(PROJECT_ROOT, ".pi", "extensions", "skill-cortex", "index.ts");

let fixtureRoot = "";
let originalCwd = "";
let tempDirs: string[] = [];

before(async () => {
  originalCwd = process.cwd();
  const root = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-observer-entry-"));
  tempDirs.push(root);
  fixtureRoot = root;
  for (const name of ["docx-a", "docx-b", "pdf"]) {
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
  // 生产入口以 process.cwd() 为 projectRoot，测试隔离到 fixture 根。
  process.chdir(root);
});

after(async () => {
  process.chdir(originalCwd);
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("B3 observer 生产入口集成（真实 loader 加载 .pi/extensions/skill-cortex）", () => {
  it("入口接线完整：初始与 bounded search fallback 均进入同 run exposed attribution", async () => {
    const { skills } = loadSkillsFromDir({ dir: fixtureRoot, source: "user" });
    assert.equal(skills.length, 3, "fixture 必须解析出 3 个真实 Skill");

    // 真实 loader（jiti）加载生产入口；errors 必须为空。
    const { extensions, errors, runtime } = await loadExtensions(
      [SKILL_CORTEX_ENTRY],
      fixtureRoot,
      createEventBus(),
    );
    assert.deepEqual(errors, [], "生产 .pi 入口必须能被宿主 loader 无错加载");
    assert.equal(extensions.length, 1);

    const modelRuntime = await ModelRuntime.create({
      refreshOnCreate: false,
      allowModelNetwork: false,
      modelsPath: null,
      authPath: path.join(fixtureRoot, "auth.json"),
    });
    const sessionManager = SessionManager.inMemory(fixtureRoot);
    const runner = new ExtensionRunner(
      extensions,
      runtime,
      fixtureRoot,
      sessionManager,
      new ModelRegistry(modelRuntime),
    );

    // 入口注册 discovery 与显式用户控制工具。
    const registeredNames = runner.getAllRegisteredTools().map((t) => t.definition.name).sort();
    assert.ok(registeredNames.includes("search_skills"), "生产入口必须注册 search_skills");
    assert.ok(registeredNames.includes("load_skill"), "生产入口必须注册 load_skill");
    for (const name of [
      "skill_memory_status",
      "skill_memory_set_learning",
      "skill_memory_list",
      "skill_memory_forget",
    ]) {
      assert.ok(registeredNames.includes(name), `生产入口必须注册 ${name}`);
    }

    const controlDef = runner.getToolDefinition("skill_memory_set_learning")!;
    const controlCtx = runner.createContext();
    const paused = await controlDef.execute(
      "pause-tcid", { enabled: false }, undefined, undefined, controlCtx,
    );
    assert.equal((paused.details as { learningEnabled: boolean }).learningEnabled, false);
    const resumed = await controlDef.execute(
      "resume-tcid", { enabled: true }, undefined, undefined, controlCtx,
    );
    assert.equal((resumed.details as { learningEnabled: boolean }).learningEnabled, true);

    // 真实 base prompt（含原生全量 Skill block）→ cortex inject 成功 → onDiscovery push（exposedToAgent=true）。
    const basePrompt = buildSystemPrompt({
      cwd: fixtureRoot,
      skills,
      contextFiles: [{ path: "AGENTS.md", content: "project context" }],
    });
    assert.ok(basePrompt.includes("<available_skills>"), "basePrompt 必须含原生全量 Skill block");
    const injectResult = await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      basePrompt,
      { cwd: fixtureRoot, skills, contextFiles: [] },
    );
    assert.ok(injectResult && typeof injectResult.systemPrompt === "string", "生产入口 inject 必须成功");
    assert.ok(
      injectResult.systemPrompt.includes("## Skill Cortex：prompt 外候选（有界 Top-K）"),
      "候选卡必须注入最终 prompt（exposedToAgent=true 的前提）",
    );

    // 真实 load_skill：search → load → details.source_hash。
    const ctx = runner.createContext();
    const searchDef = runner.getToolDefinition("search_skills");
    const loadDef = runner.getToolDefinition("load_skill");
    assert.ok(searchDef && loadDef);
    const searchResult = await searchDef.execute("tid", { query: "pdf", limit: 1 }, undefined, undefined, ctx);
    const matches = (searchResult.details as { matches: Array<{ skillId: string; skillRevision: string }> }).matches;
    assert.equal(matches.length, 1);
    const { skillId, skillRevision } = matches[0]!;
    const loadResult = await loadDef.execute(
      "tcid",
      { skill_id: skillId, skill_revision: skillRevision },
      undefined,
      undefined,
      ctx,
    );
    const details = loadResult.details as { category: string; source_hash?: string };
    assert.equal(details.category, "ok");
    assert.ok(typeof details.source_hash === "string", "生产入口 load_skill 必须返回 source_hash");

    // 主 Agent 选中事件序列：load_skill → 其他只读工具 → settled。
    await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "tc1",
      toolName: "load_skill",
      input: { skill_id: skillId, skill_revision: skillRevision },
    });
    await runner.emitToolResult({
      type: "tool_result",
      toolCallId: "tc1",
      toolName: "load_skill",
      input: { skill_id: skillId },
      content: [{ type: "text", text: "ok" }],
      isError: false,
      details,
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

    // 第三轮初始只召回 PDF；bounded search_skills 补搜暴露 1 个 docx 后再 load，应可归因。
    await runner.emitBeforeAgentStart("merge PDF documents", undefined, basePrompt, {
      cwd: fixtureRoot, skills, contextFiles: [],
    });
    const fallbackSearch = await searchDef.execute(
      "fallback-search", { query: "docx", limit: 1 }, undefined, undefined, ctx,
    );
    const fallbackMatches = (fallbackSearch.details as {
      matches: Array<{ skillId: string; skillRevision: string }>;
    }).matches;
    assert.equal(fallbackMatches.length, 1, "补搜必须保持 bounded limit=1");
    const fallbackSkill = fallbackMatches[0]!;
    const fallbackLoad = await loadDef.execute(
      "fallback-load", { skill_id: fallbackSkill.skillId, skill_revision: fallbackSkill.skillRevision },
      undefined, undefined, ctx,
    );
    await runner.emitToolCall({
      type: "tool_call", toolCallId: "fallback-load", toolName: "load_skill",
      input: { skill_id: fallbackSkill.skillId, skill_revision: fallbackSkill.skillRevision },
    });
    await runner.emitToolResult({
      type: "tool_result", toolCallId: "fallback-load", toolName: "load_skill",
      input: { skill_id: fallbackSkill.skillId }, content: [{ type: "text", text: "ok" }],
      isError: false, details: fallbackLoad.details,
    });
    await runner.emit({ type: "agent_settled" });

    // 第二轮有候选但 Main Agent 选择 No-Skill：仍需形成 exposure observation，不能只记录 Skill 调用。
    await runner.emitBeforeAgentStart("PDF", undefined, basePrompt, {
      cwd: fixtureRoot, skills, contextFiles: [],
    });
    await runner.emit({ type: "agent_settled" });

    // 生产入口的 store：<projectRoot>/.skill-cortex/practice（project-local，隔离 fixture）。
    const store = new PracticeStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "practice"),
      projectRoot: fixtureRoot,
    });
    const tenantScope = defaultTenantScope(fixtureRoot);
    const events = await store.queryEvidence(tenantScope);
    assert.equal(events.length, 2, "初始候选与 search_skills 补搜选择都必须形成 real event");
    const event: PracticeEvent = events.find((item) => item.parentSkillId === skillId)!;
    const fallbackEvent = events.find((item) => item.parentSkillId === fallbackSkill.skillId);
    assert.ok(fallbackEvent, "实际由 bounded search_skills 暴露并成功 load 的 Skill 必须可归因");
    assert.ok(fallbackEvent.candidateSkillIds.includes(fallbackSkill.skillId));
    assert.equal(fallbackEvent.candidateSkillIds.length, 2,
      "exposed set 只能是初始 PDF + bounded fallback 1 项，不能放宽为 3 项全 catalog");

    const expectedSourceHash = computeSourceHash(await readFile(path.join(fixtureRoot, "pdf", "SKILL.md")));
    assert.equal(event.sourceHash, expectedSourceHash, "source 必须绑定真实 load details.source_hash");
    assert.equal(event.sourceHash, details.source_hash);
    assert.equal(event.parentSkillId, skillId);
    assert.equal(event.parentSkillRevision, skillRevision);
    assert.ok(event.candidateSkillIds.includes(skillId), "候选必须来自当次真实 discovery 快照");
    assert.ok(event.candidateSkillIds.length <= 5, "候选必须是有界 Top-K");
    assert.deepEqual(event.selectedSkillIds, [skillId]);
    assert.equal(event.executionMode, "skill_md");
    assert.equal(event.provenance, "real");
    assert.equal(event.attribution, "unknown", "无 verifier 不得产生 verified_skill_effect");
    assert.equal(event.stepSummaries.length, 2);
    assert.equal(event.stepSummaries[0]!.operationClass, "tool:load_skill");
    assert.equal(event.stepSummaries[1]!.operationClass, "tool:read");
    assert.match(event.redactedTaskFeatures[0]!, /^prompt-hash:[0-9a-f]{32}$/);
    assert.equal(validatePracticeEvent(event).ok, true, "事件必须通过 Practice policy 校验");

    const exposureStore = new ExposureObservationStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "exposure"), projectRoot: fixtureRoot,
    });
    const observations = await exposureStore.list(tenantScope);
    assert.equal(observations.length, 3, "Skill、No-Skill 与 fallback Skill 三轮都必须持久化 shadow observation");
    assert.equal(observations.every((item) => item.baselineWouldInject), true);
    assert.equal(observations.every((item) => item.exactDeclaredReference), true);
    assert.equal(observations.some((item) => item.selectedSkillIds.length === 0), true,
      "No-Skill 轮必须保留空 selectedSkillIds");
    assert.equal(observations.some((item) => item.selectedSkillIds.includes(skillId)), true,
      "Skill 轮必须关联最终合法选择");
    assert.equal(observations.some((item) => item.selectedSkillIds.includes(fallbackSkill.skillId)), true,
      "fallback Skill 轮必须关联最终合法选择");
    assert.equal(observations.every((item) =>
      item.candidateBudget?.variants.map((variant) => variant.budget).join(",") === "1,2,3,5"), true,
    "每轮必须记录 K=1/2/3/5 shadow comparator");
    assert.equal(observations.every((item) =>
      item.cardProjection?.variants.map((variant) => variant.maxDescriptionChars).join(",") === "120,240,480"), true,
    "每轮必须记录 120/240/480 description shadow projection");
    assert.equal(JSON.stringify(observations).includes("merge PDF"), false, "不得保存原始任务");

    // 事件文件确实位于 project-local 目录（隔离 fixture，非工作区）。
    assert.ok(event.tenantScope.startsWith("project:"), "tenantScope 必须是 project 前缀");
  });
});
