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
 * Phase 7 Seam 3 —— 冻结 real-skill 评估 provider（promotion 不接受任意 caller 自定义评估集）。
 *
 * - `FROZEN_PROMOTION_OVERLAY`：冻结 overlay 参数（与 final-heldout 一致，定值）。
 * - `buildFrozenEvaluation`：唯一评估集来源——由 (profile, catalogRecords) 确定性构造
 *   四栏评估集（父 Skill 自身 name/description 作 hard_confuser/multi_skill 查询、
 *   冻结无关 no_skill、learned 中文 alias（或冻结中文后缀回退）作 cross_language；
 *   父不在 catalog ⇒ 空 case 集 ⇒ promotion 拒绝）。
 * - `promoteProfileIfEligible` 只接受 (store, shadow, catalogRecords, reportId, trigger)，
 *   内部走 buildFrozenEvaluation + evaluateProfileForPromotion，caller 无法注入手搓
 *   评估集/report/verdict。
 */

/** 冻结 promotion overlay 参数（定值，与 final-heldout 阈值校准一致）。 */
export const FROZEN_PROMOTION_OVERLAY: EvaluateOptions = {
  aliasBoost: 5,
  positiveBoost: 3,
  nearMissPenalty: 10,
} as const;

/** 冻结 no_skill 查询（与 dev/calibration/final-heldout 均不重叠的无关主题）。 */
const FROZEN_NO_SKILL_QUERIES: readonly string[] = [
  "how to bake sourdough bread",
  "best coffee shops in portland",
  "translate this poem to french",
];

/** 冻结 cross_language 中文后缀（父无 learned 中文 alias 时的回退，保证四栏覆盖）。 */
const FROZEN_CROSS_LANGUAGE_SUFFIX = "分页检测";

const CJK_RE = /[一-鿿]/u;

export interface FrozenEvaluation {
  cases: readonly EvaluationCase[];
  records: readonly SkillRecord[];
}

/**
 * 冻结 real-skill 评估集（唯一来源）：父 Skill 自身 metadata + 冻结无关查询 + learned 中文
 * alias 构成四栏。父（skillId+revision 匹配）不在 catalog ⇒ cases 为空 ⇒ 调用方拒绝晋升。
 * 说明：real-skill 无独立 ground-truth verifier（Phase 7 全系统验证另做更强压力测试），
 * 此处评估 non-inferiority（overlay 对父自身查询不劣于静态），不替代 final-heldout 门槛校准。
 */
export function buildFrozenEvaluation(
  profile: ActivationProfile,
  catalogRecords: readonly SkillRecord[],
): FrozenEvaluation {
  const parent = catalogRecords.find(
    (record) =>
      record.skillId === profile.parentSkillId &&
      record.skillRevision === profile.parentSkillRevision,
  );
  if (parent === undefined) {
    return { cases: [], records: catalogRecords };
  }
  const gold = parent.skillId;
  const others = catalogRecords
    .filter((record) => record.skillId !== gold)
    .sort((a, b) => (a.skillId < b.skillId ? -1 : 1));
  const confuserIds = others.length > 0 ? [others[0]!.skillId] : [];

  const chineseAliases = profile.learnedAliases.filter((alias) => CJK_RE.test(alias.text));
  const crossLanguageQueries =
    chineseAliases.length > 0
      ? chineseAliases.map((alias) => `${alias.text} ${parent.name}`)
      : [`${parent.name} ${FROZEN_CROSS_LANGUAGE_SUFFIX}`];

  const cases: EvaluationCase[] = [
    {
      id: "hc-name",
      column: "hard_confuser",
      query: parent.name,
      expectedSkillIds: [gold],
      ...(confuserIds.length > 0 ? { confuserSkillIds: confuserIds } : {}),
    },
    {
      id: "hc-desc",
      column: "hard_confuser",
      query: parent.description,
      expectedSkillIds: [gold],
      ...(confuserIds.length > 0 ? { confuserSkillIds: confuserIds } : {}),
    },
    ...FROZEN_NO_SKILL_QUERIES.map((query, index) => ({
      id: `ns-${index}`,
      column: "no_skill" as const,
      query,
      expectedSkillIds: [] as string[],
    })),
    { id: "ms-name", column: "multi_skill", query: parent.name, expectedSkillIds: [gold] },
    { id: "ms-desc", column: "multi_skill", query: parent.description, expectedSkillIds: [gold] },
    ...crossLanguageQueries.map((query, index) => ({
      id: `cl-${index}`,
      column: "cross_language" as const,
      query,
      expectedSkillIds: [gold],
    })),
  ];
  return { cases, records: catalogRecords };
}

/**
 * 受控 promotion（冻结评估集）：report 只能由 buildFrozenEvaluation + evaluateProfileForPromotion
 * 重算，caller 无法注入手搓评估集/report/verdict；store 内部再重算 verdict 兜底。
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
