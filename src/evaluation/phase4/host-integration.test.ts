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
 *   c. skill_id/revision 匹配 ⇒ preflight 放行；工具执行 fast_path。sideEffectCount=0 由
 *      executor safety_stop 门保证（非 0 不会 fast_path），并用真实 runner 独立复现
 *      detectPagination 确定性输出（detector 纯只读纯函数，输出仅由输入决定）作为零 I/O
 *      间接证据——只写"纯只读函数复现一致"，不宣称"已证明零 I/O"。
 *
 * 范围边界（如实报告）：本 slice 只验证 preflight 身份检查；execution-adapter 闭包把
 * currentSkillRevision/currentDependencyFingerprint 写死为 procedure 自身值，resolver 的
 * revision/dependency 检查退化恒通过——依赖漂移失配未验证。
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
import { PAGINATION_VERIFIER_ID } from "../../adapters/pi/practice-pagination-hook.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import { detectPagination } from "../../procedures/phase3/detector.ts";
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

      // a. "发生在工具执行前" 的纵深证据：blocked 调用未生成 receipt，
      //    宿主即使错误地继续执行工具也必须 executor auth denied（绝不无条件 approved）。
      const def = runner.getToolDefinition(PILOT_TOOL_NAME)!;
      const executed = await def.execute(
        toolCallId,
        { sql: OFFSET_SQL, ...mismatch } as never,
        undefined,
        undefined,
        runner.createContext(),
      );
      const deniedDetails = executed.details as PilotToolDetails;
      assert.equal(deniedDetails.outcome, "denied", "blocked 调用无 receipt ⇒ denied");
      assert.equal(deniedDetails.failure, "authorization_missing_or_replayed");
    }

    // b. 被 block 的调用不产生 extension tool_result 事件（agent-loop.js:419-428 block
    //    路径只产合成 error result，不触发 tool_result 事件）⇒ observer 无证据 ⇒ 无事件。
    //    此处不 emitToolResult，直接 settle（模拟真实 host 对 blocked 调用的行为）。
    await runner.emit({ type: "agent_settled" });
    const events = await store.queryEvidence(defaultTenantScope(fixtureRoot));
    assert.equal(events.length, 0, "blocked 调用无 tool_result ⇒ observer 不产生任何事件");
  });

  it("c. 身份匹配 ⇒ preflight 放行；工具执行 fast_path；独立复现 detector 确定性输出", async () => {
    await startRun();
    const cases = [
      { sql: OFFSET_SQL, expectedClass: "uses_offset" },
      { sql: KEYSET_SQL, expectedClass: "uses_keyset" },
    ] as const;

    for (const [index, case_] of cases.entries()) {
      const toolCallId = `fast-${index}`;
      const params = pilotParams(case_.sql);

      const preflight = await runner.emitToolCall(pilotToolCall(toolCallId, params));
      assert.equal(preflight, undefined, "身份匹配必须放行");

      const def = runner.getToolDefinition(PILOT_TOOL_NAME)!;
      const result = await def.execute(
        toolCallId,
        params as never,
        undefined,
        undefined,
        runner.createContext(),
      );
      const details = result.details as PilotToolDetails;

      // fast path + 结构化 disposition。
      assert.equal(details.outcome, "fast_path", `case ${index} 必须 fast_path`);
      assert.equal(details.finding_class, case_.expectedClass);
      assert.equal(details.decision.execution_context, "shadow_replay", "executionContext 恒 shadow_replay");
      assert.equal(details.decision.mode, "compiled_procedure");

      // 零 I/O 间接证据：detector 是纯只读纯函数——用真实 runner 独立复现
      // detectPagination(sql) 的输出，与工具输出一致（输出仅由输入决定，无外部状态依赖）。
      // sideEffectCount=0 另由 executor safety_stop 门保证（非 0 不会 fast_path）。
      assert.equal(details.finding_class, detectPagination(case_.sql).class, "detector 确定性复现必须一致");

      // 授权/guard/verifier 全链：receipt gate approved；guard 全 pass；verifier pass。
      assert.deepEqual(details.authorization_results, [
        { gate_id: "pilot_receipt", result: "approved" },
      ]);
      assert.ok(details.guard_results.length > 0, "必须有 guard 观察");
      assert.ok(details.guard_results.every((g) => g.result === "pass"), "guard 必须全 pass");
      assert.ok(details.verifier_results.length > 0, "必须有 verifier 结果");
      assert.equal(details.verifier_results[0]!.verifier_id, PAGINATION_VERIFIER_ID);
      assert.equal(details.verifier_results[0]!.result, "pass");
      assert.ok(
        details.step_summaries.some((s) => s.operation_class === "detect-offset-pagination" && s.outcome === "ok"),
        "必须如实记录已执行的 detect 步骤",
      );

      // 有界输出：details/content 不得泄漏原始 SQL。
      assert.ok(!JSON.stringify(details).includes(case_.sql), "details 不得含原始 SQL");
      assert.ok(!JSON.stringify(result.content).includes(case_.sql), "content 不得含原始 SQL");

      // 真实 tool_result → observer compiledTool seam 解码。
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
    // 归因 fail-closed：P3_GATE_FROZEN skill 不在当次 discovery 快照（fixture skills）⇒
    // 不归因、不产生 provenance=shadow 事件（快路径证据只有在身份可归因时才落盘）。
    const events = await store.queryEvidence(defaultTenantScope(fixtureRoot));
    assert.equal(events.length, 0, "快照身份失配 ⇒ observer 不归因（fail-closed）");
  });

  it("纵深：无 preflight（无 receipt）直接 execute ⇒ executor auth denied", async () => {
    const def = runner.getToolDefinition(PILOT_TOOL_NAME)!;
    const result = await def.execute(
      "no-preflight",
      pilotParams(OFFSET_SQL) as never,
      undefined,
      undefined,
      runner.createContext(),
    );
    const details = result.details as PilotToolDetails;
    assert.equal(details.outcome, "denied");
    assert.equal(details.failure, "authorization_missing_or_replayed");
    assert.deepEqual(details.authorization_results, [
      { gate_id: "pilot_receipt", result: "denied" },
    ]);
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
