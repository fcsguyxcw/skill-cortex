/**
 * Phase 5 host pipeline —— procedure 生命周期 store 测试。
 *
 * 覆盖：
 * - 持久化 round-trip（save → getProcedure 字段一致）；
 * - 修订历史（按 procedureRevision；transition 不改 revision ⇒ 历史不膨胀；getByRevision 可查）；
 * - 事件日志可审计（save + 各 transition 各写事件；from/to/reason/reportId/trigger/seq 顺序）；
 * - 按 status / evidenceId 查询（diff/cascade 查找注入用）；
 * - 非法转换拒绝落盘（current 不被破坏）；
 * - 分区隔离（tenantScope）与 project-local 安全约束（rootDir 逃逸拒绝、corrupt 文件 fail-closed）；
 * - 级联删除入口（remove：current/history/events 随同清理，幂等）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { CompiledProcedure } from "../../core/contracts/index.ts";
import {
  SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX,
  buildPhase3ProcedureDraft,
  rollbackProcedure,
  transitionPhase3ProcedureActive,
  transitionPhase3ProcedureCanary,
  transitionPhase3ProcedureRetire,
  transitionPhase3ProcedureSuspend,
  transitionPhase3ProcedureValidation,
} from "../phase3/index.ts";
import {
  defaultTenantScope,
  ProcedureStore,
  type ProcedureTransitionEvent,
} from "./index.ts";

const SKILL_HASH = "8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830";
const REFERENCE_HASH = "73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const PARENT_SKILL_ID = "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2";
const PARENT_SKILL_REVISION = "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec";
const VALIDATION_REPORT = "validation:phase3-pagination-p3-gate-2026-08-15";
const CANARY_REPORT = "canary:phase3-pagination-p4-gate-2026-08-16";
const ACTIVE_REPORT = "active:phase3-pagination-p4-canary-2026-08-16";
const REASON = "source dependency drift";
/** HIGH 2：v1/v2 同 parentSkill ⇒ 同 procedureId，不同 referenceHash ⇒ 不同 procedureRevision。 */
const REFERENCE_V1 = "73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const REFERENCE_V2 = "44c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";

let projectRoot = "";
let storeDir = "";
let tempRoot = "";
let storeSeq = 0;

function draftOf() {
  return buildPhase3ProcedureDraft({
    parentSkillId: PARENT_SKILL_ID,
    parentSkillRevision: PARENT_SKILL_REVISION,
    skillMdHash: SKILL_HASH,
    selectedReferenceHash: REFERENCE_HASH,
    createdAt: "2026-08-14T00:00:00.000Z",
    evidenceIds: ["practice:offset-1", "practice:keyset-1"],
  });
}

function validatedOf() {
  return transitionPhase3ProcedureValidation(draftOf(), {
    decision: "validated",
    validationReportId: VALIDATION_REPORT,
  });
}

function canaryOf() {
  return transitionPhase3ProcedureCanary(validatedOf(), {
    decision: "canary",
    canaryReportId: CANARY_REPORT,
  });
}

function activeOf() {
  return transitionPhase3ProcedureActive(canaryOf(), {
    decision: "active",
    activeReportId: ACTIVE_REPORT,
  });
}

function suspendedOf() {
  return transitionPhase3ProcedureSuspend(activeOf(), {
    decision: "suspended",
    reason: REASON,
    suspendKind: "dependency_drift",
  });
}

function makeStore(overrides: { tenantScope?: string } = {}) {
  storeSeq += 1;
  // 每个测试独立 rootDir（node:test 的 it 可能并发执行，共享目录会互相干扰）。
  return new ProcedureStore({
    rootDir: path.join(storeDir, `store-${storeSeq}`),
    projectRoot,
    tenantScope: overrides.tenantScope,
    now: () => new Date("2026-08-20T00:00:00.000Z"),
  });
}

/** HIGH 2：按 referenceHash 构建同 procedureId 不同 revision 的 active（可带 previousStableRevision）。 */
function activeWithReference(
  referenceHash: string,
  previousStableRevision?: string,
): CompiledProcedure {
  const draft = buildPhase3ProcedureDraft({
    parentSkillId: PARENT_SKILL_ID,
    parentSkillRevision: PARENT_SKILL_REVISION,
    skillMdHash: SKILL_HASH,
    selectedReferenceHash: referenceHash,
    createdAt: "2026-08-14T00:00:00.000Z",
    evidenceIds: ["practice:offset-1", "practice:keyset-1"],
  });
  const validated = transitionPhase3ProcedureValidation(draft, {
    decision: "validated",
    validationReportId: VALIDATION_REPORT,
  });
  const canary = transitionPhase3ProcedureCanary(validated, {
    decision: "canary",
    canaryReportId: CANARY_REPORT,
  });
  return transitionPhase3ProcedureActive(canary, {
    decision: "active",
    activeReportId: ACTIVE_REPORT,
    ...(previousStableRevision !== undefined ? { previousStableRevision } : {}),
  });
}

/** HIGH 2：v1 落盘并推进到 active（release = active）。 */
async function persistActiveV1(
  store: ProcedureStore,
): Promise<{ draft: CompiledProcedure; active: CompiledProcedure }> {
  const draft = buildPhase3ProcedureDraft({
    parentSkillId: PARENT_SKILL_ID,
    parentSkillRevision: PARENT_SKILL_REVISION,
    skillMdHash: SKILL_HASH,
    selectedReferenceHash: REFERENCE_V1,
    createdAt: "2026-08-14T00:00:00.000Z",
    evidenceIds: ["practice:offset-1", "practice:keyset-1"],
  });
  await store.save(draft, { trigger: "agent" });
  const validated = transitionPhase3ProcedureValidation(draft, {
    decision: "validated",
    validationReportId: VALIDATION_REPORT,
  });
  await store.transition(draft, validated, { trigger: "procedure" });
  const canary = transitionPhase3ProcedureCanary(validated, {
    decision: "canary",
    canaryReportId: CANARY_REPORT,
  });
  await store.transition(validated, canary, { trigger: "procedure" });
  const active = transitionPhase3ProcedureActive(canary, {
    decision: "active",
    activeReportId: ACTIVE_REPORT,
  });
  await store.transition(canary, active, { trigger: "tool" });
  return { draft, active };
}

before(() => {
  tempRoot = mkdtempSync(path.join(process.cwd(), ".tmp-proc-store-"));
  projectRoot = path.join(tempRoot, "project");
  storeDir = path.join(projectRoot, ".skill-cortex", "procedures");
  mkdirSync(projectRoot, { recursive: true });
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("ProcedureStore：持久化 round-trip", () => {
  it("save → getProcedure 返回一致（全部合同字段）", async () => {
    const store = makeStore();
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });

    const loaded = await store.getProcedure(draft.procedureId);
    assert.ok(loaded !== undefined, "必须可读回");
    assert.equal(loaded!.procedureId, draft.procedureId);
    assert.equal(loaded!.status, "draft");
    assert.equal(loaded!.procedureRevision, draft.procedureRevision);
    assert.equal(loaded!.parentSkillId, PARENT_SKILL_ID);
    assert.equal(
      loaded!.dependencyFingerprint.sourceHash,
      draft.dependencyFingerprint.sourceHash,
      "sourceHash 经 builder 规范化为 sha256: 前缀，round-trip 必须一致",
    );
    assert.deepEqual(loaded!.evidenceIds, ["practice:offset-1", "practice:keyset-1"]);
    assert.deepEqual(loaded!.preconditions, draft.preconditions);
    assert.equal(loaded!.artifactHash, draft.artifactHash);
  });

  it("不存在 ⇒ getProcedure undefined；重复 save 拒绝", async () => {
    const store = makeStore();
    assert.equal(await store.getProcedure("procedure:nope"), undefined);
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });
    await assert.rejects(
      store.save(draft, { trigger: "agent" }),
      /procedure_store_already_exists/,
    );
  });

  it("round-trip 完整生命周期（draft→validated→canary→active→suspended），current 每次更新", async () => {
    const store = makeStore();
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });

    const chain: Array<[CompiledProcedure, CompiledProcedure]> = [
      [draft, validatedOf()],
      [validatedOf(), canaryOf()],
      [canaryOf(), activeOf()],
      [activeOf(), suspendedOf()],
    ];
    for (const [prior, next] of chain) {
      await store.transition(prior, next, { trigger: "procedure" });
    }
    const loaded = await store.getProcedure(draft.procedureId);
    assert.equal(loaded!.status, "suspended");
    assert.equal(loaded!.lifecycleReason, REASON);
    assert.equal(loaded!.suspendedFrom, "active", "suspendedFrom 持久化（active→suspended）");
    assert.equal(loaded!.suspendKind, "dependency_drift", "suspendKind 持久化");
  });
});

describe("ProcedureStore：修订历史", () => {
  it("save 写 history；transition 不改 revision ⇒ 历史不膨胀；getByRevision 可查", async () => {
    const store = makeStore();
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });
    await store.transition(draft, validatedOf(), { trigger: "procedure" });
    await store.transition(validatedOf(), canaryOf(), { trigger: "procedure" });

    const byRevision = await store.getByRevision(draft.procedureRevision);
    assert.ok(byRevision !== undefined, "按 procedureRevision 必须可查（rollback stableLookup 用）");
    assert.equal(byRevision!.procedureRevision, draft.procedureRevision);
    assert.equal(byRevision!.status, "draft", "历史快照保持首次写入状态（不可变历史）");

    assert.equal(await store.getByRevision("rev:" + "f".repeat(64)), undefined);
  });

  it("revision 变化 ⇒ 追加新 history 条目（版本化）", async () => {
    const store = makeStore();
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });
    const validated = validatedOf();
    await store.transition(draft, validated, { trigger: "procedure" });
    // 修订产生新 revision 的 canary（procedureRevision 变化 ⇒ 追加 history）。
    const revised = { ...canaryOf(), procedureRevision: "rev:" + "a".repeat(64) } as CompiledProcedure;
    await store.transition(validated, revised, { trigger: "tool" });

    const back = await store.getByRevision(revised.procedureRevision);
    assert.ok(back !== undefined);
    assert.equal(back!.procedureRevision, revised.procedureRevision);
    assert.equal(back!.status, "canary");
  });
});

describe("ProcedureStore：可审计事件日志", () => {
  it("save + 各 transition 各写一条事件；from/to/reason/reportId/trigger/seq 正确且升序", async () => {
    const store = makeStore();
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });
    const validated = validatedOf();
    await store.transition(draft, validated, { trigger: "procedure" });
    const canary = canaryOf();
    await store.transition(validatedOf(), canary, { trigger: "procedure" });
    const active = activeOf();
    await store.transition(canaryOf(), active, { trigger: "tool" });
    const suspended = suspendedOf();
    await store.transition(activeOf(), suspended, { trigger: "user" });

    const events: ProcedureTransitionEvent[] = await store.listEvents(draft.procedureId);
    assert.equal(events.length, 5, "save + 4 次 transition 共 5 条事件，不丢历史");
    assert.deepEqual(
      events.map((e) => [e.fromStatus, e.toStatus]),
      [
        [undefined, "draft"],
        ["draft", "validated"],
        ["validated", "canary"],
        ["canary", "active"],
        ["active", "suspended"],
      ],
      "事件顺序必须可追溯",
    );
    assert.deepEqual(
      events.map((e) => e.seq),
      [1, 2, 3, 4, 5],
      "seq 必须递增",
    );
    assert.deepEqual(events.map((e) => e.trigger), ["agent", "procedure", "procedure", "tool", "user"]);
    assert.equal(events[1]!.reportId, VALIDATION_REPORT, "validated 事件携带验证报告引用");
    assert.equal(events[2]!.reportId, CANARY_REPORT, "canary 事件携带 canary 报告引用");
    assert.equal(events[3]!.reportId, ACTIVE_REPORT, "active 事件携带 active 报告引用");
    assert.equal(events[4]!.reason, REASON, "suspended 事件携带失效原因");
    assert.equal(events[4]!.occurredAt, "2026-08-20T00:00:00.000Z");
    assert.equal(events[0]!.eventId.length > 0, true);
    assert.equal(new Set(events.map((e) => e.eventId)).size, 5, "事件 ID 唯一");
  });

  it("无事件的 procedure ⇒ 空列表", async () => {
    const store = makeStore();
    assert.deepEqual(await store.listEvents("procedure:no-events"), []);
  });
});

describe("ProcedureStore：查询接口（diff/cascade 注入用）", () => {
  it("listByStatus / listByEvidenceId / listCurrent", async () => {
    const store = makeStore();
    const draftA = draftOf();
    await store.save(draftA, { trigger: "agent" });
    await store.transition(draftA, validatedOf(), { trigger: "procedure" });
    // 不同 parentSkillRevision ⇒ 不同 procedureId（避免与 draftA 冲突）。
    const draftB = buildPhase3ProcedureDraft({
      parentSkillId: PARENT_SKILL_ID,
      parentSkillRevision: "rev:" + "b".repeat(64),
      skillMdHash: SKILL_HASH,
      selectedReferenceHash: REFERENCE_HASH,
      createdAt: "2026-08-14T00:00:00.000Z",
      evidenceIds: ["practice:offset-1"],
    });
    await store.save(draftB, { trigger: "agent" });

    const validated = await store.listByStatus("validated");
    assert.equal(validated.length, 1);
    assert.equal(validated[0]!.procedureId, draftA.procedureId);

    const drafts = await store.listByStatus("draft");
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.procedureId, draftB.procedureId);

    const byEvidence = await store.listByEvidenceId("practice:offset-1");
    assert.equal(byEvidence.length, 2, "共享 evidence 的 procedure 全部命中（cascade 查找）");

    const all = await store.listCurrent();
    assert.equal(all.length, 2);
  });
});

describe("ProcedureStore：fail-closed 与安全约束", () => {
  it("非法转换拒绝落盘（validated→retired 非合法边），current 保持 prior", async () => {
    const store = makeStore();
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });
    const validated = validatedOf();
    await store.transition(draft, validated, { trigger: "procedure" });

    const forged = { ...validated, status: "retired" } as CompiledProcedure;
    await assert.rejects(
      store.transition(validated, forged, { trigger: "tool" }),
      /procedure_store_illegal_transition/,
    );
    const loaded = await store.getProcedure(draft.procedureId);
    assert.equal(loaded!.status, "validated", "非法转换不得破坏 current");
    assert.equal(loaded!.validationReportId, VALIDATION_REPORT);
  });

  it("transition 前置条件：prior 不存在 / procedureId 不一致 ⇒ 拒绝", async () => {
    const store = makeStore();
    const draft = draftOf();
    // prior 未落盘（同 procedureId 合法边）：missing_prior。
    const ghost = { ...draft, status: "validated" } as CompiledProcedure;
    await assert.rejects(
      store.transition(draft, ghost, { trigger: "tool" }),
      /procedure_store_missing_prior/,
    );
    // procedureId 不一致：mismatch。
    await store.save(draft, { trigger: "agent" });
    const mismatched = { ...validatedOf(), procedureId: "procedure:other" } as CompiledProcedure;
    await assert.rejects(
      store.transition(validatedOf(), mismatched, { trigger: "tool" }),
      /procedure_store_transition_procedure_id_mismatch/,
    );
  });

  it("rootDir 逃逸（project-local 强制）⇒ 构造拒绝", () => {
    const outside = path.join(tempRoot, "outside");
    assert.throws(
      () => new ProcedureStore({ rootDir: outside, projectRoot }),
      /procedure_store_root_must_be_inside_project_root/,
    );
  });

  it("corrupt 文件 ⇒ fail-closed（procedure_store_corrupt，不回显内容）", async () => {
    const store = makeStore();
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });
    await store.transition(draft, validatedOf(), { trigger: "procedure" });
    const currentDir = path.join(store.tenantDir, "current");
    const target = readdirSync(currentDir).find((f) => f.endsWith(".json"))!;
    writeFileSync(path.join(currentDir, target), "{ not json", "utf8");

    await assert.rejects(
      store.getProcedure(draft.procedureId),
      /procedure_store_corrupt/,
    );
  });

  it("分区隔离：不同 tenantScope 互不可见", async () => {
    const storeA = makeStore({ tenantScope: "tenant:a" });
    const storeB = makeStore({ tenantScope: "tenant:b" });
    const draft = draftOf();
    await storeA.save(draft, { trigger: "agent" });
    assert.ok((await storeA.getProcedure(draft.procedureId)) !== undefined);
    assert.equal(await storeB.getProcedure(draft.procedureId), undefined);
    assert.equal((await storeB.listCurrent()).length, 0);
  });

  it("defaultTenantScope：project 前缀 + 规范化 hash（不含原始路径）", () => {
    const scope = defaultTenantScope(projectRoot);
    assert.match(scope, /^project:[0-9a-f]{32}$/u);
    assert.ok(!scope.includes(projectRoot), "不得含原始路径");
  });
});

describe("ProcedureStore：级联删除入口", () => {
  it("remove ⇒ current/history/events 随同清理；幂等", async () => {
    const store = makeStore();
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });
    await store.transition(draft, validatedOf(), { trigger: "procedure" });

    await store.remove(draft.procedureId, { trigger: "tool" });
    assert.equal(await store.getProcedure(draft.procedureId), undefined, "current 已清理");
    assert.deepEqual(await store.listEvents(draft.procedureId), [], "事件历史随同清理");
    assert.equal(await store.getByRevision(draft.procedureRevision), undefined, "修订历史随同清理");

    await store.remove(draft.procedureId, { trigger: "tool" }); // 幂等
  });

  it("remove 后同一 procedureId 可重新 save（无残留阻碍）", async () => {
    const store = makeStore();
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });
    await store.remove(draft.procedureId, { trigger: "user" });
    await store.save(draft, { trigger: "agent" });
    assert.ok((await store.getProcedure(draft.procedureId)) !== undefined);
    const events = await store.listEvents(draft.procedureId);
    assert.equal(events.length, 1, "重新 save 只写新事件（旧历史已清理）");
  });
});

describe("ProcedureStore：HIGH 1 — transition 不信任调用者 prior（stale/伪造拒绝）", () => {
  it("stale prior（current 已推进，调用者仍用旧状态对象）⇒ 拒绝且 current/events 不变", async () => {
    const store = makeStore();
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });
    const validated = validatedOf();
    await store.transition(draft, validated, { trigger: "procedure" });
    const canary = canaryOf();
    await store.transition(validatedOf(), canary, { trigger: "procedure" });

    const eventsBefore = await store.listEvents(draft.procedureId);
    // current 已到 canary；stale prior（validated 对象）提交 validated→canary（合法边）⇒ 拒绝。
    await assert.rejects(
      store.transition(validatedOf(), canaryOf(), { trigger: "tool" }),
      /procedure_store_stale_prior/,
    );
    const after = await store.getProcedure(draft.procedureId);
    assert.equal(after!.status, "canary", "current 不被破坏");
    assert.equal(after!.procedureRevision, canary.procedureRevision);
    assert.deepEqual(await store.listEvents(draft.procedureId), eventsBefore, "事件不被追加（不丢审计一致性）");
  });

  it("错 status prior（伪造 prior.status ≠ stored）⇒ 拒绝，current/events 不变", async () => {
    const store = makeStore();
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });
    const eventsBefore = await store.listEvents(draft.procedureId);
    // stored=draft；伪造 prior 声称 validated（validated→canary 是合法边，但 prior 与 stored 不符）。
    const forged = { ...draft, status: "validated" } as CompiledProcedure;
    await assert.rejects(
      store.transition(forged, canaryOf(), { trigger: "tool" }),
      /procedure_store_stale_prior/,
    );
    assert.equal((await store.getProcedure(draft.procedureId))!.status, "draft");
    assert.deepEqual(await store.listEvents(draft.procedureId), eventsBefore);
  });

  it("错 revision prior（prior.procedureRevision ≠ stored）⇒ 拒绝，current/events 不变", async () => {
    const store = makeStore();
    const draft = draftOf();
    await store.save(draft, { trigger: "agent" });
    const eventsBefore = await store.listEvents(draft.procedureId);
    const forged = { ...draft, procedureRevision: "rev:" + "c".repeat(64) } as CompiledProcedure;
    await assert.rejects(
      store.transition(forged, validatedOf(), { trigger: "tool" }),
      /procedure_store_stale_prior/,
    );
    assert.equal(
      (await store.getProcedure(draft.procedureId))!.procedureRevision,
      draft.procedureRevision,
      "revision 不被篡改",
    );
    assert.deepEqual(await store.listEvents(draft.procedureId), eventsBefore);
  });
});

describe("ProcedureStore：HIGH 2 — rollback stable lookup（release state 语义）", () => {
  it("v1 到达 active ⇒ getStableByRevision 返回 active（带发布报告）；v2 指向 v1 ⇒ rollback 成功", async () => {
    const store = makeStore();
    const { draft: v1, active } = await persistActiveV1(store);
    assert.notEqual(v1.procedureRevision, "");

    const stable = await store.getStableByRevision(v1.procedureRevision);
    assert.ok(stable !== undefined, "曾 active 的 revision 必须是 stable 候选");
    assert.equal(stable!.status, "active");
    assert.equal(stable!.activeReportId, ACTIVE_REPORT, "release 记录携带发布报告引用");
    assert.equal(stable!.procedureRevision, v1.procedureRevision);
    assert.equal(stable!.procedureId, v1.procedureId);
    void active;

    // v2：同 procedureId 新 revision，previousStableRevision=v1。
    const v2 = activeWithReference(REFERENCE_V2, v1.procedureRevision);
    assert.equal(v2.procedureId, v1.procedureId, "v1/v2 同 procedureId（lineage）");
    assert.notEqual(v2.procedureRevision, v1.procedureRevision);
    const result = rollbackProcedure({
      current: v2,
      stableLookup: (revision) => (revision === v1.procedureRevision ? stable : undefined),
    });
    assert.equal(result.ok, true, "有曾 active 的稳定版本必须回滚成功");
    if (result.ok) {
      assert.equal(result.rollbackTo.status, "active");
      assert.equal(result.rollbackTo.procedureRevision, v1.procedureRevision);
      assert.equal(result.rollbackTo.parentSkillId, v1.parentSkillId, "lineage 校验通过");
      assert.equal(result.rollbackTo.activeReportId, ACTIVE_REPORT);
    }
  });

  it("v1 仅到达 validated/canary（从未 active）⇒ 不可作 stable（rollback 拒绝）", async () => {
    const store = makeStore();
    const draftV1 = buildPhase3ProcedureDraft({
      parentSkillId: PARENT_SKILL_ID,
      parentSkillRevision: PARENT_SKILL_REVISION,
      skillMdHash: SKILL_HASH,
      selectedReferenceHash: REFERENCE_V1,
      createdAt: "2026-08-14T00:00:00.000Z",
      evidenceIds: ["practice:offset-1", "practice:keyset-1"],
    });
    await store.save(draftV1, { trigger: "agent" });
    const validated = transitionPhase3ProcedureValidation(draftV1, {
      decision: "validated",
      validationReportId: VALIDATION_REPORT,
    });
    await store.transition(draftV1, validated, { trigger: "procedure" });

    // 仅 validated（release=validated）：getStableByRevision ⇒ undefined（从未 active）。
    assert.equal(await store.getStableByRevision(draftV1.procedureRevision), undefined);

    const v2 = activeWithReference(REFERENCE_V2, draftV1.procedureRevision);
    const result = rollbackProcedure({
      current: v2,
      stableLookup: (revision) =>
        revision === draftV1.procedureRevision ? undefined : undefined,
    });
    assert.deepEqual(result, { ok: false, reason: "no_stable_version" }, "从未 active ⇒ 无稳定版本可回滚");
  });

  it("v1 active → suspended(drift)：release 保留 suspended-from-active；rollback 需重验，重验后成功", async () => {
    const store = makeStore();
    const { draft: v1 } = await persistActiveV1(store);
    const current = await store.getProcedure(v1.procedureId);
    assert.equal(current!.status, "active");
    // v1 被 dependency drift suspend（suspendedFrom=active, suspendKind=dependency_drift）。
    const driftSuspended = transitionPhase3ProcedureSuspend(current as never, {
      decision: "suspended",
      reason: `${SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX}source`,
      suspendKind: "dependency_drift",
    });
    await store.transition(current!, driftSuspended, { trigger: "tool" });

    const stable = await store.getStableByRevision(v1.procedureRevision);
    assert.ok(stable !== undefined, "suspended-from-active 仍是 stable 候选");
    assert.equal(stable!.status, "suspended");
    assert.equal(stable!.suspendedFrom, "active");
    assert.equal(stable!.suspendKind, "dependency_drift");

    const v2 = activeWithReference(REFERENCE_V2, v1.procedureRevision);
    const blocked = rollbackProcedure({
      current: v2,
      stableLookup: (revision) => (revision === v1.procedureRevision ? stable : undefined),
    });
    assert.equal(blocked.ok, false, "drift 失效 suspended 未经重验不得恢复");
    if (!blocked.ok) assert.equal(blocked.reason, "requires_revalidation");

    const revalidated = rollbackProcedure({
      current: v2,
      stableLookup: (revision) => (revision === v1.procedureRevision ? stable : undefined),
      dependencyRevalidated: true,
    });
    assert.equal(revalidated.ok, true, "显式重验后允许恢复");
  });

  it("retired revision 不可作 stable（getStableByRevision ⇒ undefined）", async () => {
    const store = makeStore();
    const { draft: v1, active } = await persistActiveV1(store);
    const retired = transitionPhase3ProcedureRetire(active as never, {
      decision: "retired",
      reason: REASON,
    });
    await store.transition(active, retired, { trigger: "user" });

    assert.equal(
      await store.getStableByRevision(v1.procedureRevision),
      undefined,
      "retired 是终态，不得作为回滚目标",
    );
  });

  it("release state 与 immutable artifact history 分离：getByRevision 返回历史快照，getStableByRevision 返回 release 状态", async () => {
    const store = makeStore();
    const { draft: v1 } = await persistActiveV1(store);
    // history（immutable）：首次写入快照（draft 状态，artifact 内容不变）。
    const history = await store.getByRevision(v1.procedureRevision);
    assert.ok(history !== undefined);
    assert.equal(history!.status, "draft", "immutable artifact 快照保持首次状态");
    assert.equal(history!.procedureRevision, v1.procedureRevision);
    // release（可更新）：该 revision 到达 active。
    const stable = await store.getStableByRevision(v1.procedureRevision);
    assert.ok(stable !== undefined);
    assert.equal(stable!.status, "active", "release 状态反映实际到达的发布状态");
    // 内容一致（transition 不改 artifact 字段）。
    assert.equal(stable!.artifactHash, history!.artifactHash);
    assert.equal(stable!.procedureRevision, history!.procedureRevision);
  });
});
