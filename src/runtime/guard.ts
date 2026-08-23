/**
 * Phase 4 — Guard 检查（纯函数）。
 *
 * 前置/runtime/postcondition 三类 guard 检查：任一观察为 fail 或 unknown ⇒ 停止快路径
 * （ok=false + firstFailedGuard），并把观察映射为合同形状：
 * - checkedPreconditions（ExecutionDecision.checkedPreconditions，只含 precondition 观察）；
 * - guardResults（PracticeEvent.guardResults：{predicateId, phase, result: pass|fail|unknown}）。
 *
 * 边界：观察由执行层提供，本模块不做 LLM、不执行副作用；unknown 按不满足处理（fail-closed，
 * 绝不乐观通过）。procedure 状态不被本模块修改（状态机变更属 Phase 5）。
 */
import type { CompiledProcedure, ExecutionDecision, PracticeEvent } from "../core/contracts/index.ts";

export type GuardPhase = "precondition" | "runtime" | "postcondition";
export type GuardResultValue = "pass" | "fail" | "unknown";

export interface GuardObservation {
  predicateId: string;
  phase: GuardPhase;
  /** true=pass；false=确认不满足；"unknown"=无法判定（fail-closed）。 */
  result: boolean | "unknown";
}

export interface GuardInput {
  procedure: CompiledProcedure;
  observations: ReadonlyArray<GuardObservation>;
}

export interface GuardOutcome {
  ok: boolean;
  checkedPreconditions: ExecutionDecision["checkedPreconditions"];
  guardResults: PracticeEvent["guardResults"];
  firstFailedGuard?: { predicateId: string; phase: GuardPhase };
}

/** boolean/unknown → pass/fail/unknown（映射规则冻结）。 */
export function toGuardResultValue(result: boolean | "unknown"): GuardResultValue {
  if (result === true) return "pass";
  if (result === false) return "fail";
  return "unknown";
}

/** 检查全部 guard 观察：任一 fail/unknown ⇒ 停止快路径。
 *
 * 本轮冻结（ADR-0012 + leader）：fail-closed 下沉到本函数本身——procedure 声明的每个
 * runtime guard 必须有同 phase（runtime）观察；缺失或 phase 错 ⇒ 合成 unknown 追加
 * （绝不因“没观察到”而乐观通过）。传入观察保持原顺序；声明 guard 的缺省合成追加在末尾。 */
export function checkGuards(input: GuardInput): GuardOutcome {
  const guardResults: PracticeEvent["guardResults"] = [];
  const checkedPreconditions: ExecutionDecision["checkedPreconditions"] = [];
  let firstFailedGuard: { predicateId: string; phase: GuardPhase } | undefined;

  const effective: GuardObservation[] = [...input.observations];
  const coveredRuntime = new Set<string>();
  for (const observation of input.observations) {
    if (observation.phase === "runtime") coveredRuntime.add(observation.predicateId);
  }
  // 声明 runtime guard 缺观察/phase 错 ⇒ 合成 unknown（fail-closed）。
  for (const declared of input.procedure.runtimeGuards) {
    if (!coveredRuntime.has(declared.predicateId)) {
      effective.push({ predicateId: declared.predicateId, phase: "runtime", result: "unknown" });
    }
  }

  for (const observation of effective) {
    const value = toGuardResultValue(observation.result);
    guardResults.push({
      predicateId: observation.predicateId,
      phase: observation.phase,
      result: value,
    });
    if (observation.phase === "precondition") {
      checkedPreconditions.push({
        predicateId: observation.predicateId,
        result: observation.result,
      });
    }
    if (value !== "pass" && firstFailedGuard === undefined) {
      firstFailedGuard = { predicateId: observation.predicateId, phase: observation.phase };
    }
  }

  return {
    ok: firstFailedGuard === undefined,
    checkedPreconditions,
    guardResults,
    ...(firstFailedGuard !== undefined ? { firstFailedGuard } : {}),
  };
}

/** 便捷：从 guard 检查结果构造 resolver 的 checkedPreconditions（执行期前置部分）。 */
export function checkedPreconditionsFrom(outcome: GuardOutcome): ExecutionDecision["checkedPreconditions"] {
  return outcome.checkedPreconditions;
}
