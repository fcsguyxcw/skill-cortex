/**
 * Phase 6 第三批 —— ActivationProfile cue 删除级联 + 父 revision 失效（纯函数）。
 *
 * 数据合同 §4.3/§7/§8：
 * - 每 cue 可追溯（evidenceIds）、可删除：被删 evidence 命中某 cue ⇒ 该 cue 移除（受控）
 *   或 profile 非终态 suspend（仿 Phase 5 evidence-cascade 范式）；
 * - 父 Skill revision 变化 ⇒ 可复用 cue 先回 shadow 重新验证（§8：CompiledProcedure 默认
 *   失效；ActivationProfile 复用 cue 回 shadow）；
 * - 关闭 overlay 无损回静态由 rerankWithOverlay 的 overlay-off 语义保证（本模块不重复）。
 *
 * 边界：不写 store、不落盘删除/晋升事件（store.invalidate 与持久化属 batch 4）。
 */
import type { ActivationProfile } from "../core/contracts/index.ts";
import {
  transitionProfileToSuspended,
  transitionProfileToShadow,
  type ActiveActivationProfile,
  type ShadowRevertibleProfile,
  type SuspendableProfile,
} from "./state.ts";

/** 受控 reason：evidence 删除级联 suspend。 */
export const PROFILE_SUSPEND_REASON_EVIDENCE_CASCADE = "evidence_cascade_deletion" as const;
/** 受控 reason：父 revision 漂移回 shadow。 */
export const PROFILE_SHADOW_REASON_PARENT_REVISION = "revalidation:parent-revision-drift" as const;

/** 命中判定：profile 任一 cue 的 evidenceIds 与 deletedEvidenceIds 交集非空。 */
export function profileCuesReferenceEvidence(
  profile: ActivationProfile,
  deletedEvidenceIds: readonly string[],
): boolean {
  const deleted = new Set(deletedEvidenceIds);
  const cueEvidence = [
    ...profile.learnedAliases.map((cue) => cue.evidenceIds),
    ...profile.positiveExamples.map((cue) => cue.evidenceIds),
    ...profile.nearMissExamples.map((cue) => cue.evidenceIds),
    ...profile.environmentCues.map((cue) => cue.evidenceIds),
  ];
  return cueEvidence.some((evidenceIds) => evidenceIds.some((id) => deleted.has(id)));
}

export interface EvidenceDeletionCascadeResult {
  /** 被移除的 cue（可追溯删除动作；environment cue 用 key 标识）。 */
  removedCues: Array<{ cueId: string; kind: "alias" | "positive" | "near_miss" | "environment" }>;
  /** 移除后（其余 cue 保留）的 profile。 */
  profile: ActivationProfile;
}

/** 受控 cue 移除：evidenceIds 含任一被删 evidence 的 cue 从 profile 移除（返回新对象）。 */
export function removeCuesReferencingEvidence(
  profile: ActivationProfile,
  deletedEvidenceIds: readonly string[],
): EvidenceDeletionCascadeResult {
  const deleted = new Set(deletedEvidenceIds);
  const removedCues: EvidenceDeletionCascadeResult["removedCues"] = [];
  const keep = <T extends { cueId: string; evidenceIds: string[] }>(
    cues: readonly T[],
    kind: EvidenceDeletionCascadeResult["removedCues"][number]["kind"],
  ): T[] => {
    const kept: T[] = [];
    for (const cue of cues) {
      if (cue.evidenceIds.some((id) => deleted.has(id))) {
        removedCues.push({ cueId: cue.cueId, kind });
      } else {
        kept.push(cue);
      }
    }
    return kept;
  };
  const keptEnvironment: ActivationProfile["environmentCues"] = [];
  for (const cue of profile.environmentCues) {
    if (cue.evidenceIds.some((id) => deleted.has(id))) {
      removedCues.push({ cueId: cue.key, kind: "environment" });
    } else {
      keptEnvironment.push(cue);
    }
  }
  return {
    removedCues,
    profile: {
      ...profile,
      learnedAliases: keep(profile.learnedAliases, "alias"),
      positiveExamples: keep(profile.positiveExamples, "positive"),
      nearMissExamples: keep(profile.nearMissExamples, "near_miss"),
      environmentCues: keptEnvironment,
    },
  };
}

/** 非终态 profile（draft/shadow/active）命中被删 evidence ⇒ suspend（仿 procedure 级联）。 */
export function suspendProfilesForEvidenceDeletion(
  profiles: readonly SuspendableProfile[],
  deletedEvidenceIds: readonly string[],
): Array<{ profileId: string; suspended: ReturnType<typeof transitionProfileToSuspended> }> {
  const results: Array<{ profileId: string; suspended: ReturnType<typeof transitionProfileToSuspended> }> = [];
  for (const profile of profiles) {
    if (!profileCuesReferenceEvidence(profile, deletedEvidenceIds)) continue;
    results.push({
      profileId: profile.profileId,
      suspended: transitionProfileToSuspended(profile, {
        decision: "suspended",
        reason: PROFILE_SUSPEND_REASON_EVIDENCE_CASCADE,
      }),
    });
  }
  return results;
}

export interface ParentRevisionInvalidationResult {
  /** 回 shadow 重验的 profile（active → shadow；suspended/retired/draft/shadow 不变）。 */
  reverted: Array<{ profileId: string; profile: ReturnType<typeof transitionProfileToShadow> }>;
  /** 已处于重验/终态而无需回退的 profileId。 */
  unchanged: readonly string[];
}

/**
 * 父 revision 失效（§8）：currentParentRevision ≠ profile.parentSkillRevision 且 profile 为
 * active ⇒ 回 shadow 重新验证（可复用 cue 先回 shadow；CompiledProcedure 失效由 procedure
 * 状态机处理，不在此模块）。draft/shadow 已在重验路径、suspended/retired 已挂起/废弃 ⇒ 不变。
 */
export function revertProfilesForParentRevision(
  profiles: readonly ShadowRevertibleProfile[],
  currentParentRevision: string,
): ParentRevisionInvalidationResult {
  const reverted: ParentRevisionInvalidationResult["reverted"] = [];
  const unchanged: string[] = [];
  for (const profile of profiles) {
    if (profile.parentSkillRevision === currentParentRevision) {
      unchanged.push(profile.profileId);
      continue;
    }
    if (profile.status === "active") {
      reverted.push({
        profileId: profile.profileId,
        profile: transitionProfileToShadow(profile, {
          decision: "shadow",
          shadowReportId: PROFILE_SHADOW_REASON_PARENT_REVISION,
        }),
      });
    } else {
      // draft 尚未评估 / suspended 已挂起：无需回退（suspended 可经重验回 shadow）。
      unchanged.push(profile.profileId);
    }
  }
  return { reverted, unchanged };
}

export type { ActiveActivationProfile };
