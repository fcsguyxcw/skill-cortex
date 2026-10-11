/**
 * Phase 5 slice 4 —— evidence cascade deletion 测试。
 *
 * 覆盖（plan §10 task 4 验证清单：删除 evidence 会使依赖它的 cue/procedure 重新评估或 suspend）：
 * - 级联判定（findAffectedByEvidenceDeletion）：procedure/cue 命中、无关不命中、0 影响；
 * - 失效动作（suspendProceduresForEvidenceDeletion）：validated/canary/active → suspend
 *   （reason=evidence_cascade_deletion）；终态不重复 suspend；多 procedure 共享同一
 *   evidence 全部命中；
 * - 与 store.invalidate 的契约：DeleteResult.invalidatedEventIds 即本模块输入（报告标注）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompiledProcedure } from "../../core/contracts/index.ts";
import {
  buildPhase3ProcedureDraft,
  transitionPhase3ProcedureActive,
  transitionPhase3ProcedureCanary,
  transitionPhase3ProcedureRetire,
  transitionPhase3ProcedureSuspend,
  transitionPhase3ProcedureValidation,
  type Phase3InvalidatableProcedure,
} from "./index.ts";
import {
  findAffectedByEvidenceDeletion,
  suspendProceduresForEvidenceDeletion,
  type CueEvidenceRef,
  type ProcedureEvidenceRef,
} from "./evidence-cascade.ts";

const SKILL_HASH = "8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830";
const REFERENCE_HASH = "73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const PARENT_SKILL_ID = "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2";
const PARENT_SKILL_REVISION = "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec";
const VALIDATION_REPORT = "validation:phase3-pagination-p3-gate-2026-08-15";
const CANARY_REPORT = "canary:phase3-pagination-p4-gate-2026-08-16";
const ACTIVE_REPORT = "active:phase3-pagination-p4-canary-2026-08-16";
const REASON = "source dependency drift";

const EVIDENCE_A = "practice:offset-1";
const EVIDENCE_B = "practice:keyset-1";
const EVIDENCE_C = "practice:shared-evidence";

function buildProcedure(evidenceIds: string[], overrides: { detectorVersion?: string } = {}) {
  return buildPhase3ProcedureDraft({
    parentSkillId: PARENT_SKILL_ID,
    parentSkillRevision: PARENT_SKILL_REVISION,
    skillMdHash: SKILL_HASH,
    selectedReferenceHash: REFERENCE_HASH,
    createdAt: "2026-08-14T00:00:00.000Z",
    evidenceIds,
    ...overrides,
  });
}

function validatedOf(evidenceIds = [EVIDENCE_A, EVIDENCE_B]) {
  return transitionPhase3ProcedureValidation(buildProcedure(evidenceIds), {
    decision: "validated",
    validationReportId: VALIDATION_REPORT,
  });
}

function canaryOf(evidenceIds = [EVIDENCE_A, EVIDENCE_B]) {
  return transitionPhase3ProcedureCanary(validatedOf(evidenceIds), {
    decision: "canary",
    canaryReportId: CANARY_REPORT,
  });
}

function activeOf(evidenceIds = [EVIDENCE_A, EVIDENCE_B]) {
  return transitionPhase3ProcedureActive(canaryOf(evidenceIds), {
    decision: "active",
    activeReportId: ACTIVE_REPORT,
  });
}

function suspendedOf(evidenceIds = [EVIDENCE_A, EVIDENCE_B]) {
  return transitionPhase3ProcedureSuspend(activeOf(evidenceIds), {
    decision: "suspended",
    reason: REASON,
    suspendKind: "manual",
  });
}

function retiredOf(evidenceIds = [EVIDENCE_A, EVIDENCE_B]) {
  return transitionPhase3ProcedureRetire(suspendedOf(evidenceIds), {
    decision: "retired",
    reason: REASON,
  });
}

function refOf(procedure: CompiledProcedure): ProcedureEvidenceRef {
  return { procedureId: procedure.procedureId, status: procedure.status, evidenceIds: procedure.evidenceIds };
}

function cueRef(overrides: Partial<CueEvidenceRef> = {}): CueEvidenceRef {
  return {
    profileId: "profile:test-1",
    cueId: "cue:offset-alias",
    cueKind: "learned_alias",
    evidenceIds: [EVIDENCE_A],
    ...overrides,
  };
}

describe("evidence cascade：级联判定（findAffectedByEvidenceDeletion）", () => {
  it("删除 evidence ⇒ 依赖它的 procedure 命中；无关 procedure 不命中", () => {
    const dependent = validatedOf([EVIDENCE_A]);
    const unrelated = validatedOf([EVIDENCE_C]);
    const affected = findAffectedByEvidenceDeletion([EVIDENCE_A], {
      procedures: [refOf(dependent), refOf(unrelated)],
    });
    assert.deepEqual(affected.affectedProcedureIds, [dependent.procedureId]);
  });

  it("多 procedure 共享同一 evidence ⇒ 全部命中（依赖链完整）", () => {
    const procA = validatedOf([EVIDENCE_A, EVIDENCE_C]);
    const procB = canaryOf([EVIDENCE_C]);
    const procC = activeOf([EVIDENCE_B]);
    const affected = findAffectedByEvidenceDeletion([EVIDENCE_C], {
      procedures: [refOf(procA), refOf(procB), refOf(procC)],
    });
    assert.deepEqual(
      new Set(affected.affectedProcedureIds),
      new Set([procA.procedureId, procB.procedureId]),
      "共享 EVIDENCE_C 的 procA/procB 全部命中，无关 procC 不命中",
    );
  });

  it("无依赖 ⇒ 0 影响（空结果）", () => {
    const affected = findAffectedByEvidenceDeletion([EVIDENCE_A], {
      procedures: [refOf(validatedOf([EVIDENCE_B]))],
      cues: [cueRef({ evidenceIds: [EVIDENCE_B] })],
    });
    assert.deepEqual(affected.affectedProcedureIds, []);
    assert.deepEqual(affected.affectedCues, []);
  });

  it("删除空列表 ⇒ 0 影响", () => {
    const affected = findAffectedByEvidenceDeletion([], {
      procedures: [refOf(validatedOf([EVIDENCE_A]))],
    });
    assert.deepEqual(affected.affectedProcedureIds, []);
  });

  it("cue 判定：依赖被删 evidence 的 cue 命中（含 kind/profileId）；无关 cue 不命中", () => {
    const hit = cueRef({ cueId: "cue:alias-a", cueKind: "learned_alias", evidenceIds: [EVIDENCE_A] });
    const miss = cueRef({ cueId: "cue:example-b", cueKind: "positive_example", evidenceIds: [EVIDENCE_B] });
    const affected = findAffectedByEvidenceDeletion([EVIDENCE_A], {
      cues: [hit, miss],
    });
    assert.deepEqual(affected.affectedCues, [
      { profileId: "profile:test-1", cueId: "cue:alias-a", cueKind: "learned_alias" },
    ]);
  });

  it("同一 evidence 同时命中 procedure 与 cue", () => {
    const procedure = validatedOf([EVIDENCE_A]);
    const cue = cueRef({ evidenceIds: [EVIDENCE_A] });
    const affected = findAffectedByEvidenceDeletion([EVIDENCE_A], {
      procedures: [refOf(procedure)],
      cues: [cue],
    });
    assert.deepEqual(affected.affectedProcedureIds, [procedure.procedureId]);
    assert.equal(affected.affectedCues.length, 1);
    assert.equal(affected.affectedCues[0]!.cueId, "cue:offset-alias");
  });
});

describe("evidence cascade：失效动作（suspendProceduresForEvidenceDeletion）", () => {
  it("删除 evidence ⇒ 依赖它的 validated/canary/active 均 suspend（reason=evidence_cascade_deletion）", () => {
    const cases: Array<Phase3InvalidatableProcedure> = [
      validatedOf([EVIDENCE_A]),
      canaryOf([EVIDENCE_A]),
      activeOf([EVIDENCE_A]),
    ];
    const suspended = suspendProceduresForEvidenceDeletion(cases, [EVIDENCE_A]);
    assert.equal(suspended.length, 3, "三个非终态 procedure 全部 suspend");
    for (const item of suspended) {
      assert.equal(item.status, "suspended");
      assert.equal(item.lifecycleReason, "evidence_cascade_deletion");
      assert.equal(item.procedureRevision, cases[0]!.procedureRevision, "失败不改变 artifact 版本");
    }
    // 输入不可变。
    assert.equal(cases[0]!.status, "validated");
    assert.equal(cases[2]!.status, "active");
  });

  it("无关 procedure 不 suspend（evidenceIds 不含被删 id）", () => {
    const unrelated = activeOf([EVIDENCE_B]);
    const suspended = suspendProceduresForEvidenceDeletion([unrelated], [EVIDENCE_A]);
    assert.deepEqual(suspended, []);
  });

  it("终态（suspended/retired）不重复 suspend（fail-closed）", () => {
    const suspendedInput = suspendedOf([EVIDENCE_A]);
    const retiredInput = retiredOf([EVIDENCE_A]);
    assert.throws(
      () => suspendProceduresForEvidenceDeletion([suspendedInput as never], [EVIDENCE_A]),
      /suspend_transition_requires_non_terminal_procedure/,
      "终态 suspended 不重复 suspend",
    );
    assert.throws(
      () => suspendProceduresForEvidenceDeletion([retiredInput as never], [EVIDENCE_A]),
      /suspend_transition_requires_non_terminal_procedure/,
      "终态 retired 不重复 suspend",
    );
  });

  it("多 procedure 共享同一被删 evidence ⇒ 全部 suspend（依赖链完整）", () => {
    const procA = validatedOf([EVIDENCE_A, EVIDENCE_C]);
    const procB = canaryOf([EVIDENCE_C]);
    const suspended = suspendProceduresForEvidenceDeletion([procA, procB], [EVIDENCE_C]);
    assert.equal(suspended.length, 2, "共享 EVIDENCE_C 的两个 procedure 全部 suspend");
    for (const item of suspended) assert.equal(item.status, "suspended");
  });

  it("无依赖 ⇒ 0 影响（无 suspend）", () => {
    const procedure = activeOf([EVIDENCE_B]);
    const suspended = suspendProceduresForEvidenceDeletion([procedure], [EVIDENCE_A]);
    assert.deepEqual(suspended, []);
  });

  it("确定性与可回放：同输入同输出", () => {
    const cases = [validatedOf([EVIDENCE_A]), activeOf([EVIDENCE_A])];
    assert.deepEqual(
      suspendProceduresForEvidenceDeletion(cases, [EVIDENCE_A]),
      suspendProceduresForEvidenceDeletion(cases, [EVIDENCE_A]),
    );
  });
});
