/**
 * Phase 4 project-local canary 单测。
 *
 * 覆盖：validated procedure 经 executor 跑冻结 held-out 集——
 * - 非 abstain 案例走快路径且类别正确（wrongFastPathRate=0）；
 * - abstain 案例路由到慢路径（correctRejectionRate=1）；
 * - 分栏指标（fallbackRecoveryRate / wrongFastPathRate / correctRejectionRate）如实报告；
 * - 确定性可回放：两次运行深度相等；
 * - canary 不写用户环境（慢路径为 project-local 模拟标记）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HELDOUT_CASES } from "../phase3/cases.ts";
import {
  buildCanaryValidatedProcedure,
  runP3CanarySimulation,
  simulateLoadParentSkill,
} from "./canary.ts";

describe("P3 project-local canary", () => {
  it("快路径：非 abstain held-out 案例全部 fast_path 且类别正确（wrongFastPathRate=0）", async () => {
    const result = await runP3CanarySimulation();
    assert.equal(result.total, HELDOUT_CASES.length);
    const nonAbstain = HELDOUT_CASES.filter((c) => c.expected !== "abstain");
    assert.equal(result.fastPathCount, nonAbstain.length, `非 abstain ${nonAbstain.length} 例必须走快路径`);
    assert.equal(result.wrongFastPathRate, 0);
    for (const perCase of result.perCase.filter((c) => c.outcome === "fast_path")) {
      assert.equal(perCase.correct, true, `${perCase.caseId} 快路径分类必须正确`);
    }
  });

  it("abstain：H12–H14 路由到慢路径（correctRejectionRate=1）", async () => {
    const result = await runP3CanarySimulation();
    const abstainExpected = HELDOUT_CASES.filter((c) => c.expected === "abstain");
    assert.equal(result.abstainRoutedToSlowPath, abstainExpected.length);
    assert.equal(result.correctRejectionRate, 1);
    for (const perCase of result.perCase.filter((c) => c.outcome === "abstain_routed_slow")) {
      assert.equal(perCase.correct, true, `${perCase.caseId} 正确 abstain 必须成立`);
    }
  });

  it("分栏指标：fallback/denied 在本冻结集为 0（防御路径由 executor 单测覆盖）", async () => {
    const result = await runP3CanarySimulation();
    assert.equal(result.fallbackCount, 0);
    assert.equal(result.deniedCount, 0);
    assert.equal(result.fallbackRecoveryRate, "N/A", "无 fallback ⇒ 恢复率 N/A，不虚报");
  });

  it("确定性可回放：两次运行深度相等", async () => {
    const first = await runP3CanarySimulation();
    const second = await runP3CanarySimulation();
    assert.deepEqual(second, first);
  });

  it("validated procedure 冻结构造 + 慢路径为 project-local 模拟（不写用户环境）", () => {
    const procedure = buildCanaryValidatedProcedure();
    assert.equal(procedure.status, "validated");
    assert.equal(procedure.coveredSteps[0]!.stepId, "detect-offset-pagination");
    const slow = simulateLoadParentSkill();
    assert.equal(slow.loaded, true);
    assert.match(slow.skillMdBody ?? "", /project-local canary slow-path simulation/);
  });
});
