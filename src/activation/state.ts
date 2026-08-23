/**
 * Phase 6 第三批 —— ActivationProfile 状态机（纯函数，project-local；仿 Phase 5 范式）。
 *
 * 数据合同 §6.1 状态图：
 *   draft → shadow → active → suspended → retired
 *              ↑        │         │
 *              └────────┴─────────┘ 重新验证后可回 shadow
 * - draft：induction 产出（尚未评估）；
 * - shadow：计算但不改变 active discovery（rerank overlay 仅 shadow 生效）；
 * - active：非劣门槛达到后放行（soft rerank 生效）；
 * - suspended：任一退化/安全/删除请求可 suspend；
 * - retired：废弃终态（不复活）。
 *
 * 合法边（8 条）：draft|active|suspended → shadow；shadow → active；draft|shadow|active
 * → suspended；active|suspended → retired。其余一切转换（draft→active 跳 shadow、
 * shadow→retired、suspended→active 直接复活、retired→* 复活等）fail-closed。
 *
 * 硬约束：纯函数不可变（返回新对象）；晋升/级联事件落盘（store 持久化）不在本 slice。
 */
import type { ActivationProfile } from "../core/contracts/index.ts";

export type ActivationStatus = ActivationProfile["status"];

export interface ShadowActivationProfile extends ActivationProfile {
  status: "shadow";
}
export interface ActiveActivationProfile extends ActivationProfile {
  status: "active";
}
export interface SuspendedActivationProfile extends ActivationProfile {
  status: "suspended";
}
export interface RetiredActivationProfile extends ActivationProfile {
  status: "retired";
}
export interface DraftActivationProfile extends ActivationProfile {
  status: "draft";
}

/** 可回 shadow 的来源：draft（开始 shadow）/ active / suspended（重新验证后回 shadow）。 */
export type ShadowRevertibleProfile =
  | DraftActivationProfile
  | ActiveActivationProfile
  | SuspendedActivationProfile;

/** 非终态（可被退化/删除请求 suspend）。 */
export type SuspendableProfile =
  | DraftActivationProfile
  | ShadowActivationProfile
  | ActiveActivationProfile;

/** 可废弃来源：active / suspended。 */
export type RetirableProfile = ActiveActivationProfile | SuspendedActivationProfile;

const PROFILE_ID_PATTERN = /^profile:[A-Za-z0-9._-]{1,120}$/;
const REPORT_ID_PATTERN = /^(?:shadow|promotion|revalidation):[A-Za-z0-9._-]{1,95}$/;

function requireProfileId(profile: ActivationProfile): void {
  if (!PROFILE_ID_PATTERN.test(profile.profileId)) {
    throw new TypeError("profile_id_invalid");
  }
}

function requireReportId(reportId: string): void {
  if (!REPORT_ID_PATTERN.test(reportId)) {
    throw new TypeError("profile_report_id_invalid");
  }
}

function requireReason(reason: string): string {
  if (reason.trim().length === 0) throw new TypeError("profile_lifecycle_reason_must_not_be_empty");
  if (reason.length > 200) throw new TypeError("profile_lifecycle_reason_too_long");
  return reason;
}

/** 内部：更新 status + updatedAt（不可变；时间戳调用方注入或复用 createdAt）。 */
function withStatus<T extends ActivationProfile>(
  profile: ActivationProfile,
  status: ActivationStatus,
  updatedAt: string,
): T {
  return { ...profile, status, updatedAt } as T;
}

export interface ToShadowTransition {
  decision: "shadow";
  /** shadow 回放/重新验证报告 ID（审计绑定）。 */
  shadowReportId: string;
}

/**
 * draft | active | suspended → shadow。
 * - draft→shadow：进入 shadow 回放（评估开始）；
 * - active/suspended→shadow：重新验证后回退（合同 §6.1/§8：父 revision 变化时
 *   可复用 cue 先回 shadow 重验）。非终态之外（shadow/retired）拒绝。
 */
export function transitionProfileToShadow(
  profile: ShadowRevertibleProfile,
  transition: ToShadowTransition,
): ShadowActivationProfile {
  requireProfileId(profile);
  if (
    profile.status !== "draft" &&
    profile.status !== "active" &&
    profile.status !== "suspended"
  ) {
    throw new Error("shadow_transition_requires_draft_active_or_suspended_profile");
  }
  if (transition.decision !== "shadow") {
    throw new Error("shadow_transition_requires_shadow_decision");
  }
  requireReportId(transition.shadowReportId);
  return withStatus<ShadowActivationProfile>(profile, "shadow", profile.updatedAt);
}

export interface ToActiveTransition {
  decision: "active";
  /** promotion 报告 ID（shadow→active 判定通过后绑定；审计可追溯）。 */
  promotionReportId: string;
}

/** shadow → active（promotion gate 判定通过后才允许；直接调 transition 也会经 gate）。 */
export function transitionProfileToActive(
  shadow: ShadowActivationProfile,
  transition: ToActiveTransition,
): ActiveActivationProfile {
  requireProfileId(shadow);
  if (shadow.status !== "shadow") {
    throw new Error("active_transition_requires_shadow_profile");
  }
  if (transition.decision !== "active") {
    throw new Error("active_transition_requires_active_decision");
  }
  requireReportId(transition.promotionReportId);
  return withStatus<ActiveActivationProfile>(shadow, "active", shadow.updatedAt);
}

export interface ToSuspendedTransition {
  decision: "suspended";
  /** 退化/安全/删除请求原因（必填，可审计）。 */
  reason: string;
}

/** draft | shadow | active → suspended（退化/删除级联；不可变）。 */
export function transitionProfileToSuspended(
  profile: SuspendableProfile,
  transition: ToSuspendedTransition,
): SuspendedActivationProfile {
  requireProfileId(profile);
  if (profile.status !== "draft" && profile.status !== "shadow" && profile.status !== "active") {
    throw new Error("suspend_transition_requires_non_terminal_profile");
  }
  if (transition.decision !== "suspended") {
    throw new Error("suspend_transition_requires_suspended_decision");
  }
  requireReason(transition.reason);
  return withStatus<SuspendedActivationProfile>(profile, "suspended", profile.updatedAt);
}

export interface ToRetiredTransition {
  decision: "retired";
  /** 废弃原因（必填，可审计）。 */
  reason: string;
}

/** active | suspended → retired（废弃终态，不复活）。 */
export function transitionProfileToRetired(
  profile: RetirableProfile,
  transition: ToRetiredTransition,
): RetiredActivationProfile {
  requireProfileId(profile);
  if (profile.status !== "active" && profile.status !== "suspended") {
    throw new Error("retire_transition_requires_active_or_suspended_profile");
  }
  if (transition.decision !== "retired") {
    throw new Error("retire_transition_requires_retired_decision");
  }
  requireReason(transition.reason);
  return withStatus<RetiredActivationProfile>(profile, "retired", profile.updatedAt);
}
