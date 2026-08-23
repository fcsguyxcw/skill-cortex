/**
 * Gate P4 —— project-local canary 上下文 gate 测试（ADR-0012 §2 状态矩阵 + 安全/回退/恢复）。
 *
 * 覆盖：
 * - 晋升：buildCanaryProcedure 显式 validated→canary（绑定 shadow replay 报告，证据非空）；
 * - canary 上下文 + canary 状态 ⇒ 冻结 held-out 集全通过（分栏指标：wrongFastPathRate=0、
 *   correctRejectionRate=1、safetyStopCount=0）；
 * - 上下文×状态矩阵：validated 进不了 canary 上下文（insufficient_evidence，转换必须先发生）；
 *   canary 可被 shadow_replay 回放；canary 进不了 active；unknown fail closed；
 * - 安全：重复调用无重复非幂等 effect（两次 gate run 深度相等）+ sideEffectCount=0
 *   （executor safety_stop 门保证：非 0 不会 fast_path）；
 * - 执行不产生状态副作用：execute 后 procedure 仍 canary（不自我发布）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompiledProcedure, ExecutionContext } from "../../core/contracts/index.ts";
import { execute, type ExecuteInput } from "../../runtime/executor.ts";
import { HELDOUT_CASES } from "../phase3/cases.ts";
import { P3_GATE_FROZEN } from "../phase3/p3-gate-runner.ts";
import {
  buildCanaryProcedure,
  buildCanaryValidatedProcedure,
  CANARY_EXECUTION_CONTEXT,
  CANARY_GATE_EXECUTION_CONTEXT,
  CANARY_GATE_REPORT_ID,
  createCanaryServices,
  runP3CanaryGateSimulation,
} from "./canary.ts";

const OFFSET_SQL = "SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;";

/** 以给定 procedure + 上下文构造单次 execute 输入（与 shadow harness 同构）。 */
function gateInput(
  executionContext: unknown,
  procedure: CompiledProcedure = buildCanaryProcedure(),
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

describe("Gate P4：project-local canary（canary 上下文）", () => {
  it("晋升：validated→canary 显式转换，绑定 shadow replay 报告 + 非空证据", () => {
    const procedure = buildCanaryProcedure();
    assert.equal(procedure.status, "canary");
    assert.equal(procedure.canaryReportId, CANARY_GATE_REPORT_ID);
    assert.ok(procedure.evidenceIds.length > 0, "canary 晋升必须绑定 shadow replay 证据");
    assert.deepEqual(procedure.evidenceIds, [...P3_GATE_FROZEN.eventIds]);
    assert.equal(procedure.validationReportId, P3_GATE_FROZEN.validationReportId, "validated 报告保留");
  });

  it("canary 上下文 + canary 状态：冻结 held-out 集全通过，分栏指标如实（safetyStopCount=0）", async () => {
    const result = await runP3CanaryGateSimulation();
    assert.equal(result.total, HELDOUT_CASES.length);
    const nonAbstain = HELDOUT_CASES.filter((c) => c.expected !== "abstain");
    assert.equal(result.fastPathCount, nonAbstain.length, "非 abstain 全部走快路径");
    assert.equal(result.wrongFastPathRate, 0, "无错误快路径");
    const abstainExpected = HELDOUT_CASES.filter((c) => c.expected === "abstain");
    assert.equal(result.abstainRoutedToSlowPath, abstainExpected.length);
    assert.equal(result.correctRejectionRate, 1, "应 abstain 全部正确拒绝");
    assert.equal(result.fallbackCount, 0);
    assert.equal(result.deniedCount, 0);
    // Gate P4 安全栏：无 safety_stop（sideEffectCount≠0 / artifact 非法均不得出现）。
    assert.equal(result.safetyStopCount, 0);
    assert.equal(result.fallbackRecoveryRate, "N/A", "无 fallback ⇒ 恢复率 N/A，不虚报");
    for (const perCase of result.perCase.filter((c) => c.outcome === "fast_path")) {
      assert.equal(perCase.correct, true, `${perCase.caseId} 快路径分类必须正确`);
    }
    for (const perCase of result.perCase.filter((c) => c.abstained === true)) {
      assert.equal(perCase.correct, true, `${perCase.caseId} 正确 abstain 必须成立`);
      assert.equal(perCase.recovered, true, "回退后慢路径已加载（恢复证据）");
    }
  });

  it("逐次 execute：canary 上下文 + canary 状态 ⇒ fast_path，decision 如实记录 executionContext=canary", async () => {
    const outcome = await execute(gateInput(CANARY_GATE_EXECUTION_CONTEXT));
    assert.equal(outcome.outcome, "fast_path");
    if (outcome.outcome === "fast_path") {
      assert.equal(outcome.decision.reason, "eligible_procedure");
      assert.equal(outcome.decision.executionContext, "canary");
      const finding = outcome.result as { class: string };
      assert.equal(finding.class, "uses_offset");
    }
  });

  it("矩阵：validated 不得直接进 canary 上下文（转换必须先发生 ⇒ insufficient_evidence）", async () => {
    const outcome = await execute(gateInput(CANARY_GATE_EXECUTION_CONTEXT, buildCanaryValidatedProcedure()));
    assert.equal(outcome.outcome, "slow_path", "validated 在 canary 上下文不放行");
    if (outcome.outcome === "slow_path") {
      assert.equal(outcome.decision.reason, "insufficient_evidence");
      assert.equal(outcome.decision.executionContext, "canary", "合法上下文如实记录，不伪造");
    }
  });

  it("矩阵：canary 状态可被 shadow_replay 上下文回放（验证方法覆盖已发布状态）", async () => {
    const outcome = await execute(gateInput(CANARY_EXECUTION_CONTEXT));
    assert.equal(outcome.outcome, "fast_path", "shadow_replay 可回放 canary 状态");
    if (outcome.outcome === "fast_path") {
      assert.equal(outcome.decision.executionContext, "shadow_replay");
    }
  });

  it("矩阵：canary 状态进不了 active 上下文（限量发布，不冒充正式执行）", async () => {
    const outcome = await execute(gateInput("active" as ExecutionContext));
    assert.equal(outcome.outcome, "slow_path", "canary 在 active 上下文不放行");
    if (outcome.outcome === "slow_path") {
      assert.equal(outcome.decision.reason, "insufficient_evidence");
      assert.equal(outcome.decision.executionContext, "active");
    }
  });

  it("矩阵：缺失/非法上下文 ⇒ fail closed（unknown，不伪造合法上下文）", async () => {
    for (const context of [undefined, "bogus", ""]) {
      const outcome = await execute(gateInput(context));
      assert.equal(outcome.outcome, "slow_path", `context=${String(context)} 必须 fail closed`);
      if (outcome.outcome === "slow_path") {
        assert.equal(outcome.decision.reason, "insufficient_evidence");
        assert.equal(outcome.decision.executionContext, "unknown");
      }
    }
  });

  it("安全：重复调用无重复非幂等 effect —— 两次 gate run 深度相等 + 无 safety_stop", async () => {
    const first = await runP3CanaryGateSimulation();
    const second = await runP3CanaryGateSimulation();
    assert.deepEqual(second, first, "确定性可回放：同输入同输出，无重复非幂等副作用");
    assert.equal(first.safetyStopCount, 0);
    assert.equal(second.safetyStopCount, 0);
  });

  it("执行不产生状态副作用：canary 上下文 execute 后 procedure 仍 canary（不自我发布）", async () => {
    const procedure = buildCanaryProcedure();
    await execute(gateInput(CANARY_GATE_EXECUTION_CONTEXT, procedure));
    await execute(gateInput("active", procedure));
    await execute(gateInput(undefined, procedure));
    assert.equal(procedure.status, "canary", "执行不得转换状态（发布动作是显式 transition）");
    assert.equal(procedure.canaryReportId, CANARY_GATE_REPORT_ID);
  });
});
