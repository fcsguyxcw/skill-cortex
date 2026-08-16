/**
 * Phase 4 host integration —— 隔离真实 runner E2E。
 *
 * 与 execution-adapter.test.ts（fake pi 冒烟）不同，本测试用真实 loader + ExtensionRunner
 * 加载 `host-integration-entry.ts`（真实 ExtensionAPI 接线：registerSkillCortex(inject) +
 * registerPracticeObserver(compiledTool seam) + registerSkillCortexPaginationShadow），
 * 验证 ADR-0012 §5 宿主 gate 契约：
 *
 *   a. tool_call preflight 在 skill identity 失配时 block（受控码 + terminate），且发生在
 *      工具执行前——block 返回即 handler 短路（runner 语义：handlers 先于工具执行）；
 *      纵深：blocked 调用无 receipt，宿主即使错误执行工具也会 executor auth denied。
 *   b. 被 block 的调用不产生 extension 的 tool_result 事件（agent-loop.js:419-428 block
 *      路径只产合成 error result，不触发 tool_result 事件；observer 因此无证据，
 *      settle 后 store 无事件）。注意：不断言"会话无 tool result"（host 会产合成错误）。
 *   c. skill_id/revision 匹配 ⇒ preflight 放行；但目标 skill（P3_GATE_FROZEN）不在当次
 *      discovery 候选（fixture 只有 docx-a/pdf）⇒ Point B：current source 缺失 ⇒ fail-closed
 *      （provider 注册但候选缺失，绝不回退 procedure self-match）⇒ resolver e 分支拒绝 ⇒
 *      slow_path（revision_mismatch），不执行 artifact、不产 compiled 事件。
 *
 * 范围边界（如实报告）：本 slice 验证 preflight 身份检查与 Point B fail-closed；真实候选
 * 匹配下的 fast_path 证据链由 attribution-e2e.check.ts（真实 skill ∈ 快照）覆盖；drift 注入
 * 失配由 drift-e2e.test.ts 覆盖。
 *
 * 隔离：真实 runner 用 --no-session 等价隔离（ExtensionRunner 内存 runner + fixture）；
 * store 落在 <fixture>/.skill-cortex/practice（project-local），不写用户环境。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createEventBus,
  loadSkillsFromDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type Skill,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createExtensionRuntime,
  loadExtensions,
  ExtensionRunner,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import { buildSystemPrompt } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import {
  BLOCK_REASON_SKILL_IDENTITY_MISMATCH,
  PILOT_TOOL_NAME,
  type PilotToolDetails,
} from "../../adapters/pi/execution-adapter.ts";
import { defaultTenantScope } from "../../adapters/pi/practice-observer.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import { buildCanaryValidatedProcedure } from "./canary.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const ENTRY = path.join(PROJECT_ROOT, "src", "evaluation", "phase4", "host-integration-entry.ts");

/** 与 entry 内部 registerSkillCortexPaginationShadow 同一冻结构造（确定性）。 */
const PROCEDURE = buildCanaryValidatedProcedure();
const SKILL_ID = PROCEDURE.parentSkillId;
const SKILL_REVISION = PROCEDURE.parentSkillRevision;

const OFFSET_SQL = "SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;";
const KEYSET_SQL = "SELECT * FROM posts WHERE id > $1 ORDER BY id LIMIT 20;";

let fixtureRoot = "";
let originalCwd = "";
let tempDirs: string[] = [];
let fixtureSkills: Skill[] = [];
let runner: ExtensionRunner;
let store: PracticeStore;

function pilotToolCall(toolCallId: string, input: Record<string, unknown>): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId,
    toolName: PILOT_TOOL_NAME,
    input,
  } as ToolCallEvent;
}

function pilotParams(sql: string): Record<string, unknown> {
  return { sql, skill_id: SKILL_ID, skill_revision: SKILL_REVISION };
}

before(async () => {
  originalCwd = process.cwd();
  const root = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-host-int-"));
  tempDirs.push(root);
  fixtureRoot = root;
  for (const name of ["docx-a", "pdf"]) {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${
        name === "pdf" ? "Read and merge PDF documents." : "Creates and reads Word docx files."
      }\n---\n\n# ${name}\n\nbody\n`,
    );
  }
  // entry 以 process.cwd() 为 projectRoot，测试隔离到 fixture 根。
  process.chdir(root);

  const { skills } = loadSkillsFromDir({ dir: fixtureRoot, source: "user" });
  assert.equal(skills.length, 2, "fixture 必须解析出 2 个真实 Skill");
  fixtureSkills = skills;

  const { extensions, errors, runtime } = await loadExtensions(
    [ENTRY],
    fixtureRoot,
    createEventBus(),
  );
  assert.deepEqual(errors, [], "host-integration-entry 必须能被宿主 loader 无错加载");
  assert.equal(extensions.length, 1);

  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
    modelsPath: null,
    authPath: path.join(fixtureRoot, "auth.json"),
  });
  const sessionManager = SessionManager.inMemory(fixtureRoot);
  runner = new ExtensionRunner(
    extensions,
    runtime,
    fixtureRoot,
    sessionManager,
    new ModelRegistry(modelRuntime),
  );
  store = new PracticeStore({
    rootDir: path.join(fixtureRoot, ".skill-cortex", "practice"),
    projectRoot: fixtureRoot,
  });
});

after(async () => {
  process.chdir(originalCwd);
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

/** 一次真实 before_agent_start：cortex inject + observer run 建立。 */
async function startRun(): Promise<void> {
  const basePrompt = buildSystemPrompt({
    cwd: fixtureRoot,
    skills: fixtureSkills,
    contextFiles: [{ path: "AGENTS.md", content: "project context" }],
  });
  const injectResult = await runner.emitBeforeAgentStart(
    "merge PDF documents",
    undefined,
    basePrompt,
    { cwd: fixtureRoot, skills: fixtureSkills, contextFiles: [] },
  );
  assert.ok(injectResult && typeof injectResult.systemPrompt === "string", "inject 必须成功");
  assert.ok(
    injectResult.systemPrompt.includes("## Skill Cortex：prompt 外候选（有界 Top-K）"),
    "候选卡必须注入最终 prompt",
  );
}

describe("Phase 4 host integration（真实 ExtensionRunner 加载 host-integration-entry）", () => {
  it("接线完整：注册 pilot 工具 + tool_call preflight 生效", async () => {
    const registered = runner.getAllRegisteredTools().map((t) => t.definition.name).sort();
    assert.ok(registered.includes(PILOT_TOOL_NAME), "entry 必须注册 skill_cortex_pagination_detect");
    assert.ok(registered.includes("search_skills"), "entry 必须注册 search_skills");
    assert.ok(registered.includes("load_skill"), "entry 必须注册 load_skill");
    assert.ok(runner.getToolDefinition(PILOT_TOOL_NAME), "工具定义必须可查");
  });

  it("a+b. 身份失配 ⇒ block（受控码+terminate）且发生在工具执行前；被 block 调用不产生 tool_result 事件", async () => {
    await startRun();
    // 格式合法（64-hex）但身份错：schema 校验先于 preflight（agent-loop.js:411-428），
    // 必须避开 pattern 失配的 schema 路径，才能验证 preflight 受控码。
    const mismatches: Array<Record<string, unknown>> = [
      { skill_id: `skill:${"f".repeat(64)}`, skill_revision: SKILL_REVISION }, // skillId 失配
      { skill_id: SKILL_ID, skill_revision: `rev:${"f".repeat(64)}` }, // revision 失配
    ];

    for (const [index, mismatch] of mismatches.entries()) {
      const toolCallId = `blocked-${index}`;
      const preflight = await runner.emitToolCall(
        pilotToolCall(toolCallId, { sql: OFFSET_SQL, ...mismatch }),
      );
      assert.deepEqual(preflight, {
        block: true,
        reason: BLOCK_REASON_SKILL_IDENTITY_MISMATCH,
        terminate: true,
      }, `失配 ${index} 必须 block`);

      // a. "发生在工具执行前" 的纵深证据：blocked 调用未生成 receipt。
      //    Point B（closure-blocker）：blocked 调用参数身份失配 + 目标不在当次候选
      //    （fixture 候选只有 docx-a/pdf）⇒ current source 缺失 ⇒ resolver 先于授权 gate
      //    fail-closed ⇒ slow_path。契约"宿主即使错误执行也绝不无条件 approved"仍满足：
      //    未执行 artifact、未 approved（authorization_results 为空）。
      const def = runner.getToolDefinition(PILOT_TOOL_NAME)!;
      const executed = await def.execute(
        toolCallId,
        { sql: OFFSET_SQL, ...mismatch } as never,
        undefined,
        undefined,
        runner.createContext(),
      );
      const rejectedDetails = executed.details as PilotToolDetails;
      assert.equal(rejectedDetails.outcome, "slow_path", "blocked 调用无 receipt + 候选缺失 ⇒ fail-closed slow_path");
      assert.equal(rejectedDetails.decision.reason, "revision_mismatch");
      assert.deepEqual(rejectedDetails.authorization_results, [], "resolver 拒绝 ⇒ 未调授权 gate（绝不无条件 approved）");
      assert.deepEqual(rejectedDetails.step_summaries, [], "未执行 artifact");
    }

    // b. 被 block 的调用不产生 extension tool_result 事件（agent-loop.js:419-428 block
    //    路径只产合成 error result，不触发 tool_result 事件）⇒ observer 无证据 ⇒ 无事件。
    //    此处不 emitToolResult，直接 settle（模拟真实 host 对 blocked 调用的行为）。
    await runner.emit({ type: "agent_settled" });
    const events = await store.queryEvidence(defaultTenantScope(fixtureRoot));
    assert.equal(events.length, 0, "blocked 调用无 tool_result ⇒ observer 不产生任何事件");
  });

  it("c. 身份匹配 ⇒ preflight 放行；Point B：目标 skill 不在当次候选 ⇒ current source 缺失 ⇒ fail-closed slow_path", async () => {
    await startRun();
    const cases = [OFFSET_SQL, KEYSET_SQL];

    for (const [index, sql] of cases.entries()) {
      const toolCallId = `fast-${index}`;
      const params = pilotParams(sql);

      const preflight = await runner.emitToolCall(pilotToolCall(toolCallId, params));
      assert.equal(preflight, undefined, "身份匹配必须放行（preflight 只比 params vs procedure）");

      const def = runner.getToolDefinition(PILOT_TOOL_NAME)!;
      const result = await def.execute(
        toolCallId,
        params as never,
        undefined,
        undefined,
        runner.createContext(),
      );
      const details = result.details as PilotToolDetails;

      // Point B（closure-blocker）：fixture 候选（docx-a/pdf）不含 P3_GATE_FROZEN ⇒
      // entry provider 返回 undefined ⇒ fail-closed（不得回退 procedure self-match）⇒
      // resolver e 分支拒绝（current source 缺失 = 无法证明 revision 匹配）⇒ slow_path。
      assert.equal(details.outcome, "slow_path", `case ${index} 必须 slow_path（current source 缺失）`);
      assert.equal(details.decision.mode, "skill_md");
      assert.equal(details.decision.reason, "revision_mismatch");
      assert.equal(details.decision.execution_context, "shadow_replay", "executionContext 恒 shadow_replay");
      assert.deepEqual(details.authorization_results, [], "resolver 拒绝 ⇒ 不调授权 gate");
      assert.deepEqual(details.guard_results, [], "未执行 ⇒ 无 guard 评估");
      assert.deepEqual(details.step_summaries, [], "未执行 artifact");

      // 有界输出：details/content 不得泄漏原始 SQL。
      assert.ok(!JSON.stringify(details).includes(sql), "details 不得含原始 SQL");
      assert.ok(!JSON.stringify(result.content).includes(sql), "content 不得含原始 SQL");

      await runner.emitToolResult({
        type: "tool_result",
        toolCallId,
        toolName: PILOT_TOOL_NAME,
        input: params,
        content: result.content,
        isError: false,
        details: result.details,
      });
    }

    await runner.emit({ type: "agent_settled" });
    // Point B + HIGH 2：slow_path 属 pre-execution 拒绝 ⇒ decoder fail-closed ⇒ 无 shadow 事件；
    // 无 load_skill ⇒ 无 real 事件。
    const shadow = await store.listProvenance(defaultTenantScope(fixtureRoot), "shadow");
    assert.equal(shadow.length, 0, "current source 缺失不得产生 compiled/verified 事件");
    const events = await store.queryEvidence(defaultTenantScope(fixtureRoot));
    assert.equal(events.length, 0, "不产生 real 事件");
  });

  it("纵深：无 preflight（无 receipt）直接 execute ⇒ fail-closed 拒绝（slow_path，不执行 artifact）", async () => {
    const def = runner.getToolDefinition(PILOT_TOOL_NAME)!;
    const result = await def.execute(
      "no-preflight",
      pilotParams(OFFSET_SQL) as never,
      undefined,
      undefined,
      runner.createContext(),
    );
    const details = result.details as PilotToolDetails;
    // Point B：provider 注册（host entry）但目标不在当次候选 ⇒ current source 缺失 ⇒
    // resolver e 分支 fail-closed ⇒ slow_path（先于授权 gate）。"无 receipt 绝不无条件
    // approved" 契约仍满足（未执行 artifact、authorization_results 为空）。
    // 注：executor 授权 denied 分支（无 provider/self-match 场景）由 execution-adapter.test.ts
    // 单测覆盖（未注册 provider ⇒ resolver 通过 ⇒ 授权 gate 拒绝）。
    assert.equal(details.outcome, "slow_path");
    assert.equal(details.decision.reason, "revision_mismatch");
    assert.deepEqual(details.authorization_results, []);
    assert.equal(details.decision.execution_context, "shadow_replay");
  });

  it("preflight 范围受限：非本工具 tool_call 不 block", async () => {
    const pass = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "other-1",
      toolName: "read",
      input: {},
    });
    assert.equal(pass, undefined, "非本工具必须放行（不处理）");
  });
});
