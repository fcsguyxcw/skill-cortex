/**
 * Phase 6 host —— Activation Memory 管线（project-local；async seams，依赖注入 store）。
 *
 * 把 component 纯函数串成真实 host 链路（observer 事件 → induction → store → shadow →
 * 受控 promotion → active → discovery overlay + cascade）：
 *
 * - `induceAndStoreShadow`：真实 verified_skill_effect/near-miss PracticeEvent → induction
 *   draft → store.save(draft) → transitionProfileToShadow 落盘（幂等：已存在不重复 save）。
 * - `evaluateProfileForPromotion`：受控 evaluator（唯一 promotion report 来源）——只包装
 *   evaluateOverlay，caller 无法注入手搓 report。
 * - `promoteProfileIfEligible`：用受控 evaluator 重算 report → evaluateProfilePromotion 判门 →
 *   通过才 transition shadow→active（report 由 store 落盘绑定；store 内部再重算 verdict 兜底）。
 * - `revertProfilesForParentRevisionChanges`：父 revision 漂移 → active profile 回 shadow
 *   （与 cascade.ts 纯函数 + store 组合；discovery 侧另有 revision 匹配防线）。
 *
 * evidence 删除级联复用 store.ts 的 `applyEvidenceDeletionCascade`（不在此重复）。
 * 边界：不写用户环境、不接生产入口、不启动 canary/active 部署；promotion report 只能
 * 来自受控 evaluator（evaluateOverlay）。
 */
import type {
  ActivationProfile,
  PracticeEvent,
  SkillRecord,
} from "../core/contracts/index.ts";
import { PROFILE_SHADOW_REASON_PARENT_REVISION } from "./cascade.ts";
import {
  evaluateOverlay,
  type EvaluateOptions,
  type EvaluationCase,
  type OverlayEvaluationReport,
} from "./evaluate.ts";
import { induceActivationProfile } from "./induction.ts";
import { evaluateProfilePromotion } from "./promotion.ts";
import {
  transitionProfileToActive,
  transitionProfileToShadow,
  type ActiveActivationProfile,
  type DraftActivationProfile,
  type ShadowActivationProfile,
} from "./state.ts";
import type { ActivationProfileStore, TriggerSource } from "./store.ts";

// ---------------------------------------------------------------------------
// 受控 evaluator（唯一 promotion report 来源）
// ---------------------------------------------------------------------------

/**
 * 受控评估：promotion report 只能来自本函数（包装 evaluateOverlay），不信任 caller 手搓
 * 报告。cases/records 由调用方注入冻结评估集（如 final-heldout），但 report 的计算
 * 与判定统一走 evaluateOverlay + evaluateProfilePromotion。
 */
export function evaluateProfileForPromotion(
  profile: ActivationProfile,
  cases: readonly EvaluationCase[],
  records: readonly SkillRecord[],
  options: EvaluateOptions = {},
): OverlayEvaluationReport {
  return evaluateOverlay(cases, records, profile, options);
}

// ---------------------------------------------------------------------------
// promotion（shadow → active，受控 report）
// ---------------------------------------------------------------------------

export type PromoteResult =
  | { ok: true; report: OverlayEvaluationReport }
  | { ok: false; reason: "promotion_gate_failed"; reasons: readonly string[] }
  | { ok: false; reason: "store_error"; error: string };

/**
 * 受控 promotion：report 由 evaluateProfileForPromotion 重算 → evaluateProfilePromotion
 * 判门 → 通过才 transition shadow→active。caller 只提供 shadow profile + 冻结评估集 +
 * reportId，无法注入手搓 report/verdict；store 内部再重算 verdict 兜底。
 */
export async function promoteProfileIfEligible(
  store: ActivationProfileStore,
  shadow: ShadowActivationProfile,
  cases: readonly EvaluationCase[],
  records: readonly SkillRecord[],
  options: EvaluateOptions,
  promotionReportId: string,
  trigger: TriggerSource = "procedure",
): Promise<PromoteResult> {
  // 受控评估集必须包含父 Skill（否则 overlay 无意义地 no-op，非劣 trivially 通过）。
  // real-skill 评估集属 Phase 7；此守卫防止"任何 profile 都能 trivial 晋升"。
  if (!records.some((record) => record.skillId === shadow.parentSkillId)) {
    return { ok: false, reason: "promotion_gate_failed", reasons: ["parent_not_in_evaluation_set"] };
  }
  const report = evaluateProfileForPromotion(shadow, cases, records, options);
  const verdict = evaluateProfilePromotion(report);
  if (!verdict.ok) {
    return { ok: false, reason: "promotion_gate_failed", reasons: verdict.reasons };
  }
  const active = transitionProfileToActive(shadow, { decision: "active", promotionReportId });
  await store.transition(shadow, active, { trigger, promotion: { report, promotionReportId } });
  return { ok: true, report };
}

// ---------------------------------------------------------------------------
// induction → draft → shadow（幂等落盘）
// ---------------------------------------------------------------------------

export type InduceResult =
  | { ok: true; profileId: string; status: ActivationProfile["status"]; created: boolean }
  | { ok: false; reason: string };

/**
 * 真实事件 → draft profile → shadow 落盘（幂等）。profile 由 profileIdOf(parent) 确定性
 * 派生；已存在（draft/shadow/active/...）⇒ 不重复 save（内容不可变，后续 promotion 单独
 * 触发）。返回 created 供调用方决定是否进一步 promotion。
 */
export async function induceAndStoreShadow(
  store: ActivationProfileStore,
  events: readonly PracticeEvent[],
  parentSkill: SkillRecord,
  shadowReportId: string,
  trigger: TriggerSource = "procedure",
): Promise<InduceResult> {
  const induced = induceActivationProfile({ events, parentSkill });
  if (!induced.ok) {
    return { ok: false, reason: induced.reason };
  }
  // induction 恒产出 status="draft"（见 induction.ts 组装处）。
  const draft = induced.profile as DraftActivationProfile;
  const existing = await store.getProfile(draft.profileId);
  if (existing !== undefined) {
    return { ok: true, profileId: draft.profileId, status: existing.status, created: false };
  }
  await store.save(draft, { trigger });
  const shadow = transitionProfileToShadow(draft, { decision: "shadow", shadowReportId });
  await store.transition(draft, shadow, { trigger, reportId: shadowReportId });
  return { ok: true, profileId: draft.profileId, status: "shadow", created: true };
}

// ---------------------------------------------------------------------------
// 父 revision 漂移 → active 回 shadow
// ---------------------------------------------------------------------------

export interface RevisionRevertOutcome {
  reverted: readonly string[];
}

/**
 * 父 revision 失效（§8 接入 cascade）：当次 currentParentRevision ≠ active profile 的
 * parentSkillRevision ⇒ active 回 shadow 重验（revalidation:parent-revision-drift）。
 * 无当次来源（currentRevisionBySkillId 缺该 skillId）⇒ 不据此回退（discovery 侧另有
 * revision 匹配硬防线，overlay 只对 revision 匹配候选生效，不会误用 stale active）。
 */
export async function revertProfilesForParentRevisionChanges(
  store: ActivationProfileStore,
  currentRevisionBySkillId: ReadonlyMap<string, string>,
  trigger: TriggerSource = "procedure",
): Promise<RevisionRevertOutcome> {
  const profiles = await store.listCurrent();
  const reverted: string[] = [];
  for (const profile of profiles) {
    if (profile.status !== "active") continue;
    const current = currentRevisionBySkillId.get(profile.parentSkillId);
    if (current === undefined) continue;
    if (current === profile.parentSkillRevision) continue;
    const revertedProfile = transitionProfileToShadow(profile as ActiveActivationProfile, {
      decision: "shadow",
      shadowReportId: PROFILE_SHADOW_REASON_PARENT_REVISION,
    });
    await store.transition(profile, revertedProfile, {
      trigger,
      reportId: PROFILE_SHADOW_REASON_PARENT_REVISION,
    });
    reverted.push(profile.profileId);
  }
  return { reverted };
}
