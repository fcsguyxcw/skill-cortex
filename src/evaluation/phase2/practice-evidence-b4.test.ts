/**
 * B4 — 真实 pagination PracticeEvent（带 verifier）机制测试。
 *
 * 覆盖：
 * - pagination hook：SQL 提取、结构化验证（class 受控 + 证据真实存在 + OFFSET 关键字）、
 *   detector 集成（deterministic 复算，非 LLM 自评）；
 * - observer + hook 集成（fake host）：真实会话事件序列（选中→load_skill→检测）产生
 *   provenance=real、step=detect-offset-pagination(ok)、verifier=phase3-pagination-structured-finding(pass)、
 *   attribution=verified_skill_effect 的事件；
 * - resolvePracticeEvidence 门：两条 distinct real verified 事件 ⇒ assessment.ok=true、
 *   distinctRealCount=2；
 * - fail 路径：hook 验证失败 ⇒ 事件 attribution 保持 mixed（不 verified）；hook 抛错 ⇒
 *   fail-closed 不落盘 + onError(finalize)。
 *
 * 注意：本测试用构造绑定（合法 sha256 形状）验证机制；真实 supabase 绑定的 E2E 确认见
 * docs/reports/2026-08-14-phase2-observer-gate.md §9。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import { validatePracticeEvent } from "../../practice/policy/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import { resolvePracticeEvidence } from "../phase3/practice-evidence.ts";
import {
  registerPracticeObserver,
  type EvidenceHook,
  type ObserverStatus,
  type RouteSnapshot,
  type RouteSnapshotSkill,
} from "../../adapters/pi/practice-observer.ts";
import {
  createPaginationEvidenceHook,
  extractSqlFromPrompt,
  PAGINATION_OPERATION_CLASS,
  PAGINATION_VERIFIER_ID,
  verifyStructuredFinding,
} from "../../adapters/pi/practice-pagination-hook.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

const HASH_64 = "a".repeat(64);
const hex = (n: number): string => n.toString(16).padStart(64, "0");
const makeSkill = (id: number): RouteSnapshotSkill => ({
  skillId: `skill:${hex(id)}`,
  skillRevision: `rev:${hex(id + 100)}`,
});
const SOURCE_HASH = `sha256:${HASH_64}`;

/** 会话任务 prompt（真实形态，含项目原创 SQL，非 evaluation 案例）。 */
const PROMPT_WITH_OFFSET_SQL =
  "请检测以下 SQL 是否使用 OFFSET 分页并输出结构化结论：SELECT * FROM users ORDER BY id LIMIT 50 OFFSET 100;";
const PROMPT_WITHOUT_SQL = "请检查当前 git 状态并汇报。";

interface FakePi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  _handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
}
function createFakePi(): FakePi {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  return {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    _handlers: handlers,
  };
}
const makeCtx = (sessionId: string): unknown => ({
  sessionManager: { getSessionId: () => sessionId },
});

function loadSkillCall(toolCallId: string, skill: RouteSnapshotSkill): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId,
    toolName: "load_skill",
    input: { skill_id: skill.skillId, skill_revision: skill.skillRevision },
  } as ToolCallEvent;
}
function loadSkillResult(toolCallId: string, skill: RouteSnapshotSkill): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId,
    toolName: "load_skill",
    input: { skill_id: skill.skillId },
    content: [{ type: "text", text: "ok" }],
    isError: false,
    details: { category: "ok", source_hash: SOURCE_HASH },
  } as ToolResultEvent;
}

interface Harness {
  pi: FakePi;
  store: PracticeStore;
  events: PracticeEvent[];
  statuses: ObserverStatus[];
  errors: Array<{ error: unknown; phase: string }>;
  runSelection(prompt: string, sessionId: string, skill: RouteSnapshotSkill): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const projectRoot = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-b4-"));
  tempDirs.push(projectRoot);
  const store = new PracticeStore({
    rootDir: path.join(projectRoot, ".skill-cortex", "practice"),
    projectRoot,
  });
  const pi = createFakePi();
  const events: PracticeEvent[] = [];
  const statuses: ObserverStatus[] = [];
  const errors: Array<{ error: unknown; phase: string }> = [];
  const snapshot: RouteSnapshot = {
    exposedToAgent: true,
    candidateSkills: [makeSkill(3), makeSkill(5)],
  };
  registerPracticeObserver(pi as unknown as ExtensionAPI, {
    store,
    projectRoot,
    routeSnapshotSource: { takeRouteSnapshot: () => snapshot, clear: () => {} },
    evidenceHook: createPaginationEvidenceHook(),
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    onError: (error, phase) => errors.push({ error, phase }),
  });
  const handlers = pi._handlers;
  return {
    pi,
    store,
    events,
    statuses,
    errors,
    async runSelection(prompt, sessionId, skill) {
      await handlers.get("before_agent_start")![0]!(
        { prompt, systemPrompt: "", systemPromptOptions: { skills: [] } },
        makeCtx(sessionId),
      );
      await handlers.get("tool_call")![0]!(loadSkillCall("c1", skill), makeCtx(sessionId));
      await handlers.get("tool_result")![0]!(loadSkillResult("c1", skill), makeCtx(sessionId));
      await handlers.get("agent_settled")![0]!({ type: "agent_settled" }, makeCtx(sessionId));
    },
  };
}

describe("pagination evidence hook", () => {
  it("extractSqlFromPrompt：含 SQL 的 prompt 提取有界 SQL；无 SQL 返回 undefined", () => {
    assert.equal(extractSqlFromPrompt(PROMPT_WITH_OFFSET_SQL), "SELECT * FROM users ORDER BY id LIMIT 50 OFFSET 100;");
    assert.equal(extractSqlFromPrompt(PROMPT_WITHOUT_SQL), undefined);
    assert.equal(extractSqlFromPrompt(""), undefined);
  });

  it("verifyStructuredFinding：OFFSET SQL 的 detector finding 通过；证据不真实则拒绝", () => {
    const sql = "SELECT * FROM users ORDER BY id LIMIT 50 OFFSET 100;";
    const finding = { class: "uses_offset", evidence: { matchText: "OFFSET 100" } };
    assert.equal(verifyStructuredFinding(sql, finding), true);
    assert.equal(verifyStructuredFinding(sql, { class: "uses_offset", evidence: { matchText: "NOT IN SQL" } }), false);
    assert.equal(verifyStructuredFinding(sql, { class: "uses_offset", evidence: { matchText: "LIMIT 50" } }), false, "uses_offset 必须含 OFFSET 证据");
    assert.equal(verifyStructuredFinding(sql, { class: "bogus_class", evidence: { matchText: "OFFSET 100" } }), false);
    assert.equal(verifyStructuredFinding(sql, { class: "uses_offset" }), false, "缺 matchText 拒绝");
    assert.equal(verifyStructuredFinding(sql, null), false);
  });

  it("createPaginationEvidenceHook：无 SQL 不注入；OFFSET SQL 注入 step ok + verifier pass", async () => {
    const hook = createPaginationEvidenceHook();
    const skill = makeSkill(3);
    // 无 SQL prompt：不注入。
    const none = await hook.collect(
      { prompt: PROMPT_WITHOUT_SQL } as never,
      skill as never,
    );
    assert.equal(none, undefined);
    // OFFSET SQL：注入检测步骤 + pass verifier。
    const evidence = await hook.collect({ prompt: PROMPT_WITH_OFFSET_SQL } as never, skill as never);
    assert.ok(evidence);
    assert.equal(evidence.steps[0]!.operationClass, PAGINATION_OPERATION_CLASS);
    assert.equal(evidence.steps[0]!.outcome, "ok");
    assert.equal(evidence.verifierResults[0]!.verifierId, PAGINATION_VERIFIER_ID);
    assert.equal(evidence.verifierResults[0]!.result, "pass");
  });
});

describe("observer + pagination hook（B4 契约事件）", () => {
  it("两条真实会话（含 OFFSET SQL）⇒ 2 条 verified_skill_effect real 事件且过 resolvePracticeEvidence 门", async () => {
    const harness = await createHarness();
    const skill = makeSkill(3);
    await harness.runSelection(PROMPT_WITH_OFFSET_SQL, "sess-1", skill);
    await harness.runSelection(
      "请检测以下 SQL 是否使用 OFFSET 分页：SELECT id, title FROM articles ORDER BY created_at DESC LIMIT 20 OFFSET 20;",
      "sess-1",
      skill,
    );

    assert.equal(harness.events.length, 2, "两条会话必须产生两条事件");
    // attribution/失败分类由 policy 在落盘时计算；以 store round-trip 值为准。
    const stored = await harness.store.queryEvidence(harness.events[0]!.tenantScope);
    assert.equal(stored.length, 2);
    for (const event of stored) {
      assert.equal(event.provenance, "real");
      assert.equal(event.parentSkillId, skill.skillId);
      assert.equal(event.parentSkillRevision, skill.skillRevision);
      assert.equal(event.sourceHash, SOURCE_HASH);
      assert.equal(
        event.stepSummaries.some(
          (s) => s.operationClass === PAGINATION_OPERATION_CLASS && s.outcome === "ok",
        ),
        true,
        "必须含 detect-offset-pagination ok 步骤",
      );
      assert.equal(
        event.verifierResults.some(
          (v) => v.verifierId === PAGINATION_VERIFIER_ID && v.result === "pass",
        ),
        true,
        "必须含 phase3-pagination-structured-finding pass verifier",
      );
      assert.equal(event.attribution, "verified_skill_effect");
      assert.equal(validatePracticeEvent(event).ok, true);
    }

    // resolvePracticeEvidence 验收门：两条 distinct real verified 事件 ⇒ ok。
    const assessment = await resolvePracticeEvidence({
      store: harness.store,
      tenantScope: stored[0]!.tenantScope,
      eventIds: stored.map((e) => e.eventId),
      expectedParentSkillId: skill.skillId,
      expectedParentSkillRevision: skill.skillRevision,
      expectedSourceHash: SOURCE_HASH,
      requiredOperationClass: PAGINATION_OPERATION_CLASS,
      requiredVerifierId: PAGINATION_VERIFIER_ID,
    });
    assert.equal(assessment.ok, true);
    assert.equal(assessment.distinctRealCount, 2);
    assert.equal(assessment.reason, "ok");
  });

  it("无 SQL 会话：hook 不注入 ⇒ attribution=unknown（不伪造 verified）", async () => {
    const harness = await createHarness();
    const skill = makeSkill(3);
    await harness.runSelection(PROMPT_WITHOUT_SQL, "sess-1", skill);
    assert.equal(harness.events.length, 1);
    const event = harness.events[0]!;
    assert.deepEqual(event.verifierResults, []);
    assert.equal(event.attribution, "unknown", "无 verifier 不得自称 verified");
  });

  it("hook 验证失败（SQL 证据异常）⇒ 事件 attribution=mixed，不过 verified 门", async () => {
    const projectRoot = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-b4-fail-"));
    tempDirs.push(projectRoot);
    const store = new PracticeStore({
      rootDir: path.join(projectRoot, ".skill-cortex", "practice"),
      projectRoot,
    });
    const pi = createFakePi();
    const events: PracticeEvent[] = [];
    const snapshot: RouteSnapshot = { exposedToAgent: true, candidateSkills: [makeSkill(3)] };
    const failingHook: EvidenceHook = {
      async collect() {
        return {
          steps: [{ actor: "procedure", operationClass: PAGINATION_OPERATION_CLASS, outcome: "failed" }],
          verifierResults: [
            { verifierId: PAGINATION_VERIFIER_ID, result: "fail", observedEffect: "structured-finding-invalid" },
          ],
        };
      },
    };
    registerPracticeObserver(pi as unknown as ExtensionAPI, {
      store,
      projectRoot,
      routeSnapshotSource: { takeRouteSnapshot: () => snapshot, clear: () => {} },
      evidenceHook: failingHook,
      onEvent: (e) => events.push(e),
    });
    const handlers = pi._handlers;
    const skill = makeSkill(3);
    await handlers.get("before_agent_start")![0]!(
      { prompt: PROMPT_WITH_OFFSET_SQL, systemPrompt: "", systemPromptOptions: { skills: [] } },
      makeCtx("sess-1"),
    );
    await handlers.get("tool_call")![0]!(loadSkillCall("c1", skill), makeCtx("sess-1"));
    await handlers.get("tool_result")![0]!(loadSkillResult("c1", skill), makeCtx("sess-1"));
    await handlers.get("agent_settled")![0]!({ type: "agent_settled" }, makeCtx("sess-1"));

    assert.equal(events.length, 1);
    // attribution 由 policy 在落盘时计算（onEvent 收到的是 append 前初始值）。
    const persisted = await store.getEvent(events[0]!.tenantScope, events[0]!.eventId);
    assert.ok(persisted, "事件必须已落盘");
    const event = persisted;
    assert.equal(event.attribution, "mixed", "fail verifier 不得 verified");
    assert.equal(validatePracticeEvent(event).ok, true);
    const assessment = await resolvePracticeEvidence({
      store,
      tenantScope: event.tenantScope,
      eventIds: [event.eventId],
      expectedParentSkillId: skill.skillId,
      expectedParentSkillRevision: skill.skillRevision,
      expectedSourceHash: SOURCE_HASH,
      requiredOperationClass: PAGINATION_OPERATION_CLASS,
      requiredVerifierId: PAGINATION_VERIFIER_ID,
    });
    assert.equal(assessment.ok, false, "fail verifier 事件不能过门");
    assert.equal(assessment.reason, "practice_event_covered_step_unverified");
  });

  it("hook 抛错 ⇒ fail-closed：该事件不落盘 + onError(finalize)", async () => {
    const projectRoot = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-b4-throw-"));
    tempDirs.push(projectRoot);
    const store = new PracticeStore({
      rootDir: path.join(projectRoot, ".skill-cortex", "practice"),
      projectRoot,
    });
    const pi = createFakePi();
    const events: PracticeEvent[] = [];
    const errors: Array<{ error: unknown; phase: string }> = [];
    const snapshot: RouteSnapshot = { exposedToAgent: true, candidateSkills: [makeSkill(3)] };
    registerPracticeObserver(pi as unknown as ExtensionAPI, {
      store,
      projectRoot,
      routeSnapshotSource: { takeRouteSnapshot: () => snapshot, clear: () => {} },
      evidenceHook: {
        async collect() {
          throw new Error("hook boom");
        },
      },
      onEvent: (e) => events.push(e),
      onError: (error, phase) => errors.push({ error, phase }),
    });
    const handlers = pi._handlers;
    const skill = makeSkill(3);
    await handlers.get("before_agent_start")![0]!(
      { prompt: PROMPT_WITH_OFFSET_SQL, systemPrompt: "", systemPromptOptions: { skills: [] } },
      makeCtx("sess-1"),
    );
    await handlers.get("tool_call")![0]!(loadSkillCall("c1", skill), makeCtx("sess-1"));
    await handlers.get("tool_result")![0]!(loadSkillResult("c1", skill), makeCtx("sess-1"));
    await handlers.get("agent_settled")![0]!({ type: "agent_settled" }, makeCtx("sess-1"));

    assert.equal(events.length, 0, "hook 抛错不得落盘（fail-closed）");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.phase, "finalize");
    assert.equal((await store.queryEvidence("project:any")).length, 0);
  });
});
