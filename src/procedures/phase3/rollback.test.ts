/**
 * Phase 5 slice 3 —— rollback + previous stable revision 测试（纯函数，project-local）。
 *
 * 数据合同 §6.2：rollback 指向 previousStableRevision（procedureRevision 字符串引用，
 * 非快照）；无稳定版本时走父 Skill 慢路径（不猜测、不伪造回滚）。
 *
 * 覆盖：
 * - active 晋升时记录上一稳定 revision（可选；无稳定版本时省略）；
 * - 一键回滚：status/revision/绑定恢复到上一稳定版本（rollbackTo 重新 active）；
 * - 无 previousStableRevision / stableLookup 找不到 ⇒ no_stable_version（慢路径语义）；
 * - 找到的版本非稳定状态（draft/validated/canary/retired）或引用格式非法 ⇒
 *   invalid_stable_version（fail-closed，不硬回滚）；
 * - rollback 纯函数不可变：current/stable 原对象不被修改；
 * - 回滚后旧版本不再执行（executor 集成：旧版本 suspended ⇒ slow_path；rollbackTo ⇒ fast_path）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompiledProcedure } from "../../core/contracts/index.ts";
import { execute } from "../../runtime/executor.ts";
import { P3_GATE_FROZEN } from "../../evaluation/phase3/p3-gate-runner.ts";
import {
  SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX,
  SUSPEND_REASON_EVIDENCE_CASCADE,
  buildPhase3ProcedureDraft,
  rollbackProcedure,
  transitionPhase3ProcedureActive,
  transitionPhase3ProcedureCanary,
  transitionPhase3ProcedureSuspend,
  transitionPhase3ProcedureValidation,
  type Phase3ActiveProcedure,
} from "./index.ts";
import { createCanaryServices } from "../../evaluation/phase4/canary.ts";

const SKILL_HASH = "8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830";
const REFERENCE_V1 = "73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const REFERENCE_V2 = "44c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const VALIDATION_REPORT = "validation:phase3-pagination-p3-gate-2026-08-15";
const CANARY_REPORT = "canary:phase3-pagination-p4-gate-2026-08-16";
const ACTIVE_REPORT = "active:phase3-pagination-p4-canary-2026-08-16";
const OFFSET_SQL = "SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;";

/** 冻结构造 active procedure：referenceHash 决定 artifactHash ⇒ procedureRevision 唯一。 */
function activeOf(referenceHash: string, previousStableRevision?: string): Phase3ActiveProcedure {
  const draft = buildPhase3ProcedureDraft({
    parentSkillId: P3_GATE_FROZEN.parentSkillId,
    parentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
    skillMdHash: SKILL_HASH,
    selectedReferenceHash: referenceHash,
    createdAt: "2026-08-15T00:00:00.000Z",
    evidenceIds: [...P3_GATE_FROZEN.eventIds],
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

/** v1 = 上一稳定 active 版本；v2 = 当前失效版本（previousStableRevision 指向 v1）。 */
function stableAndCurrent(): { stable: Phase3ActiveProcedure; current: CompiledProcedure } {
  const stable = activeOf(REFERENCE_V1);
  const currentV2 = activeOf(REFERENCE_V2, stable.procedureRevision);
  const suspended = transitionPhase3ProcedureSuspend(currentV2, {
    decision: "suspended",
    reason: "dependency drift",
    suspendKind: "manual",
  });
  return { stable, current: suspended };
}

describe("Phase 5 slice 3：previousStableRevision 记录（active 晋升）", () => {
  it("提供上一稳定 revision ⇒ 写入可审计字段；省略 ⇒ 无该字段（首次发布走慢路径）", () => {
    const v1 = activeOf(REFERENCE_V1);
    assert.equal(v1.previousStableRevision, undefined, "首次发布无上一稳定版本");
    const v2 = activeOf(REFERENCE_V2, v1.procedureRevision);
    assert.equal(v2.previousStableRevision, v1.procedureRevision, "记录上一稳定 revision 引用");
    assert.notEqual(v2.procedureRevision, v1.procedureRevision, "不同 artifact ⇒ 不同 revision");
  });

  it("previousStableRevision 格式非法（非 rev: 64hex）⇒ 晋升拒绝", () => {
    for (const bad of ["", "rev:abc", "procedure:phase3-pagination:x", "rev:" + "z".repeat(64)]) {
      assert.throws(
        () => activeOf(REFERENCE_V2, bad),
        /previous_stable_revision_invalid/,
        `ref=${JSON.stringify(bad)} 必须拒绝`,
      );
    }
  });
});

describe("Phase 5 slice 3：一键回滚（rollbackProcedure 纯函数）", () => {
  it("回滚成功：rollbackTo 恢复到上一稳定版本（status=active，revision/绑定恢复 v1）", () => {
    const { stable, current } = stableAndCurrent();
    const result = rollbackProcedure({
      current,
      stableLookup: (revision) => (revision === stable.procedureRevision ? stable : undefined),
    });
    assert.equal(result.ok, true, "有稳定版本必须回滚成功");
    if (result.ok) {
      assert.equal(result.rollbackTo.status, "active", "回滚目标恢复 active 发布状态");
      assert.equal(result.rollbackTo.procedureRevision, stable.procedureRevision, "revision 恢复 v1");
      assert.equal(result.rollbackTo.parentSkillId, P3_GATE_FROZEN.parentSkillId, "父绑定恢复");
      assert.equal(result.rollbackTo.parentSkillRevision, P3_GATE_FROZEN.parentSkillRevision);
      assert.equal(
        result.rollbackTo.dependencyFingerprint.sourceHash,
        stable.dependencyFingerprint.sourceHash,
        "依赖绑定恢复 v1",
      );
      assert.equal(
        result.rollbackTo.dependencyFingerprint.toolSchemaHash,
        stable.dependencyFingerprint.toolSchemaHash,
      );
      assert.equal(result.rollbackTo.activeReportId, ACTIVE_REPORT, "发布报告保留");
    }
  });

  it("无 previousStableRevision ⇒ no_stable_version（调用方走父 Skill 慢路径，不伪造回滚）", () => {
    const noStable = activeOf(REFERENCE_V2); // 首次发布，无上一稳定版本
    const result = rollbackProcedure({
      current: noStable,
      stableLookup: () => undefined,
    });
    assert.deepEqual(result, { ok: false, reason: "no_stable_version" });
  });

  it("stableLookup 找不到引用 ⇒ no_stable_version（不猜测、不硬回滚）", () => {
    const { current } = stableAndCurrent();
    const result = rollbackProcedure({ current, stableLookup: () => undefined });
    assert.deepEqual(result, { ok: false, reason: "no_stable_version" });
  });

  it("引用格式非法 ⇒ invalid_stable_version（fail-closed，不当作有效引用）", () => {
    const forged = { ...activeOf(REFERENCE_V2), previousStableRevision: "rev:not-a-hash" };
    const result = rollbackProcedure({ current: forged, stableLookup: () => undefined });
    assert.deepEqual(result, { ok: false, reason: "invalid_stable_version" });
  });

  it("找到的版本非稳定状态（draft/validated/canary/retired）⇒ invalid_stable_version", () => {
    const { current } = stableAndCurrent();
    const draft = buildPhase3ProcedureDraft({
      parentSkillId: P3_GATE_FROZEN.parentSkillId,
      parentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
      skillMdHash: SKILL_HASH,
      selectedReferenceHash: REFERENCE_V1,
      createdAt: "2026-08-15T00:00:00.000Z",
      evidenceIds: [...P3_GATE_FROZEN.eventIds],
    });
    for (const target of [
      draft, // draft
      transitionPhase3ProcedureValidation(draft, { decision: "validated", validationReportId: VALIDATION_REPORT }),
      transitionPhase3ProcedureCanary(
        transitionPhase3ProcedureValidation(draft, { decision: "validated", validationReportId: VALIDATION_REPORT }),
        { decision: "canary", canaryReportId: CANARY_REPORT },
      ),
      // retired（终态，不得复活）：
      { ...activeOf(REFERENCE_V1), status: "retired" },
    ] as CompiledProcedure[]) {
      const result = rollbackProcedure({
        current,
        stableLookup: (revision) => (revision === target.procedureRevision ? target : undefined),
      });
      assert.equal(result.ok, false, `目标 ${target.status} 不可作为回滚目标`);
      if (!result.ok) assert.equal(result.reason, "invalid_stable_version");
    }
  });

  it("suspended 的稳定版本可经 rollback 恢复 active（发布管道替换旧版本时通常 suspend 之）", () => {
    const stable = activeOf(REFERENCE_V1);
    const suspendedStable = transitionPhase3ProcedureSuspend(stable, {
      decision: "suspended",
      reason: "superseded by v2",
      suspendKind: "manual",
    });
    const { current } = stableAndCurrent();
    const result = rollbackProcedure({
      current,
      stableLookup: (revision) => (revision === suspendedStable.procedureRevision ? suspendedStable : undefined),
    });
    assert.equal(result.ok, true, "suspended 稳定版本必须可回滚");
    if (result.ok) {
      assert.equal(result.rollbackTo.status, "active", "回滚恢复为 active");
      assert.equal(result.rollbackTo.procedureRevision, stable.procedureRevision);
      assert.equal(result.rollbackTo.lifecycleReason, undefined, "回滚副本不残留失效原因");
      assert.equal(result.rollbackTo.suspendedFrom, undefined, "回滚副本不残留 suspended 元数据");
      assert.equal(result.rollbackTo.suspendKind, undefined);
    }
  });

  it("HIGH 2 identity：target.procedureRevision 必须精确等于引用（fail-closed）", () => {
    const { current } = stableAndCurrent();
    // lookup 返回 revision 不符的“冒充”target（status 合法但 revision 不同）。
    const imposter = activeOf(REFERENCE_V2); // 与 current 同 revision 的另一个版本
    const result = rollbackProcedure({
      current,
      stableLookup: () => imposter,
    });
    assert.equal(result.ok, false, "revision 不符必须拒绝");
    if (!result.ok) assert.equal(result.reason, "identity_mismatch");
  });

  it("HIGH 2 identity：procedureId / parentSkillId 必须与 current 同 lineage（fail-closed）", () => {
    const { current } = stableAndCurrent();
    // 不同父 skill 的 procedure（procedureId/parentSkillId 均不同）。
    const foreign = buildPhase3ProcedureDraft({
      parentSkillId: "skill:" + "f".repeat(64),
      parentSkillRevision: "rev:" + "e".repeat(64),
      skillMdHash: SKILL_HASH,
      selectedReferenceHash: REFERENCE_V1,
      createdAt: "2026-08-15T00:00:00.000Z",
      evidenceIds: [...P3_GATE_FROZEN.eventIds],
    });
    const foreignActive = transitionPhase3ProcedureActive(
      transitionPhase3ProcedureCanary(
        transitionPhase3ProcedureValidation(foreign, { decision: "validated", validationReportId: VALIDATION_REPORT }),
        { decision: "canary", canaryReportId: CANARY_REPORT },
      ),
      { decision: "active", activeReportId: ACTIVE_REPORT },
    );
    const result = rollbackProcedure({
      current,
      // 强制 lookup 命中 foreign（用 foreign 的 revision 构造引用链：foreign 是独立 procedure）。
      stableLookup: (revision) => (revision === foreignActive.procedureRevision ? foreignActive : undefined),
    });
    // current.previousStableRevision 指向 v1（不是 foreign 的 revision）⇒ lookup 找不到 ⇒ no_stable_version。
    // 为验证 lineage 校验本身，构造 current 的引用指向 foreign revision：
    const forged = {
      ...current,
      previousStableRevision: foreignActive.procedureRevision,
    };
    const forgedResult = rollbackProcedure({
      current: forged,
      stableLookup: (revision) => (revision === foreignActive.procedureRevision ? foreignActive : undefined),
    });
    assert.equal(forgedResult.ok, false, "跨 lineage 目标必须拒绝");
    if (!forgedResult.ok) assert.equal(forgedResult.reason, "identity_mismatch");
  });

  it("HIGH 2：suspended 失效 target（drift/cascade）未经 current dependency revalidation ⇒ requires_revalidation", () => {
    const { current } = stableAndCurrent();
    const stable = activeOf(REFERENCE_V1);
    const driftSuspended = transitionPhase3ProcedureSuspend(stable, {
      decision: "suspended",
      reason: `${SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX}source`,
      suspendKind: "dependency_drift",
    });
    const blocked = rollbackProcedure({
      current,
      stableLookup: (revision) => (revision === driftSuspended.procedureRevision ? driftSuspended : undefined),
    });
    assert.equal(blocked.ok, false, "drift 失效 suspended 未经重验不得恢复 active");
    if (!blocked.ok) assert.equal(blocked.reason, "requires_revalidation");

    const cascadeSuspended = transitionPhase3ProcedureSuspend(stable, {
      decision: "suspended",
      reason: SUSPEND_REASON_EVIDENCE_CASCADE,
      suspendKind: "evidence_cascade",
    });
    const cascadeBlocked = rollbackProcedure({
      current,
      stableLookup: (revision) => (revision === cascadeSuspended.procedureRevision ? cascadeSuspended : undefined),
    });
    assert.equal(cascadeBlocked.ok, false);
    if (!cascadeBlocked.ok) assert.equal(cascadeBlocked.reason, "requires_revalidation");
  });

  it("HIGH 2：显式 dependencyRevalidated=true 后，suspended 失效 target 可恢复 active（重验门通过）", () => {
    const { current } = stableAndCurrent();
    const stable = activeOf(REFERENCE_V1);
    const driftSuspended = transitionPhase3ProcedureSuspend(stable, {
      decision: "suspended",
      reason: `${SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX}source`,
      suspendKind: "dependency_drift",
    });
    const result = rollbackProcedure({
      current,
      stableLookup: (revision) => (revision === driftSuspended.procedureRevision ? driftSuspended : undefined),
      dependencyRevalidated: true,
    });
    assert.equal(result.ok, true, "显式重验后允许恢复");
    if (result.ok) {
      assert.equal(result.rollbackTo.status, "active");
      assert.equal(result.rollbackTo.procedureRevision, stable.procedureRevision);
    }
  });

  it("回滚是纯函数不可变：current/stable 原对象不被修改，rollbackTo 是新对象", () => {
    const { stable, current } = stableAndCurrent();
    const currentSnapshot = JSON.stringify(current);
    const stableSnapshot = JSON.stringify(stable);
    const result = rollbackProcedure({
      current,
      stableLookup: (revision) => (revision === stable.procedureRevision ? stable : undefined),
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.notEqual(result.rollbackTo, stable, "rollbackTo 必须是新副本");
      assert.equal(result.rollbackTo.status, "active");
    }
    assert.equal(JSON.stringify(current), currentSnapshot, "current 不可变");
    assert.equal(JSON.stringify(stable), stableSnapshot, "stable 不可变");
  });
});

describe("Phase 5 slice 3：回滚后执行语义（集成）", () => {
  it("旧版本失效后不再执行；rollbackTo 恢复可执行（active 上下文）", async () => {
    const { stable, current } = stableAndCurrent();
    const base = {
      selectedSkill: {
        skillId: P3_GATE_FROZEN.parentSkillId,
        skillRevision: P3_GATE_FROZEN.parentSkillRevision,
      },
      environment: {
        currentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
        currentDependencyFingerprint: stable.dependencyFingerprint,
        executionContext: "active",
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
    } as const;

    // 旧版本（v2）已 suspended ⇒ 任何上下文不可执行。
    const oldOutcome = await execute({ ...base, procedure: current });
    assert.equal(oldOutcome.outcome, "slow_path", "失效旧版本不得再执行");
    if (oldOutcome.outcome === "slow_path") {
      assert.equal(oldOutcome.decision.reason, "insufficient_evidence");
    }

    // 回滚目标（v1 恢复 active）⇒ 可执行 fast_path。
    const result = rollbackProcedure({
      current,
      stableLookup: (revision) => (revision === stable.procedureRevision ? stable : undefined),
    });
    assert.ok(result.ok);
    if (result.ok) {
      const rollbackOutcome = await execute({ ...base, procedure: result.rollbackTo });
      assert.equal(rollbackOutcome.outcome, "fast_path", "回滚目标恢复后可执行");
    }
  });
});
