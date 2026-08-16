/**
 * Phase 5 slice 4 —— evidence cascade deletion（纯函数，project-local）。
 *
 * 数据合同 §7：学到的 cue、procedure 与其 evidence references 必须支持级联删除。
 * §9 验收：ActivationProfile 和 Procedure 均可按 evidence 删除、暂停与回滚。
 *
 * 语义：
 * - 级联判定（findAffectedByEvidenceDeletion）：给定被删除 evidence ids + 注入的
 *   procedures/cues 依赖引用（函数不持有 registry），找出 evidenceIds 含任一被删
 *   evidence 的 procedure 与 cue；
 * - 失效动作（suspendProceduresForEvidenceDeletion）：命中 procedure 若非终态
 *   （validated/canary/active）→ suspend（reason=evidence_cascade_deletion，复用
 *   slice 2 suspend 边）；终态（suspended/retired）不重复 suspend（fail-closed）；
 * - cue 失效语义：数据合同 §4.3/§6.1 要求 cue 可删除、删除请求可使 profile suspended。
 *   本模块只做命中判定（profileId + cueId + kind），profile 挂起/重新评估由 profile
 *   管道消费（当前无 profile 状态机模块，见报告：未接线项）。
 *
 * 边界：本模块不落盘删除/失效事件（store.invalidate 已提供删除持久化 seam，返回真实
 * 删除 ids 供本模块消费；调用方组合两者，本模块不新造管道）。不修改 resolver/executor/
 * observer；不启动真实宿主部署。
 */
import type { CompiledProcedure } from "../../core/contracts/index.ts";
import {
  transitionPhase3ProcedureSuspend,
  type Phase3InvalidatableProcedure,
  type Phase3SuspendedProcedure,
} from "./draft.ts";

/** procedure 的 evidence 依赖引用（注入；不持有 registry）。 */
export interface ProcedureEvidenceRef {
  procedureId: string;
  /** 非终态才可能被 suspend（终态在失效动作层 fail-closed）。 */
  status: CompiledProcedure["status"];
  evidenceIds: readonly string[];
}

/** cue 的 evidence 依赖引用（注入；调用方从 ActivationProfile 扁平化）。 */
export interface CueEvidenceRef {
  /** cue 归属 profile（数据合同 §4.3：cue 属于 ActivationProfile）。 */
  profileId: string;
  cueId: string;
  cueKind: "learned_alias" | "positive_example" | "near_miss" | "environment_cue";
  evidenceIds: readonly string[];
}

/** 级联命中 cue（供 profile 层重新评估/suspend）。 */
export interface CueHit {
  profileId: string;
  cueId: string;
  cueKind: CueEvidenceRef["cueKind"];
}

export interface EvidenceCascadeAffected {
  /** evidenceIds 含任一被删 evidence 的 procedure（procedureId；可重复出现在多个调用）。 */
  affectedProcedureIds: readonly string[];
  /** 依赖被删 evidence 的 cue。 */
  affectedCues: readonly CueHit[];
}

/**
 * 级联判定（纯函数）：给定被删除 evidence ids，找出依赖它们的 procedure 与 cue。
 * - procedure 命中：evidenceIds 与 deletedEvidenceIds 交集非空；
 * - cue 命中：同上（cue 的 evidenceIds）；
 * - 无依赖 ⇒ 空结果（0 影响）。
 * 判定不修改任何对象；失效动作由 suspendProceduresForEvidenceDeletion 执行。
 */
export function findAffectedByEvidenceDeletion(
  deletedEvidenceIds: readonly string[],
  dependencies: {
    procedures?: readonly ProcedureEvidenceRef[];
    cues?: readonly CueEvidenceRef[];
  },
): EvidenceCascadeAffected {
  const deleted = new Set(deletedEvidenceIds);
  const affectedProcedureIds: string[] = [];
  for (const procedure of dependencies.procedures ?? []) {
    if (procedure.evidenceIds.some((id) => deleted.has(id))) {
      affectedProcedureIds.push(procedure.procedureId);
    }
  }
  const affectedCues: CueHit[] = [];
  for (const cue of dependencies.cues ?? []) {
    if (cue.evidenceIds.some((id) => deleted.has(id))) {
      affectedCues.push({ profileId: cue.profileId, cueId: cue.cueId, cueKind: cue.cueKind });
    }
  }
  return { affectedProcedureIds, affectedCues };
}

/**
 * 失效动作（纯函数不可变）：evidenceIds 含任一被删 evidence 的非终态 procedure
 * （validated/canary/active）→ suspend（reason=evidence_cascade_deletion，可审计）。
 * - 无关 procedure 不 suspend；
 * - 终态（suspended/retired）不在输入集（类型 + 运行期防御 fail-closed，不重复 suspend）；
 * - 返回新副本，输入对象不可变。
 */
export function suspendProceduresForEvidenceDeletion(
  procedures: readonly Phase3InvalidatableProcedure[],
  deletedEvidenceIds: readonly string[],
): Phase3SuspendedProcedure[] {
  const deleted = new Set(deletedEvidenceIds);
  const suspended: Phase3SuspendedProcedure[] = [];
  for (const procedure of procedures) {
    if (!procedure.evidenceIds.some((id) => deleted.has(id))) continue;
    suspended.push(
      transitionPhase3ProcedureSuspend(procedure, {
        decision: "suspended",
        reason: "evidence_cascade_deletion",
      }),
    );
  }
  return suspended;
}
