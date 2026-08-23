/**
 * Phase 5 host lifecycle pipeline 测试（project-local，真实 store + executor 验证）。
 *
 * 覆盖：
 * - Dependency drift：match → unchanged（active 可执行）；source/tool drift → 仅目标
 *   suspended、unrelated 不变；missing/malformed current fail-closed；
 *   current_unavailable（currentFor=undefined）⇒ fail-closed suspend；
 * - Evidence cascade：invalidatedEventIds → 对应 suspended、无关不变、终态不重复；
 * - Rollback：stable match → 恢复 previousStableRevision（落盘 + 可执行）；stable 仍 drift
 *   → requires_revalidation（slow path）；无 stable → parent Skill slow path；
 * - dependencyRevalidated 硬约束：只来源于 pipeline 内部真实 diff（外部无 seam）；
 * - Skill disappearance：旧 parent 的 procedure suspend；move-rename（新 skillId）不匹配旧 lineage；
 * - MED：canary replayEvidenceIds 在 stable 重建时保留；cascade 对 replay evidence 有效；
 * - store reload：lifecycle 状态与 stable lookup 保持。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { CompiledProcedure, DependencyFingerprint } from "../../core/contracts/index.ts";
import {
  SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX,
  buildPhase3ProcedureDraft,
  transitionPhase3ProcedureActive,
  transitionPhase3ProcedureCanary,
  transitionPhase3ProcedureSuspend,
  transitionPhase3ProcedureValidation,
  type Phase3ActiveProcedure,
  type Phase3InvalidatableProcedure,
} from "../phase3/index.ts";
import { ProcedureStore, ROLLBACK_REASON } from "../store/index.ts";
import { execute } from "../../runtime/executor.ts";
import { createCanaryServices } from "../../evaluation/phase4/canary.ts";
import {
  applyDependencyDrift,
  applyEvidenceCascade,
  rollbackToPreviousStable,
  suspendDriftedProcedures,
  suspendProceduresForMissingSkills,
} from "./index.ts";

const SKILL_HASH = "8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830";
const REFERENCE_V1 = "73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const REFERENCE_V2 = "44c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const PARENT_SKILL_ID = "skill:" + "1".repeat(64);
const PARENT_SKILL_REVISION = "rev:" + "2".repeat(64);
const OTHER_SKILL_ID = "skill:" + "3".repeat(64);
const VALIDATION_REPORT = "validation:phase3-pagination-p3-gate-2026-08-15";
const CANARY_REPORT = "canary:phase3-pagination-p4-gate-2026-08-16";
const ACTIVE_REPORT = "active:phase3-pagination-p4-canary-2026-08-16";
const EVIDENCE_A = "practice:offset-1";
const EVIDENCE_B = "practice:keyset-1";
const REPLAY_EVIDENCE = "practice:replay-canary-1";
const OFFSET_SQL = "SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;";

let tempRoot = "";
let storeSeq = 0;

function makeStore(): ProcedureStore {
  storeSeq += 1;
  return new ProcedureStore({
    rootDir: path.join(tempRoot, `store-${storeSeq}`),
    projectRoot: tempRoot,
    now: () => new Date("2026-08-20T00:00:00.000Z"),
  });
}

function buildDraft(
  referenceHash: string,
  evidenceIds: string[],
  options: { parentSkillId?: string } = {},
) {
  return buildPhase3ProcedureDraft({
    parentSkillId: options.parentSkillId ?? PARENT_SKILL_ID,
    parentSkillRevision: PARENT_SKILL_REVISION,
    skillMdHash: SKILL_HASH,
    selectedReferenceHash: referenceHash,
    createdAt: "2026-08-14T00:00:00.000Z",
    evidenceIds,
  });
}

function buildActive(
  referenceHash: string,
  evidenceIds: string[],
  previousStableRevision?: string,
): Phase3ActiveProcedure {
  const draft = buildDraft(referenceHash, evidenceIds);
  const validated = transitionPhase3ProcedureValidation(draft, {
    decision: "validated",
    validationReportId: VALIDATION_REPORT,
  });
  const canary = transitionPhase3ProcedureCanary(validated, {
    decision: "canary",
    canaryReportId: CANARY_REPORT,
    ...(evidenceIds.includes(REPLAY_EVIDENCE) ? { replayEvidenceIds: [REPLAY_EVIDENCE] } : {}),
  });
  return transitionPhase3ProcedureActive(canary, {
    decision: "active",
    activeReportId: ACTIVE_REPORT,
    ...(previousStableRevision !== undefined ? { previousStableRevision } : {}),
  });
}

/** 落盘并推进到 active（v1）。 */
async function persistActive(store: ProcedureStore, referenceHash = REFERENCE_V1): Promise<Phase3ActiveProcedure> {
  const draft = buildDraft(referenceHash, [EVIDENCE_A, EVIDENCE_B]);
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
  return active;
}

function matchingCurrent(procedure: CompiledProcedure): DependencyFingerprint {
  return { ...procedure.dependencyFingerprint };
}

function driftedCurrent(procedure: CompiledProcedure, overrides: Partial<DependencyFingerprint>): DependencyFingerprint {
  return { ...matchingCurrent(procedure), ...overrides };
}

/** executor 执行（active 上下文，验证快路径/慢路径语义）。 */
async function executeOutcome(procedure: CompiledProcedure): Promise<"fast_path" | "slow_path"> {
  const outcome = await execute({
    selectedSkill: { skillId: procedure.parentSkillId, skillRevision: procedure.parentSkillRevision },
    procedure,
    environment: {
      executionContext: procedure.status === "active" ? "active" : "shadow_replay",
      currentSkillRevision: procedure.parentSkillRevision,
      currentDependencyFingerprint: procedure.dependencyFingerprint,
      preconditions: [
        { predicateId: "bounded-sql-input", result: true },
        { predicateId: "source-bindings-current", result: true },
      ],
      requestedEffects: [],
      authorizationRequired: false,
    },
    taskInput: { sql: OFFSET_SQL },
    guardObservations: [
      { predicateId: "bounded-supported-sql", phase: "runtime", result: true },
      { predicateId: "source-and-dependency-match", phase: "runtime", result: true },
    ],
    services: createCanaryServices(),
  });
  return outcome.outcome === "fast_path" ? "fast_path" : "slow_path";
}

before(() => {
  tempRoot = mkdtempSync(path.join(process.cwd(), ".tmp-lifecycle-pipeline-"));
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("lifecycle pipeline：Dependency drift", () => {
  it("match ⇒ unchanged；active 可执行（executor fast_path）", async () => {
    const store = makeStore();
    const active = await persistActive(store);
    const outcome = await applyDependencyDrift(active, matchingCurrent(active), store, "tool");
    assert.deepEqual(outcome, { procedureId: active.procedureId, status: "unchanged", impactedDimensions: [] });
    assert.equal((await store.getProcedure(active.procedureId))!.status, "active", "match 不 suspend");
    assert.equal(await executeOutcome(active), "fast_path", "active + match 可执行");
  });

  it("source drift ⇒ 仅目标 suspended（suspendKind=dependency_drift）；unrelated 不变", async () => {
    const store = makeStore();
    const active = await persistActive(store);
    // unrelated：不同 parentSkillId ⇒ 不同 procedureId（可同时落盘）。
    const unrelatedDraft = buildDraft(REFERENCE_V1, [EVIDENCE_A, EVIDENCE_B], { parentSkillId: OTHER_SKILL_ID });
    await store.save(unrelatedDraft, { trigger: "agent" });
    const unrelatedValidated = transitionPhase3ProcedureValidation(unrelatedDraft, {
      decision: "validated",
      validationReportId: VALIDATION_REPORT,
    });
    await store.transition(unrelatedDraft, unrelatedValidated, { trigger: "procedure" });
    const unrelatedCanary = transitionPhase3ProcedureCanary(unrelatedValidated, {
      decision: "canary",
      canaryReportId: CANARY_REPORT,
    });
    await store.transition(unrelatedValidated, unrelatedCanary, { trigger: "procedure" });
    const unrelatedActive = transitionPhase3ProcedureActive(unrelatedCanary, {
      decision: "active",
      activeReportId: ACTIVE_REPORT,
    });
    await store.transition(unrelatedCanary, unrelatedActive, { trigger: "tool" });

    // 批处理按 procedure 取当次 current：目标 source drift，unrelated 匹配。
    const outcomes = await suspendDriftedProcedures({
      store,
      currentFor: (procedure) =>
        procedure.procedureId === active.procedureId
          ? driftedCurrent(active, { sourceHash: `sha256:${"a".repeat(64)}` })
          : matchingCurrent(unrelatedActive),
      trigger: "tool",
    });
    const activeOutcome = outcomes.find((o) => o.procedureId === active.procedureId);
    const unrelatedOutcome = outcomes.find((o) => o.procedureId === unrelatedActive.procedureId);
    assert.equal(activeOutcome!.status, "suspended");
    assert.deepEqual(activeOutcome!.impactedDimensions, ["source"]);
    assert.equal(activeOutcome!.reason, `${SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX}source`);
    assert.equal(unrelatedOutcome!.status, "unchanged", "unrelated 不 suspend");
    assert.equal((await store.getProcedure(unrelatedActive.procedureId))!.status, "active", "unrelated 保持 active");

    const suspended = await store.getProcedure(active.procedureId);
    assert.equal(suspended!.status, "suspended");
    assert.equal(suspended!.suspendKind, "dependency_drift");
  });

  it("missing/malformed current ⇒ fail-closed（throw，不得当作无漂移）", async () => {
    const store = makeStore();
    const active = await persistActive(store);
    await assert.rejects(
      applyDependencyDrift(active, { sourceHash: "not-a-hash" }, store, "tool"),
      /lifecycle_pipeline_current_source_hash_invalid/,
    );
    await assert.rejects(
      applyDependencyDrift(active, undefined as never, store, "tool"),
      /lifecycle_pipeline_current_fingerprint_required/,
    );
    assert.equal((await store.getProcedure(active.procedureId))!.status, "active", "fail-closed 不修改状态");
  });

  it("current_unavailable（currentFor=undefined）⇒ fail-closed suspend", async () => {
    const store = makeStore();
    const active = await persistActive(store);
    const outcomes = await suspendDriftedProcedures({
      store,
      currentFor: () => undefined,
      trigger: "tool",
    });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.status, "suspended");
    assert.match(outcomes[0]!.reason ?? "", /current_unavailable/);
  });
});

describe("lifecycle pipeline：Evidence cascade", () => {
  it("invalidatedEventIds ⇒ 对应 procedure suspend（evidence_cascade）；无关不变", async () => {
    const store = makeStore();
    const activeA = await persistActive(store);
    // unrelated：不同 parentSkillId（不同 procedureId，只依赖 EVIDENCE_B）。
    const unrelatedDraft = buildDraft(REFERENCE_V1, [EVIDENCE_B], { parentSkillId: OTHER_SKILL_ID });
    await store.save(unrelatedDraft, { trigger: "agent" });
    const unrelatedValidated = transitionPhase3ProcedureValidation(unrelatedDraft, {
      decision: "validated",
      validationReportId: VALIDATION_REPORT,
    });
    await store.transition(unrelatedDraft, unrelatedValidated, { trigger: "procedure" });
    const unrelatedCanary = transitionPhase3ProcedureCanary(unrelatedValidated, {
      decision: "canary",
      canaryReportId: CANARY_REPORT,
    });
    await store.transition(unrelatedValidated, unrelatedCanary, { trigger: "procedure" });
    const unrelatedActive = transitionPhase3ProcedureActive(unrelatedCanary, {
      decision: "active",
      activeReportId: ACTIVE_REPORT,
    });
    await store.transition(unrelatedCanary, unrelatedActive, { trigger: "tool" });

    const outcomes = await applyEvidenceCascade({
      store,
      invalidatedEventIds: [EVIDENCE_A],
      trigger: "tool",
    });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.procedureId, activeA.procedureId);
    assert.equal(outcomes[0]!.status, "suspended");
    const suspended = await store.getProcedure(activeA.procedureId);
    assert.equal(suspended!.status, "suspended");
    assert.equal(suspended!.suspendKind, "evidence_cascade");
    assert.equal(suspended!.lifecycleReason, "evidence_cascade_deletion");
    assert.equal((await store.getProcedure(unrelatedActive.procedureId))!.status, "active", "无关不变");
  });

  it("已 suspended/retired 不非法重复 transition（already_terminal 跳过）", async () => {
    const store = makeStore();
    const active = await persistActive(store);
    // 先 cascade 一次（active → suspended）。
    await applyEvidenceCascade({ store, invalidatedEventIds: [EVIDENCE_A], trigger: "tool" });
    assert.equal((await store.getProcedure(active.procedureId))!.status, "suspended");
    // 再次 cascade（同 evidence）：终态跳过，不重复 transition。
    const outcomes = await applyEvidenceCascade({ store, invalidatedEventIds: [EVIDENCE_A], trigger: "tool" });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.status, "already_terminal");
    const events = await store.listEvents(active.procedureId);
    assert.equal(events.filter((e) => e.toStatus === "suspended").length, 1, "不重复 suspend");
  });

  it("MED：canary replayEvidenceIds 被 cascade 命中（release/current 保留累计 evidence）", async () => {
    const store = makeStore();
    // active 带 replay evidence。
    const draft = buildDraft(REFERENCE_V1, [EVIDENCE_A, EVIDENCE_B]);
    await store.save(draft, { trigger: "agent" });
    const validated = transitionPhase3ProcedureValidation(draft, { decision: "validated", validationReportId: VALIDATION_REPORT });
    await store.transition(draft, validated, { trigger: "procedure" });
    const canary = transitionPhase3ProcedureCanary(validated, {
      decision: "canary",
      canaryReportId: CANARY_REPORT,
      replayEvidenceIds: [REPLAY_EVIDENCE],
    });
    await store.transition(validated, canary, { trigger: "procedure" });
    const active = transitionPhase3ProcedureActive(canary, { decision: "active", activeReportId: ACTIVE_REPORT });
    await store.transition(canary, active, { trigger: "tool" });

    // MED：stable 重建保留完整 evidenceIds（含 replay）。
    const stable = await store.getStableByRevision(draft.procedureRevision);
    assert.ok(stable !== undefined);
    assert.ok(stable!.evidenceIds.includes(REPLAY_EVIDENCE), "replay evidence 在 stable 重建时保留");

    // cascade 命中 replay evidence ⇒ suspend。
    const outcomes = await applyEvidenceCascade({ store, invalidatedEventIds: [REPLAY_EVIDENCE], trigger: "tool" });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.status, "suspended");
  });
});

describe("lifecycle pipeline：Rollback（dependencyRevalidated 硬约束）", () => {
  it("stable match ⇒ 落盘切回 previousStableRevision + reload 保持 active", async () => {
    const store = makeStore();
    const v1 = await persistActive(store); // release[v1]=active（stable 候选）
    const v2Failed = await persistFailedV2(store, v1.procedureRevision);
    const result = await rollbackToPreviousStable({
      store,
      failedProcedure: v2Failed,
      current: matchingCurrent(v1),
      trigger: "tool",
    });
    assert.equal(result.ok, true, "stable match 必须回滚成功");
    if (result.ok) {
      assert.equal(result.rollbackTo.procedureRevision, v1.procedureRevision, "恢复 previousStableRevision");
      assert.equal(result.rollbackTo.status, "active");
      assert.equal(result.rollbackTo.activeReportId, ACTIVE_REPORT);
      assert.equal(result.rollbackTo.validationReportId, VALIDATION_REPORT, "恢复完整 promotion evidence");
      assert.equal(result.rollbackTo.canaryReportId, CANARY_REPORT);
      assert.equal(await executeOutcome(result.rollbackTo), "fast_path", "恢复对象可执行");
    }
    // 闭环：current 真正切回 stable revision + active；reload 保持。
    const current = await store.getProcedure(v1.procedureId);
    assert.equal(current!.procedureRevision, v1.procedureRevision, "current 切回 stable revision");
    assert.equal(current!.status, "active");
    const reloaded = new ProcedureStore({
      rootDir: store.rootDir,
      projectRoot: tempRoot,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const reloadedCurrent = await reloaded.getProcedure(v1.procedureId);
    assert.equal(reloadedCurrent!.procedureRevision, v1.procedureRevision, "reload 后仍是 stable active");
    assert.equal(reloadedCurrent!.status, "active");
    // 可审计 rollback 事件。
    const events = await reloaded.listEvents(v1.procedureId);
    const rollback = events[events.length - 1]!;
    assert.equal(rollback.fromStatus, "suspended");
    assert.equal(rollback.toStatus, "active");
    assert.equal(rollback.procedureRevision, v1.procedureRevision);
    assert.equal(rollback.reason, ROLLBACK_REASON);
  });

  it("stable 仍 drift ⇒ requires_revalidation（slow path，不得恢复）", async () => {
    const store = makeStore();
    const v1 = await persistActive(store);
    // v1 自身被 drift suspend（落盘）⇒ release[v1]=suspended-from-active + dependency_drift。
    await applyDependencyDrift(v1, driftedCurrent(v1, { sourceHash: `sha256:${"a".repeat(64)}` }), store, "tool");
    assert.equal((await store.getProcedure(v1.procedureId))!.status, "suspended");

    // v1 仍 drift（current 不匹配）⇒ derive=false ⇒ requires_revalidation。
    const result = await rollbackToPreviousStable({
      store,
      failedProcedure: failedV2(v1.procedureRevision),
      current: driftedCurrent(v1, { sourceHash: `sha256:${"a".repeat(64)}` }),
      trigger: "tool",
    });
    assert.equal(result.ok, false, "stable 仍 drift 不得恢复");
    if (!result.ok) {
      assert.equal(result.reason, "requires_revalidation");
      assert.equal(result.slowPath, true, "明确 slow path");
    }
  });

  it("dependencyRevalidated 只来源于真实 diff：stable 匹配（current 与 stable 一致）⇒ 允许恢复", async () => {
    const store = makeStore();
    const v1 = await persistActive(store);
    // v1 被 drift suspend（release[v1]=suspended-from-active+drift），但 current 已恢复匹配（重验通过）。
    await applyDependencyDrift(v1, driftedCurrent(v1, { sourceHash: `sha256:${"a".repeat(64)}` }), store, "tool");
    const v2Failed = await persistFailedV2(store, v1.procedureRevision);
    const result = await rollbackToPreviousStable({
      store,
      failedProcedure: v2Failed,
      current: matchingCurrent(v1), // 与 stable 一致 ⇒ 真实 diff 无命中 ⇒ revalidated=true
      trigger: "tool",
    });
    assert.equal(result.ok, true, "真实 current 匹配（diff 无命中）⇒ 重验派生 true");
  });

  it("无 previousStableRevision ⇒ no_stable_version（parent Skill slow path）", async () => {
    const store = makeStore();
    const v1 = await persistActive(store);
    // v2 不带 previousStableRevision（首次发布语义）。
    const v2Active = buildActive(REFERENCE_V2, [EVIDENCE_A, EVIDENCE_B]);
    const failed = transitionPhase3ProcedureSuspend(v2Active as Phase3InvalidatableProcedure, {
      decision: "suspended",
      reason: `${SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX}tool`,
      suspendKind: "dependency_drift",
    });
    const result = await rollbackToPreviousStable({
      store,
      failedProcedure: failed,
      current: matchingCurrent(v1),
      trigger: "tool",
    });
    assert.deepEqual(result, { ok: false, reason: "no_stable_version", slowPath: true });
  });

  it("identity/lineage fail-closed：stable 跨 lineage（不同 parentSkillId）不可恢复", async () => {
    const store = makeStore();
    // foreign：不同 parentSkillId 的 active（落盘 ⇒ release 记录存在）。
    const foreignDraft = buildDraft(REFERENCE_V1, [EVIDENCE_A], { parentSkillId: OTHER_SKILL_ID });
    await store.save(foreignDraft, { trigger: "agent" });
    const foreignValidated = transitionPhase3ProcedureValidation(foreignDraft, {
      decision: "validated",
      validationReportId: VALIDATION_REPORT,
    });
    await store.transition(foreignDraft, foreignValidated, { trigger: "procedure" });
    const foreignCanary = transitionPhase3ProcedureCanary(foreignValidated, {
      decision: "canary",
      canaryReportId: CANARY_REPORT,
    });
    await store.transition(foreignValidated, foreignCanary, { trigger: "procedure" });
    const foreignActive = transitionPhase3ProcedureActive(foreignCanary, {
      decision: "active",
      activeReportId: ACTIVE_REPORT,
    });
    await store.transition(foreignCanary, foreignActive, { trigger: "tool" });

    // failed 引用 foreign 的 revision（跨 lineage）。
    const result = await rollbackToPreviousStable({
      store,
      failedProcedure: failedV2(foreignActive.procedureRevision),
      current: matchingCurrent(foreignActive),
      trigger: "tool",
    });
    assert.equal(result.ok, false, "跨 lineage 不得恢复");
    if (!result.ok) assert.equal(result.reason, "identity_mismatch");
  });
});

describe("lifecycle pipeline：uninstall / scope / move-rename 矩阵（完整 identity snapshot）", () => {
  /** 落盘一个不同 parentSkillId 的 active procedure（模拟同名不同 scope/path 或 move-rename 后新实例）。 */
  async function persistActiveFor(
    store: ProcedureStore,
    parentSkillId: string,
  ): Promise<Phase3ActiveProcedure> {
    const draft = buildDraft(REFERENCE_V1, [EVIDENCE_A], { parentSkillId });
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
    return active;
  }

  it("uninstall：旧 skillId 从完整 installed 快照消失 ⇒ 相关 procedure suspend；仍安装的 skill 不变", async () => {
    const store = makeStore();
    const oldSkill = await persistActive(store); // parentSkillId=PARENT_SKILL_ID（将被 uninstall）
    const keptSkill = await persistActiveFor(store, OTHER_SKILL_ID); // 仍在快照
    const outcomes = await suspendProceduresForMissingSkills({
      store,
      currentInstalledSkillIds: new Set([OTHER_SKILL_ID]),
      trigger: "tool",
    });
    assert.equal(outcomes.length, 1, "只影响 uninstall 的旧 skill");
    assert.equal(outcomes[0]!.procedureId, oldSkill.procedureId);
    assert.equal((await store.getProcedure(oldSkill.procedureId))!.status, "suspended");
    assert.equal((await store.getProcedure(keptSkill.procedureId))!.status, "active", "仍安装的 skill 不变");
  });

  it("scope 改变产生新 skillId ⇒ 旧 procedure 不继承（suspend）；新 scope 实例独立", async () => {
    const store = makeStore();
    // 旧 scope（PARENT_SKILL_ID）的 procedure；scope 改变 ⇒ 新 skillId（OTHER_SKILL_ID）。
    const oldScope = await persistActive(store);
    const newScope = await persistActiveFor(store, OTHER_SKILL_ID);
    const outcomes = await suspendProceduresForMissingSkills({
      store,
      // 完整快照只含新 scope 的 skillId（旧 scope skillId 消失）。
      currentInstalledSkillIds: new Set([OTHER_SKILL_ID]),
      trigger: "tool",
    });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.procedureId, oldScope.procedureId, "旧 scope 的 procedure 不继承");
    assert.equal((await store.getProcedure(oldScope.procedureId))!.status, "suspended");
    assert.equal((await store.getProcedure(newScope.procedureId))!.status, "active", "新 scope 实例不受影响");
    // 身份不混同：旧 procedure 仍绑定旧 skillId。
    assert.equal((await store.getProcedure(oldScope.procedureId))!.parentSkillId, PARENT_SKILL_ID);
  });

  it("move/rename ⇒ 按新安装实例处理：旧 skillId 消失 ⇒ 旧 procedure suspend，新实例 active 保持", async () => {
    const store = makeStore();
    // move/rename：baseDir 变化 ⇒ 新 skillId（OTHER_SKILL_ID）；旧 skillId（PARENT_SKILL_ID）消失。
    const oldInstance = await persistActive(store);
    const newInstance = await persistActiveFor(store, OTHER_SKILL_ID);
    const outcomes = await suspendProceduresForMissingSkills({
      store,
      currentInstalledSkillIds: new Set([OTHER_SKILL_ID]),
      trigger: "tool",
    });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.procedureId, oldInstance.procedureId);
    assert.equal((await store.getProcedure(oldInstance.procedureId))!.status, "suspended");
    assert.equal((await store.getProcedure(newInstance.procedureId))!.status, "active", "新安装实例保持");
  });

  it("同名不同 scope/path 不互相误伤：各自的 skillId 独立判定", async () => {
    const store = makeStore();
    // 同名（同 referenceHash）但不同 scope/path ⇒ 不同 skillId 的两个 procedure。
    const sameNameA = await persistActiveFor(store, PARENT_SKILL_ID);
    const sameNameB = await persistActiveFor(store, OTHER_SKILL_ID);
    // 完整快照：A 在、B 不在（B 被 uninstall/scope 变化）。
    const outcomes = await suspendProceduresForMissingSkills({
      store,
      currentInstalledSkillIds: new Set([PARENT_SKILL_ID]),
      trigger: "tool",
    });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.procedureId, sameNameB.procedureId, "只有 B 被 suspend");
    assert.equal((await store.getProcedure(sameNameA.procedureId))!.status, "active", "A 不被误伤");
    assert.equal((await store.getProcedure(sameNameB.procedureId))!.status, "suspended");
  });

  it("unrelated：完整快照包含全部 parent ⇒ 全部保持原状态（0 影响）", async () => {
    const store = makeStore();
    const procA = await persistActiveFor(store, PARENT_SKILL_ID);
    const procB = await persistActiveFor(store, OTHER_SKILL_ID);
    const outcomes = await suspendProceduresForMissingSkills({
      store,
      currentInstalledSkillIds: new Set([PARENT_SKILL_ID, OTHER_SKILL_ID]),
      trigger: "tool",
    });
    assert.deepEqual(outcomes, []);
    assert.equal((await store.getProcedure(procA.procedureId))!.status, "active");
    assert.equal((await store.getProcedure(procB.procedureId))!.status, "active");
  });
});

/** v2 = 同 procedureId 新 revision 的 suspended current（内存；previousStableRevision 指向 v1）。 */
function failedV2(previousStableRevision: string): CompiledProcedure {
  const v2Active = buildActive(REFERENCE_V2, [EVIDENCE_A, EVIDENCE_B], previousStableRevision);
  return transitionPhase3ProcedureSuspend(v2Active as Phase3InvalidatableProcedure, {
    decision: "suspended",
    reason: `${SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX}tool`,
    suspendKind: "dependency_drift",
  });
}

/** 模拟「新 revision R2 晋升后失效」落盘：persistActive 后直写 current 为 v2 suspended。
 * 本 slice 无 revision save seam，跨 revision 状态须直写 current 构造。 */
async function persistFailedV2(store: ProcedureStore, previousStableRevision: string): Promise<CompiledProcedure> {
  const v2Suspended = failedV2(previousStableRevision);
  const currentDir = path.join(store.tenantDir, "current");
  const file = readdirSync(currentDir).find((f) => f.endsWith(".json"))!;
  writeFileSync(path.join(currentDir, file), JSON.stringify(v2Suspended), "utf8");
  return v2Suspended;
}

describe("lifecycle pipeline：E2E 持久化与 reload", () => {  it("store reload（新实例读同一目录）⇒ lifecycle 状态与 stable lookup 保持", async () => {
    const store = makeStore();
    const v1 = await persistActive(store);
    // v1 因 source drift 失效（落盘 suspended-from-active + dependency_drift）。
    await applyDependencyDrift(v1, driftedCurrent(v1, { sourceHash: `sha256:${"a".repeat(64)}` }), store, "tool");

    // reload：同一 rootDir 新实例。
    const reloaded = new ProcedureStore({
      rootDir: store.rootDir,
      projectRoot: tempRoot,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const failed = await reloaded.getProcedure(v1.procedureId);
    assert.equal(failed!.status, "suspended", "reload 后失效状态保持");
    assert.equal(failed!.suspendKind, "dependency_drift");
    assert.equal(failed!.lifecycleReason, `${SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX}source`);
    // stable lookup 保持：suspended-from-active 仍是 stable 候选（revalidation 门另判）。
    const stable = await reloaded.getStableByRevision(v1.procedureRevision);
    assert.ok(stable !== undefined, "reload 后 release 记录保持");
    assert.equal(stable!.status, "suspended");
    assert.equal(stable!.suspendedFrom, "active");
    const events = await reloaded.listEvents(v1.procedureId);
    assert.equal(events.filter((e) => e.toStatus === "suspended").length, 1, "审计事件保持");

    // reload 后 rollback 判定仍工作：current 匹配 stable（真实 diff）⇒ 允许恢复。
    const v2Failed = await persistFailedV2(reloaded, v1.procedureRevision);
    const result = await rollbackToPreviousStable({
      store: reloaded,
      failedProcedure: v2Failed,
      current: matchingCurrent(v1),
      trigger: "tool",
    });
    assert.equal(result.ok, true, "reload 后 rollback 判定恢复");
  });
});
