/**
 * Phase 5 slice 2 —— dependency diff 与失效（纯函数，project-local）。
 *
 * 语义（plan §10 task 1/2 + ADR-0008 + 数据合同 §3）：
 * - 指纹维度：source（sourceHash 必填）/ tool（toolSchemaHash）/ permission
 *   （permissionPolicyHash）/ environment（environmentClass）/ model+prompt
 *   （modelId/promptHash，仅含 LLM hole 的 procedure 绑定）。合同字段已覆盖全部维度，
 *   本模块不做任何字段推断或发明宿主来源。
 * - 绑定 = procedure.dependencyFingerprint 中该字段存在（sourceHash 恒绑定；其余字段
 *   存在 ⇒ 该维度构成约束）。未绑定维度（纯确定性 artifact 省略 environment/model/prompt，
 *   effectless 省略 permission）的当前值变化不失效——纯确定性 artifact 不因无关模型
 *   变化失效（plan §10 task 2）。
 * - diff：绑定字段 current ≠ 绑定值 ⇒ 该维度 impacted（current 缺失亦失配，fail-closed）。
 * - 失效：diff 命中 ≥1 个绑定维度 ⇒ 非终态（validated/canary/active）procedure suspend，
 *   reason 记录命中维度（可审计）。终态（suspended/retired）不重复 suspend（fail-closed）。
 *
 * 边界：本模块不落盘晋升/失效事件（slice 3 rollback + evidence cascade）；不修改
 * resolver/executor/observer；不启动真实宿主部署。
 */
import type { CompiledProcedure, DependencyFingerprint } from "../../core/contracts/index.ts";
import {
  SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX,
  transitionPhase3ProcedureSuspend,
  type Phase3InvalidatableProcedure,
  type Phase3SuspendedProcedure,
} from "./draft.ts";

/** 依赖指纹维度（plan §10 task 1：source/tools/permissions/environment/model+prompt）。 */
export type FingerprintDimension =
  | "source"
  | "tool"
  | "permission"
  | "environment"
  | "model"
  | "prompt";

const DIMENSION_FIELDS: ReadonlyArray<
  readonly [FingerprintDimension, keyof DependencyFingerprint]
> = [
  ["source", "sourceHash"],
  ["tool", "toolSchemaHash"],
  ["permission", "permissionPolicyHash"],
  ["environment", "environmentClass"],
  ["model", "modelId"],
  ["prompt", "promptHash"],
];

export interface DependencyDiff {
  /**
   * procedure 绑定的维度（字段存在 ⇒ 该维度构成约束；未绑定维度的当前值变化不失效）。
   * sourceHash 必填 ⇒ source 恒在绑定集。
   */
  boundDimensions: readonly FingerprintDimension[];
  /**
   * 命中维度：绑定且当前值失配（current 缺失亦失配，fail-closed——无法证明匹配即变化）。
   * 非空 ⇒ shouldInvalidate=true。
   */
  impactedDimensions: readonly FingerprintDimension[];
  /** impactedDimensions 非空 ⇒ 该 procedure 需要失效（suspend）/ 重验。 */
  shouldInvalidate: boolean;
}

/**
 * 纯函数：比较「当次当前指纹」vs「procedure 绑定指纹」，输出命中维度集。
 * 未绑定维度（如纯确定性 artifact 的 model/prompt）的当前值变化不进入 impacted，
 * 也不驱动失效——只失效相关 procedure，不让纯确定性 artifact 因无关模型变化失效。
 */
export function diffProcedureDependencies(
  procedure: CompiledProcedure,
  current: DependencyFingerprint,
): DependencyDiff {
  const boundDimensions: FingerprintDimension[] = [];
  const impactedDimensions: FingerprintDimension[] = [];
  for (const [dimension, field] of DIMENSION_FIELDS) {
    const boundValue = procedure.dependencyFingerprint[field];
    if (boundValue === undefined) continue; // 未绑定 ⇒ 不构成约束（无关变化不失效）
    boundDimensions.push(dimension);
    if (boundValue !== current[field]) impactedDimensions.push(dimension);
  }
  return {
    boundDimensions,
    impactedDimensions,
    shouldInvalidate: impactedDimensions.length > 0,
  };
}

export interface InvalidationResult {
  diff: DependencyDiff;
  /** diff 命中相关维度 ⇒ suspend 后的 procedure；未命中 ⇒ undefined（不失效）。 */
  suspended?: Phase3SuspendedProcedure;
}

/**
 * 失效编排（纯函数）：dependency diff 命中绑定维度 ⇒ 非终态 procedure suspend
 * （reason = "dependency drift: <维度>"，可审计）。未命中 ⇒ 原样返回（不失效）。
 * 输入限定非终态（validated/canary/active）；draft/suspended/retired 由
 * transitionPhase3ProcedureSuspend fail-closed 拒绝。
 */
export function invalidateOnDependencyDrift(
  procedure: Phase3InvalidatableProcedure,
  current: DependencyFingerprint,
): InvalidationResult {
  const diff = diffProcedureDependencies(procedure, current);
  if (!diff.shouldInvalidate) return { diff };
  // 受控 reason（审计文本）+ 显式 suspendKind（恢复资格判定；不靠 reason 推断）。
  const reason = `${SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX}${[...diff.impactedDimensions].join(",")}`;
  return {
    diff,
    suspended: transitionPhase3ProcedureSuspend(procedure, {
      decision: "suspended",
      reason,
      suspendKind: "dependency_drift",
    }),
  };
}
