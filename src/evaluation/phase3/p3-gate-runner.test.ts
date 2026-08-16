/**
 * Gate P3 正式闭环单测：整链用【真实】PracticeEvent（project-local Store，非 fixture）。
 *
 * 覆盖：
 * - 整链：读真实事件 → induction 绑定冻结值 → resolvePracticeEvidence（≥2 distinct real）
 *   → cost evidence（validate PASS）→ held-out replay → source binding → judgePromotion
 *   11/11 PASS → decision=validated → transition draft→validated；
 * - 确定性可回放：两次运行（剥离 measuredAt）深度相等；
 * - validated procedure 结构：status=validated、validationReportId 合法格式、
 *   evidenceIds=冻结的真实事件 ID、coveredSteps 引用 detect-offset-pagination。
 *
 * 依赖：本工作区 runtime 生成的真实事件（.skill-cortex/practice，gitignored）。
 * 事件缺失时测试如实失败（证据门控，不伪造数据）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PAGINATION_DETECTOR_SCHEMA_VERSION, PAGINATION_DETECTOR_VERSION } from "../../procedures/phase3/detector.ts";
import { P3_GATE_FROZEN, runP3GateValidation, type P3GateResult } from "./p3-gate-runner.ts";

function withoutTimestamp(result: P3GateResult): Omit<P3GateResult, "measuredAt"> {
  const { measuredAt: _measuredAt, ...rest } = result;
  return rest;
}

const VALIDATION_REPORT_ID_RE = /^validation:[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

describe("P3 Gate 正式闭环（真实 PracticeEvent）", () => {
  it("整链 11/11 门 PASS + decision=validated + transition draft→validated", async () => {
    const result = await runP3GateValidation();
    assert.equal(result.allPreconditionsOk, true, JSON.stringify(result.steps));
    for (const [key, step] of Object.entries(result.steps)) {
      assert.equal(step.ok, true, `${key}: ${step.detail}`);
    }
    assert.equal(result.gates?.length, 11, "judgePromotion 必须输出 11 门");
    for (const gate of result.gates!) {
      assert.equal(gate.status, "pass", `[${gate.gateId}] ${gate.detail}`);
    }
    assert.equal(result.decision, "validated");
    assert.ok(result.validatedProcedure, "validated 时必须执行 transition");
    assert.equal(result.validatedProcedure!.status, "validated");
    assert.equal(
      result.validatedProcedure!.validationReportId,
      P3_GATE_FROZEN.validationReportId,
    );
  });

  it("real events 绑定冻结值：draft evidenceIds=冻结真实事件 ID；coveredSteps 引用 detect-offset-pagination", async () => {
    const result = await runP3GateValidation();
    assert.equal(result.allPreconditionsOk, true);
    assert.ok(result.draft);
    const draft = result.draft!;
    assert.equal(draft.parentSkillId, P3_GATE_FROZEN.parentSkillId);
    assert.equal(draft.parentSkillRevision, P3_GATE_FROZEN.parentSkillRevision);
    assert.equal(draft.sourceBindings.skillMdHash, P3_GATE_FROZEN.sourceHash);
    assert.equal(draft.sourceBindings.selectedReferenceHash, P3_GATE_FROZEN.selectedReferenceHash);
    assert.deepEqual(draft.evidenceIds, [...P3_GATE_FROZEN.eventIds].sort());
    assert.equal(draft.coveredSteps[0]!.stepId, P3_GATE_FROZEN.requiredOperationClass);
    assert.equal(
      draft.sourceBindings.detectorSchemaVersion,
      PAGINATION_DETECTOR_SCHEMA_VERSION,
    );
    assert.equal(draft.sourceBindings.detectorVersion, PAGINATION_DETECTOR_VERSION);
  });

  it("evidence assessment：2 条 distinct store-verified real 事件", async () => {
    const result = await runP3GateValidation();
    assert.equal(result.allPreconditionsOk, true);
    assert.ok(result.evidenceAssessment);
    assert.equal(result.evidenceAssessment!.ok, true);
    assert.equal(result.evidenceAssessment!.distinctRealCount, 2);
    assert.deepEqual(
      [...result.evidenceAssessment!.eventIds].sort(),
      [...P3_GATE_FROZEN.eventIds].sort(),
    );
  });

  it("cost evidence 来自冻结 cost benchmark 报告且 validate PASS", async () => {
    const result = await runP3GateValidation();
    assert.equal(result.allPreconditionsOk, true);
    assert.ok(result.realCostEvidence);
    assert.equal(result.realCostEvidence!.unit, "latency_ms");
    assert.equal(result.realCostEvidence!.sampleSize, 45);
    assert.ok(result.realCostEvidence!.nBreakEven > 0 && result.realCostEvidence!.nBreakEven <= 10);
  });

  it("确定性可回放：两次运行（剥离 measuredAt）深度相等", async () => {
    const first = withoutTimestamp(await runP3GateValidation());
    const second = withoutTimestamp(await runP3GateValidation());
    assert.deepEqual(second, first, "同一 store 状态 + 冻结输入 → 同一结果");
  });

  it("validated procedure 结构：validationReportId 合法、evidenceIds 保留、coveredSteps 引用 operation", async () => {
    const result = await runP3GateValidation();
    assert.equal(result.allPreconditionsOk, true);
    const validated = result.validatedProcedure!;
    assert.match(validated.validationReportId, VALIDATION_REPORT_ID_RE);
    assert.deepEqual(validated.evidenceIds, [...P3_GATE_FROZEN.eventIds].sort());
    assert.deepEqual(validated.coveredSteps.map((s) => s.stepId), [
      P3_GATE_FROZEN.requiredOperationClass,
    ]);
    assert.equal(validated.status, "validated");
    assert.ok(validated.procedureId.startsWith("procedure:phase3-pagination:"));
    assert.ok(validated.procedureRevision.startsWith("rev:"));
  });
});
