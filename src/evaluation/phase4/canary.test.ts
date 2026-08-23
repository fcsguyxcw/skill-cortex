/**
 * Phase 4 project-local shadow_replay validation harness 单测（leader D3）。
 *
 * 覆盖：validated procedure 经 executor 跑冻结 held-out 集——
 * - 非 abstain 案例走快路径且类别正确（wrongFastPathRate=0）；
 * - abstain 案例由 executor 统一 procedure_abstained 回退慢路径（correctRejectionRate=1）；
 * - 分栏指标（fallbackRecoveryRate / wrongFastPathRate / correctRejectionRate）如实报告；
 * - 确定性可回放：两次运行深度相等；
 * - harness 不写用户环境（慢路径为 project-local 模拟标记）；
 * - 执行上下文门控（ADR-0012 §2）：validated procedure 只在 shadow_replay 上下文放行；
 *   canary/active 上下文与缺失上下文一律不放行（fail closed），不冒充发布、不伪造 unknown。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExecutionContext } from "../../core/contracts/index.ts";
import { execute, type ExecuteInput } from "../../runtime/executor.ts";
import { HELDOUT_CASES } from "../phase3/cases.ts";
import {
  buildCanaryValidatedProcedure,
  CANARY_EXECUTION_CONTEXT,
  createCanaryServices,
  runP3CanarySimulation,
  simulateLoadParentSkill,
} from "./canary.ts";

/** H01：uses_offset 示例（非 abstain），用于逐次 execute 的上下文门控断言。 */
const OFFSET_SQL = "SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;";

function canaryInput(
  executionContext: unknown,
  procedure = buildCanaryValidatedProcedure(),
): ExecuteInput {
  return {
    selectedSkill: {
      skillId: procedure.parentSkillId,
      skillRevision: procedure.parentSkillRevision,
    },
    procedure,
    environment: {
      currentSkillRevision: procedure.parentSkillRevision,
      currentDependencyFingerprint: procedure.dependencyFingerprint,
      executionContext,
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
  };
}

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

  it("abstain：H12–H14 由 executor 统一回退（procedure_abstained；correctRejectionRate=1）", async () => {
    const result = await runP3CanarySimulation();
    const abstainExpected = HELDOUT_CASES.filter((c) => c.expected === "abstain");
    assert.equal(result.abstainRoutedToSlowPath, abstainExpected.length);
    assert.equal(result.correctRejectionRate, 1);
    for (const perCase of result.perCase.filter((c) => c.abstained === true)) {
      assert.equal(perCase.correct, true, `${perCase.caseId} 正确 abstain 必须成立`);
      assert.equal(perCase.recovered, true, "executor 统一回退已加载慢路径");
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

  it("harness 上下文：shadow_replay + validated ⇒ 快路径放行（观察式验证，非发布）", async () => {
    const outcome = await execute(canaryInput(CANARY_EXECUTION_CONTEXT));
    assert.equal(outcome.outcome, "fast_path");
    if (outcome.outcome === "fast_path") {
      assert.equal(outcome.decision.reason, "eligible_procedure");
      assert.equal(outcome.decision.executionContext, "shadow_replay");
    }
  });

  it("validated procedure 不得冒充 canary/active：canary 与 active 上下文 ⇒ slow_path（insufficient_evidence）", async () => {
    for (const context of ["canary", "active"] as const satisfies readonly ExecutionContext[]) {
      const outcome = await execute(canaryInput(context));
      assert.equal(outcome.outcome, "slow_path", `context=${context} 不放行 validated`);
      if (outcome.outcome === "slow_path") {
        assert.equal(outcome.decision.reason, "insufficient_evidence", `context=${context}`);
        assert.equal(outcome.decision.executionContext, context, "合法输入如实记录，不伪造");
      }
    }
  });

  it("缺失上下文 ⇒ fail closed：slow_path 且 decision 输出 unknown（不伪造合法上下文）", async () => {
    const outcome = await execute(canaryInput(undefined));
    assert.equal(outcome.outcome, "slow_path");
    if (outcome.outcome === "slow_path") {
      assert.equal(outcome.decision.reason, "insufficient_evidence");
      assert.equal(outcome.decision.executionContext, "unknown");
    }
  });

  it("上下文门控不产生状态副作用：procedure 始终 validated（无 canary/active 转换）", async () => {
    const procedure = buildCanaryValidatedProcedure();
    await execute(canaryInput("canary", procedure));
    await execute(canaryInput("active", procedure));
    await execute(canaryInput(undefined, procedure));
    assert.equal(procedure.status, "validated", "harness 不得转换状态");
  });
});
