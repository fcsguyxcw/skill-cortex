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
import {
  buildFrozenEvaluation,
  evaluateProfilePromotion,
  FROZEN_PROMOTION_OVERLAY,
  FROZEN_REQUIRED_COLUMNS,
  type FrozenEvaluation,
} from "./promotion.ts";

// 供 host-integration-entry 直接 import（保持 host.ts 导出面兼容）。
export { buildFrozenEvaluation, FROZEN_PROMOTION_OVERLAY, type FrozenEvaluation };
import {
  transitionProfileToActive,
  transitionProfileToShadow,
  type ActiveActivationProfile,
  type DraftActivationProfile,
  type ShadowActivationProfile,
} from "./state.ts";
import { applyEvidenceDeletionCascade, type ActivationProfileStore, type TriggerSource } from "./store.ts";

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
 * Phase 7 Seam 3 —— 冻结 real-skill 评估 provider（promotion 不接受任意 caller 自定义评估集）。
 * 冻结评估集（buildFrozenEvaluation）/ overlay 参数（FROZEN_PROMOTION_OVERLAY）已下沉到
 * promotion.ts（供 store 自身重算 verdict，见 store.ts 的 #assertPromotionVerdict），此处重导出。
 * promoteProfileIfEligible 只接受 (store, shadow, catalogRecords, reportId, trigger)，caller
 * 无法注入手搓评估集/report/verdict。
 */

/**
 * 受控 promotion（冻结评估集）：caller 只传 catalogRecords；report/verdict 由 store 在
 * promotion 边用落盘 profile + records 自行重算（不可拼接绕过），host 侧只做前置短路的
 * 诚实提示。store 内部再重算兜底。
 */
export async function promoteProfileIfEligible(
  store: ActivationProfileStore,
  shadow: ShadowActivationProfile,
  catalogRecords: readonly SkillRecord[],
  promotionReportId: string,
  trigger: TriggerSource = "procedure",
): Promise<PromoteResult> {
  const { cases } = buildFrozenEvaluation(shadow, catalogRecords);
  if (cases.length === 0) {
    return { ok: false, reason: "promotion_gate_failed", reasons: ["parent_not_in_evaluation_set"] };
  }
  const report = evaluateProfileForPromotion(shadow, cases, catalogRecords, FROZEN_PROMOTION_OVERLAY);
  const verdict = evaluateProfilePromotion(report, { requiredColumns: FROZEN_REQUIRED_COLUMNS });
  if (!verdict.ok) {
    return { ok: false, reason: "promotion_gate_failed", reasons: verdict.reasons };
  }
  const active = transitionProfileToActive(shadow, { decision: "active", promotionReportId });
  await store.transition(shadow, active, {
    trigger,
    promotion: { records: catalogRecords, promotionReportId },
  });
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

// ---------------------------------------------------------------------------
// Phase 7 Seam 2 —— host lifecycle 编排 + evidence 删除级联接线
// ---------------------------------------------------------------------------

export interface ActivationHostLifecycleInput {
  store: ActivationProfileStore;
  /** verified_skill_effect 事件按 parentSkillId 分组（observer onEvent 累积）。 */
  eventsByParent: ReadonlyMap<string, readonly PracticeEvent[]>;
  /** 当次 discovery catalog（父 SkillRecord 作者字段 + revision 漂移判定）。 */
  catalogRecords: readonly SkillRecord[];
  shadowReportId: string;
  promotionReportId: string;
  trigger?: TriggerSource;
}

export interface ActivationHostLifecycleOutcome {
  /** 父 revision 漂移回 shadow 的 profileId。 */
  reverted: readonly string[];
  /** 本轮新 induction 落盘（draft→shadow）的 profileId。 */
  inducedProfileIds: readonly string[];
  /** 本轮受控 promotion 晋升 active 的 profileId。 */
  promotedProfileIds: readonly string[];
}

/**
 * Phase 7 Seam 2 —— 每轮 host lifecycle 编排：先父 revision 漂移回 shadow，再 induction
 * （verified 事件 → draft → shadow），最后受控 promotion（shadow → active）。evidence 删除
 * 级联由 runEvidenceDeletionCascade 单独接线（删除是外部触发，不在正常 settle 流内）。
 */
export async function runActivationHostLifecycle(
  input: ActivationHostLifecycleInput,
): Promise<ActivationHostLifecycleOutcome> {
  const trigger = input.trigger ?? "procedure";
  // 1. 父 revision 漂移：active profile 的父 revision 与当次 catalog 不同 ⇒ 回 shadow。
  const currentRevisionBySkillId = new Map(
    input.catalogRecords.map((record) => [record.skillId, record.skillRevision] as const),
  );
  const { reverted } = await revertProfilesForParentRevisionChanges(
    input.store,
    currentRevisionBySkillId,
    trigger,
  );

  // 2. induction → shadow；3. promotion → active（冻结 real-skill 评估 provider）。
  const inducedProfileIds: string[] = [];
  const promotedProfileIds: string[] = [];
  for (const [skillId, events] of input.eventsByParent) {
    const record = input.catalogRecords.find((r) => r.skillId === skillId);
    if (record === undefined) continue;
    const induced = await induceAndStoreShadow(
      input.store,
      events,
      record,
      input.shadowReportId,
      trigger,
    );
    if (!induced.ok || induced.status !== "shadow") continue;
    inducedProfileIds.push(induced.profileId);
    const profile = await input.store.getProfile(induced.profileId);
    if (profile === undefined || profile.status !== "shadow") continue;
    const promoted = await promoteProfileIfEligible(
      input.store,
      profile as ShadowActivationProfile,
      input.catalogRecords,
      input.promotionReportId,
      trigger,
    );
    if (promoted.ok) promotedProfileIds.push(induced.profileId);
  }
  return { reverted, inducedProfileIds, promotedProfileIds };
}

/** PracticeStore 的窄 invalidate 接口（结构类型，避免 host 耦合 practice/store）。 */
export interface PracticeInvalidator {
  invalidate(tenantScope: string, eventIds: readonly string[]): Promise<{ invalidatedEventIds: string[] }>;
}

export interface EvidenceDeletionLifecycleOutcome {
  invalidatedEventIds: readonly string[];
  /** evidence 级联 suspend 的 profileId。 */
  suspended: readonly string[];
}

/**
 * Phase 7 Seam 2 —— evidence 删除级联接线：PracticeStore.invalidate 的真实 invalidatedEventIds
 * → applyEvidenceDeletionCascade → 命中 cue 的非终态 profile suspend。删除是外部触发，
 * 此 seam 供 host lifecycle（如审计删除入口）调用；不在此处猜删除时机。
 */
export async function runEvidenceDeletionCascade(
  activationStore: ActivationProfileStore,
  practiceStore: PracticeInvalidator,
  tenantScope: string,
  eventIds: readonly string[],
  trigger: TriggerSource = "user",
): Promise<EvidenceDeletionLifecycleOutcome> {
  const { invalidatedEventIds } = await practiceStore.invalidate(tenantScope, eventIds);
  const { suspended } = await applyEvidenceDeletionCascade(
    activationStore,
    invalidatedEventIds,
    trigger,
  );
  return { invalidatedEventIds, suspended };
}
