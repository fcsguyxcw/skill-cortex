/**
 * Phase 4 — Fallback（纯函数）。
 *
 * 安全停止 + 回退决策：任何 guard/verifier/procedure 失败在产生进一步副作用前停止，
 * 回退到父 SKILL.md 慢路径（load_parent_skill）或合法 abstain，并尽力给出首个可归因
 * 失败步骤。
 *
 * firstAttributableFailureStepId 边界（data-contracts §4.4/§9）：
 * - 候选失败点只有真实引用当次 stepSummaries 中 outcome="failed" 的 stepId 时才采纳；
 * - 未知/无失败步骤 ⇒ 保持空（绝不猜测）。
 *
 * 本模块不执行副作用、不修改 procedure 状态、不生成 proposal（ADR-0008：当前调用只能
 * 回退并产生修订 proposal，不得自我发布）。
 */
import type { ExecutionDecision, PracticeEvent } from "../core/contracts/index.ts";

/** 触发回退的失败类别（resolver reason 之外的执行期失败）。 */
export type FallbackReason =
  | ExecutionDecision["reason"]
  | "guard_failure"
  | "verifier_failure"
  | "procedure_error"
  | "unknown";

export interface FallbackInput {
  reason: FallbackReason;
  /** 当次执行的步骤快照（用于 firstAttributableFailureStepId 引用校验）。 */
  steps: ReadonlyArray<PracticeEvent["stepSummaries"][number]>;
  /** 候选失败点：guard predicateId 或 stepId；必须真实引用失败步骤才采纳。 */
  candidateFailurePoint?: string;
}

export interface FallbackOutcome {
  fallbackMode: ExecutionDecision["fallbackMode"];
  /** 是否在产生进一步副作用前安全停止。 */
  stopped: boolean;
  /** 首个可归因失败步骤（仅当引用当次步骤中的 failed 步骤；否则省略）。 */
  firstAttributableFailureStepId?: string;
}

/** no_skill_selected ⇒ 合法 abstain（无父 Skill 可回退）。 */
function fallbackModeFor(reason: FallbackReason): ExecutionDecision["fallbackMode"] {
  return reason === "no_skill_selected" ? "abstain" : "load_parent_skill";
}

/** 候选失败点必须是当次步骤中 outcome="failed" 的 stepId；否则不采纳（不猜）。 */
function attributableFailureStep(
  candidate: string | undefined,
  steps: ReadonlyArray<PracticeEvent["stepSummaries"][number]>,
): string | undefined {
  if (candidate === undefined) return undefined;
  const failedStep = steps.find((step) => step.stepId === candidate && step.outcome === "failed");
  return failedStep?.stepId;
}

export function resolveFallback(input: FallbackInput): FallbackOutcome {
  const firstAttributableFailureStepId = attributableFailureStep(
    input.candidateFailurePoint,
    input.steps,
  );
  return {
    fallbackMode: fallbackModeFor(input.reason),
    stopped: true, // 本模块只做决策；调用方必须确保在副作用前调用并停止执行
    ...(firstAttributableFailureStepId !== undefined ? { firstAttributableFailureStepId } : {}),
  };
}
