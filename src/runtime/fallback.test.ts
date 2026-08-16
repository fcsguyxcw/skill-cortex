/**
 * Phase 4 — guard / fallback 行为测试。
 *
 * guard：前置/runtime/postcondition 任一 fail 或 unknown ⇒ 停止快路径（ok=false +
 * firstFailedGuard）；观察映射为 checkedPreconditions（precondition 布尔）与
 * guardResults（pass/fail/unknown）。
 * fallback：no_skill_selected ⇒ abstain，其余 ⇒ load_parent_skill；stopped=true；
 * firstAttributableFailureStepId 只采纳真实引用当次 failed 步骤的候选，未知保持空。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompiledProcedure, PracticeEvent } from "../core/contracts/index.ts";
import { checkGuards, type GuardObservation } from "./guard.ts";
import { resolveFallback } from "./fallback.ts";

function makeProcedure(): CompiledProcedure {
  return {
    schemaVersion: 1,
    procedureId: "procedure:test:0000000000000000000000000000000000000000000000000000000000000001",
    parentSkillId: "skill:0000000000000000000000000000000000000000000000000000000000000001",
    parentSkillRevision: "rev:1111111111111111111111111111111111111111111111111111111111111111",
    procedureRevision: "rev:2222222222222222222222222222222222222222222222222222222222222222",
    status: "validated",
    dependencyFingerprint: { sourceHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333" },
    inputSchema: {},
    preconditions: [{ predicateId: "pre-1", description: "p" }],
    coveredSteps: [],
    forbiddenAutomationSteps: [],
    runtimeGuards: [{ predicateId: "rg-1", description: "g", beforeStepIds: ["s2"] }],
    llmHoles: [],
    declaredEffects: [],
    requiredPermissions: [],
    postconditions: [{ verifierId: "v-1", description: "post" }],
    artifactLocator: "draft://x",
    artifactHash: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    evidenceIds: [],
    validationReportId: "report:x",
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

function step(stepId: string, outcome: PracticeEvent["stepSummaries"][number]["outcome"]): PracticeEvent["stepSummaries"][number] {
  return { stepId, actor: "tool", operationClass: "tool:read", outcome };
}

describe("checkGuards", () => {
  it("全部 pass ⇒ ok=true；guardResults 映射为 pass；checkedPreconditions 只含 precondition", () => {
    const observations: GuardObservation[] = [
      { predicateId: "pre-1", phase: "precondition", result: true },
      { predicateId: "rg-1", phase: "runtime", result: true },
    ];
    const outcome = checkGuards({ procedure: makeProcedure(), observations });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.firstFailedGuard, undefined);
    assert.deepEqual(outcome.checkedPreconditions, [{ predicateId: "pre-1", result: true }]);
    assert.deepEqual(outcome.guardResults, [
      { predicateId: "pre-1", phase: "precondition", result: "pass" },
      { predicateId: "rg-1", phase: "runtime", result: "pass" },
    ]);
  });

  it("任一 fail ⇒ ok=false + firstFailedGuard（首个失败）", () => {
    const outcome = checkGuards({
      procedure: makeProcedure(),
      observations: [
        { predicateId: "pre-1", phase: "precondition", result: true },
        { predicateId: "rg-1", phase: "runtime", result: false },
      ],
    });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.firstFailedGuard, { predicateId: "rg-1", phase: "runtime" });
    assert.equal(outcome.guardResults[1]!.result, "fail");
  });

  it("unknown 视为不满足（fail-closed）：ok=false", () => {
    const outcome = checkGuards({
      procedure: makeProcedure(),
      observations: [{ predicateId: "rg-1", phase: "runtime", result: "unknown" }],
    });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.firstFailedGuard, { predicateId: "rg-1", phase: "runtime" });
  });

  it("postcondition fail ⇒ 停止快路径", () => {
    const outcome = checkGuards({
      procedure: makeProcedure(),
      observations: [
        { predicateId: "pre-1", phase: "precondition", result: true },
        { predicateId: "post-1", phase: "postcondition", result: false },
      ],
    });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.firstFailedGuard, { predicateId: "post-1", phase: "postcondition" });
  });

  it("空观察 ⇒ ok=true（仅当无声明 runtime guard 需检查）", () => {
    const procedure = { ...makeProcedure(), runtimeGuards: [] };
    const outcome = checkGuards({ procedure, observations: [] });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.checkedPreconditions, []);
    assert.deepEqual(outcome.guardResults, []);
  });

  it("声明 runtime guard 缺观察 ⇒ 合成 unknown 追加 ⇒ ok=false（修正空观察错误 PASS）", () => {
    const procedure = makeProcedure(); // 声明 rg-1
    const outcome = checkGuards({ procedure, observations: [] });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.guardResults, [
      { predicateId: "rg-1", phase: "runtime", result: "unknown" },
    ]);
    assert.deepEqual(outcome.firstFailedGuard, { predicateId: "rg-1", phase: "runtime" });
  });

  it("同 predicate 但 phase 非 runtime ⇒ 视为 runtime 缺失并追加 unknown；传入观察保持原顺序", () => {
    const procedure = makeProcedure(); // 声明 rg-1（runtime）
    const outcome = checkGuards({
      procedure,
      observations: [
        { predicateId: "pre-1", phase: "precondition", result: true },
        { predicateId: "rg-1", phase: "precondition", result: true }, // phase 错：不算 runtime 观察
      ],
    });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.guardResults, [
      { predicateId: "pre-1", phase: "precondition", result: "pass" },
      { predicateId: "rg-1", phase: "precondition", result: "pass" },
      { predicateId: "rg-1", phase: "runtime", result: "unknown" }, // 追加在末尾
    ]);
    assert.deepEqual(outcome.firstFailedGuard, { predicateId: "rg-1", phase: "runtime" });
  });
});

describe("resolveFallback", () => {
  it("no_skill_selected ⇒ fallback=abstain；其余失败类别 ⇒ load_parent_skill", () => {
    const abstain = resolveFallback({ reason: "no_skill_selected", steps: [] });
    assert.equal(abstain.fallbackMode, "abstain");
    for (const reason of ["no_procedure", "revision_mismatch", "dependency_mismatch", "precondition_failed", "guard_failure", "verifier_failure", "procedure_error", "procedure_abstained", "unknown"] as const) {
      const outcome = resolveFallback({ reason, steps: [] });
      assert.equal(outcome.fallbackMode, "load_parent_skill", `reason=${reason}`);
    }
    assert.equal(abstain.stopped, true);
  });

  it("stopped=true：本模块只做决策，调用方须在副作用前停止", () => {
    const outcome = resolveFallback({ reason: "guard_failure", steps: [] });
    assert.equal(outcome.stopped, true);
  });

  it("firstAttributableFailureStepId：候选真实引用当次 failed 步骤才采纳", () => {
    const steps = [step("s1", "ok"), step("s2", "failed"), step("s3", "unknown")];
    const outcome = resolveFallback({
      reason: "procedure_error",
      steps,
      candidateFailurePoint: "s2",
    });
    assert.equal(outcome.firstAttributableFailureStepId, "s2");
  });

  it("firstAttributableFailureStepId：候选引用非 failed 步骤 / 不存在步骤 / 缺失 ⇒ 空（不猜）", () => {
    const steps = [step("s1", "ok"), step("s2", "failed")];
    const okStep = resolveFallback({ reason: "procedure_error", steps, candidateFailurePoint: "s1" });
    assert.equal(okStep.firstAttributableFailureStepId, undefined, "ok 步骤不能作为失败点");
    const missing = resolveFallback({ reason: "procedure_error", steps, candidateFailurePoint: "s99" });
    assert.equal(missing.firstAttributableFailureStepId, undefined, "不存在的步骤不能作为失败点");
    const none = resolveFallback({ reason: "guard_failure", steps });
    assert.equal(none.firstAttributableFailureStepId, undefined, "无候选保持空");
  });
});
