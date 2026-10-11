/**
 * Gate P4 —— validated→canary 晋升 transition 单测（纯函数，project-local）。
 *
 * 覆盖（ADR-0012 §2 / ADR-0008：canary 是显式发布动作，转换必须先发生）：
 * - validated + shadow replay 证据（evidenceIds 非空 + canary 报告绑定）⇒ canary；
 * - canary 晋升只改 status/canaryReportId（+可选 replayEvidenceIds 追加），
 *   procedureRevision/artifactHash/validationReportId 原样保留（不可变转换）；
 * - 非法转换全部拒绝（fail closed）：
 *   draft 输入 / canary 再次晋升 / 无证据 / 非 canary decision / 非法 report ID；
 * - 不把 shadow_replay 当 procedure 状态：transition 签名不接收 executionContext，
 *   产出 status 与执行上下文无关（shadow_replay 是验证方法，不是状态）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPhase3ProcedureDraft,
  transitionPhase3ProcedureCanary,
  transitionPhase3ProcedureValidation,
  type Phase3ValidatedProcedure,
} from "./index.ts";

const SKILL_HASH = "8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830";
const REFERENCE_HASH = "73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const PARENT_SKILL_ID = "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2";
const PARENT_SKILL_REVISION = "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec";
const VALIDATION_REPORT = "validation:phase3-pagination-p3-gate-2026-08-15";
const CANARY_REPORT = "canary:phase3-pagination-p4-gate-2026-08-16";

function validated(evidenceIds: string[] = ["practice:offset-1"]): Phase3ValidatedProcedure {
  const draft = buildPhase3ProcedureDraft({
    parentSkillId: PARENT_SKILL_ID,
    parentSkillRevision: PARENT_SKILL_REVISION,
    skillMdHash: SKILL_HASH,
    selectedReferenceHash: REFERENCE_HASH,
    createdAt: "2026-08-14T00:00:00.000Z",
    evidenceIds,
  });
  return transitionPhase3ProcedureValidation(draft, {
    decision: "validated",
    validationReportId: VALIDATION_REPORT,
  });
}

function canaryTransition(
  overrides: Partial<{ canaryReportId: string; decision: string }> = {},
) {
  return {
    decision: "canary",
    canaryReportId: CANARY_REPORT,
    ...overrides,
  } as Parameters<typeof transitionPhase3ProcedureCanary>[1];
}

describe("Gate P4 transition：validated → canary（显式发布动作）", () => {
  it("validated + shadow replay 证据 ⇒ canary：只改 status/canaryReportId，其余不可变保留", () => {
    const input = validated();
    const result = transitionPhase3ProcedureCanary(input, canaryTransition());

    assert.notEqual(result, input, "transition 必须返回新对象（不可变）");
    assert.equal(input.status, "validated", "原 procedure 不得被修改");
    assert.equal(result.status, "canary");
    assert.equal(result.canaryReportId, CANARY_REPORT);
    // 审计字段原样保留：validated 报告、evidence、revision/artifact 不变。
    assert.equal(result.validationReportId, VALIDATION_REPORT);
    assert.deepEqual(result.evidenceIds, ["practice:offset-1"]);
    assert.equal(result.procedureRevision, input.procedureRevision);
    assert.equal(result.artifactHash, input.artifactHash);
    assert.equal(result.parentSkillId, PARENT_SKILL_ID);
    assert.equal(result.parentSkillRevision, PARENT_SKILL_REVISION);
  });

  it("replayEvidenceIds 追加到 evidenceIds（晋升时补强证据绑定）", () => {
    const input = validated(["practice:offset-1"]);
    const result = transitionPhase3ProcedureCanary(input, {
      ...canaryTransition(),
      replayEvidenceIds: ["practice:offset-2", "practice:keyset-1"],
    });
    assert.deepEqual(result.evidenceIds, ["practice:offset-1", "practice:offset-2", "practice:keyset-1"]);
    assert.equal(input.evidenceIds.length, 1, "原对象证据不变");
  });

  it("draft 输入 ⇒ 拒绝（canary 不能跳过 validated）", () => {
    const draft = buildPhase3ProcedureDraft({
      parentSkillId: PARENT_SKILL_ID,
      parentSkillRevision: PARENT_SKILL_REVISION,
      skillMdHash: SKILL_HASH,
      selectedReferenceHash: REFERENCE_HASH,
      createdAt: "2026-08-14T00:00:00.000Z",
      evidenceIds: ["practice:offset-1"],
    });
    assert.throws(
      () => transitionPhase3ProcedureCanary(draft as never, canaryTransition()),
      /canary_transition_requires_validated_procedure/,
    );
  });

  it("canary 再次晋升（重复转换）⇒ 拒绝（运行期防御，不靠类型擦除）", () => {
    const first = transitionPhase3ProcedureCanary(validated(), canaryTransition());
    assert.throws(
      () => transitionPhase3ProcedureCanary(first as unknown as Phase3ValidatedProcedure, canaryTransition()),
      /canary_transition_requires_validated_procedure/,
    );
  });

  it("validated 无 evidenceIds（无 shadow replay 证据）⇒ 拒绝（canary 不能跳过独立验证）", () => {
    assert.throws(
      () => transitionPhase3ProcedureCanary(validated([]), canaryTransition()),
      /canary_transition_requires_evidence/,
    );
  });

  it("非 canary decision ⇒ 拒绝", () => {
    for (const decision of ["draft", "validated", "active", "suspended", "retired", "unknown"]) {
      assert.throws(
        () =>
          transitionPhase3ProcedureCanary(validated(), {
            decision,
            canaryReportId: CANARY_REPORT,
          } as never),
        /canary_transition_requires_canary_decision/,
        `decision=${decision} 必须拒绝`,
      );
    }
  });

  it("canaryReportId 格式非法（空/错误前缀/非法字符）⇒ 拒绝", () => {
    for (const bad of ["", "validation:phase3-pagination-001", "canary:", "canary:has space", "not-a-report"]) {
      assert.throws(
        () => transitionPhase3ProcedureCanary(validated(), canaryTransition({ canaryReportId: bad })),
        /canary_report_id_invalid/,
        `report=${JSON.stringify(bad)} 必须拒绝`,
      );
    }
  });

  it("确定性：同输入同输出（可回放）", () => {
    const a = transitionPhase3ProcedureCanary(validated(), canaryTransition());
    const b = transitionPhase3ProcedureCanary(validated(), canaryTransition());
    assert.deepEqual(b, a);
    assert.equal(a.status, "canary");
    assert.equal(a.canaryReportId, CANARY_REPORT);
  });

  it("不把 shadow_replay 当状态：transition 签名无 executionContext，产出与执行上下文无关", () => {
    // 编译期已由签名保证（transition 不接受 executionContext 参数）；
    // 运行期补强：无论将来在哪个上下文执行，晋升产出的 status 恒为 canary。
    const result = transitionPhase3ProcedureCanary(validated(), canaryTransition());
    assert.equal(result.status, "canary");
    assert.equal(result.canaryReportId, CANARY_REPORT);
    assert.ok(!("executionContext" in result), "procedure 不得携带执行上下文字段");
  });
});
