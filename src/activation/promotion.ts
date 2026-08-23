/**
 * Phase 6 第三批 —— ActivationProfile promotion gate（纯函数；Gate P6 判门）。
 *
 * plan §11 任务 5 + Gate P6：shadow → active 放行须满足：
 * - overlay 非劣（learned ≥ static − tolerance，consume OverlayEvaluationReport.nonInferior）；
 * - 每栏 Recall@K / set recall 达到冻结门槛（默认 0.8；真实分布校准前按合成 fixture 冻结）；
 * - no-skill 不误召、hard-confuser 不误召、gold 不挤出 Top-K（退化检测）均不劣于门槛。
 *
 * 判定返回 { ok:true } 或 { ok:false; reasons }（reasons 可审计，供报告/gate 日志）。
 * 本模块只判门；draft→shadow 回放与 active 落地（store 持久化）不在本 slice；
 * 任何退化可关闭 overlay 无损回静态（rerankWithOverlay overlay-off 可复现，无需本模块动作）。
 */
import type { ActivationProfile, SkillRecord } from "../core/contracts/index.ts";
import type {
  EvaluateOptions,
  EvaluationCase,
  EvaluationColumn,
  OverlayEvaluationReport,
} from "./evaluate.ts";

/** Gate P6 promotion 必须覆盖的四栏（与 evaluate.ts 的 EvaluationColumn 全集一致）。 */
const REQUIRED_COLUMNS: readonly EvaluationColumn[] = [
  "hard_confuser",
  "no_skill",
  "multi_skill",
  "cross_language",
];

/**
 * real-skill 冻结 promotion gate 降级后的必覆盖栏（2026-08-18 收口）：
 *
 * 冻结 real-skill 评估 provider（buildFrozenEvaluation）只能**真实验证**这两栏——
 * - `hard_confuser`：父 Skill 的 name/description 召回 gold + 真实 confuser 不误召；
 * - `no_skill`：冻结无关查询不误召。
 *
 * `multi_skill`（多 gold 全召回）与 `cross_language`（纯跨语言 learned cue 触发召回）在真实
 * 2-skill 无共召回查询的 catalog、且 rerank overlay 只能重排静态候选（不能新增候选）的前提下，
 * **无法真实验证**（见 host.ts buildFrozenEvaluation 的降级说明）。这两栏仍由合成
 * final-heldout/calibration set（真正的多 gold 与中文查询 fixture）单独验证，但 real-skill
 * 冻结 gate 不再把它们列为必覆盖栏——不造假 fixture、不降低数值门槛，如实降级。
 */
export const FROZEN_REQUIRED_COLUMNS: readonly EvaluationColumn[] = [
  "hard_confuser",
  "no_skill",
];

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

export interface FrozenEvaluation {
  cases: readonly EvaluationCase[];
  records: readonly SkillRecord[];
}

/**
 * 冻结 real-skill 评估集（唯一来源）：父 Skill 自身 metadata + 冻结无关查询，构成可**真实验证**
 * 的 hard_confuser + no_skill 两栏。父（skillId+revision 匹配）不在 catalog ⇒ cases 为空 ⇒
 * 调用方拒绝晋升。
 *
 * 降级说明（2026-08-18 收口，真实不造假）：
 * - `multi_skill`：真实 catalog 无「单一 query 应共召回多个 gold」的 ground-truth，且 rerank
 *   overlay 只能重排静态候选、不能新增候选——无法构造真实验证。故不再产出单-gold 的伪
 *   multi_skill case，由合成 final-heldout/calibration 单独验证。
 * - `cross_language`：纯跨语言召回须依赖 learned 中文 alias，但 real-skill induction 通常不
 *   产中文 alias，且 `${alias} ${parent.name}` 里 parent.name 本身即可静态召回（learned cue
 *   不贡献召回），无法证明 learned cue 有效。故不再产出含 parent.name 的伪 cross_language
 *   case，由合成 final-heldout/calibration 的纯中文+英文关键词 fixture 单独验证。
 * 两栏降级后 gate 用 FROZEN_REQUIRED_COLUMNS（hard_confuser + no_skill）。
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
  ];
  return { cases, records: catalogRecords };
}

/**
 * Gate P6 冻结门槛（2026-08-16 收口）：
 * - recallAtK / setRecall 最低 0.9（calibration set 各栏下界 1.0 − 0.1 容差）；
 * - confuserNotRecalled 最低 0.9（hard-confuser 不误召干扰项）；
 * - noSkillPrecision = 1（安全硬边界：no-skill 不误召，不放松）；
 * - goldPreservedInTopK = 1（退化检测硬边界：learned overlay 不得把 static Top-K 中的
 *   gold 挤出，任何退化即拒）。
 * 门槛冻结后不得为过门调低；final-heldout 未达标须如实报告。
 */
export const PROMOTION_THRESHOLDS = {
  /** 每栏 Recall@K / set recall 最低值（gold 非空栏）。 */
  recallAtK: 0.9,
  /** no-skill 栏不误召率最低值（安全硬边界）。 */
  noSkillPrecision: 1,
  /** hard-confuser 栏 confuser 不误召率最低值。 */
  confuserNotRecalled: 0.9,
  /** 退化检测：learned Top-K 保留 static gold 命中比例最低值（硬边界，任何退化即拒）。 */
  goldPreservedInTopK: 1,
} as const;

export interface PromotionThresholds {
  recallAtK?: number;
  noSkillPrecision?: number;
  confuserNotRecalled?: number;
  goldPreservedInTopK?: number;
  /** 必覆盖栏（默认 REQUIRED_COLUMNS 四栏；real-skill 冻结 gate 用 FROZEN_REQUIRED_COLUMNS）。 */
  requiredColumns?: readonly EvaluationColumn[];
}

export type PromotionVerdict =
  | { ok: true }
  | { ok: false; reasons: readonly string[] };

function below(value: number | "N/A", threshold: number): boolean {
  return value !== "N/A" && value < threshold;
}

/**
 * shadow→active 判门：nonInferior 必须成立 + 各栏指标达门槛。
 * 无案例的栏（caseCount=0 或指标 N/A）不构成门槛（不虚判）。
 */
export function evaluateProfilePromotion(
  report: OverlayEvaluationReport,
  thresholds: PromotionThresholds = {},
): PromotionVerdict {
  const recallAtK = thresholds.recallAtK ?? PROMOTION_THRESHOLDS.recallAtK;
  const noSkillPrecision = thresholds.noSkillPrecision ?? PROMOTION_THRESHOLDS.noSkillPrecision;
  const confuserNotRecalled =
    thresholds.confuserNotRecalled ?? PROMOTION_THRESHOLDS.confuserNotRecalled;
  const goldPreservedInTopK =
    thresholds.goldPreservedInTopK ?? PROMOTION_THRESHOLDS.goldPreservedInTopK;
  const requiredColumns = thresholds.requiredColumns ?? REQUIRED_COLUMNS;

  const reasons: string[] = [];
  if (!report.nonInferior) {
    reasons.push("overlay_not_non_inferior");
    for (const violation of report.violations) {
      reasons.push(`violation:${violation}`);
    }
  }
  // 栏覆盖：合成 held-out 缺省要求四栏；real-skill 冻结 gate 降级为 FROZEN_REQUIRED_COLUMNS。
  // 缺任一必覆盖栏（caseCount=0 或缺失）⇒ 拒绝，不虚判。
  const covered = new Set(
    report.learnedColumns
      .filter((column) => column.caseCount > 0)
      .map((column) => column.column),
  );
  for (const column of requiredColumns) {
    if (!covered.has(column)) {
      reasons.push(`column_not_covered:${column}`);
    }
  }
  for (const column of report.learnedColumns) {
    if (column.caseCount === 0) continue;
    if (below(column.recallAtK, recallAtK)) {
      reasons.push(`${column.column}.recallAtK=${column.recallAtK} < ${recallAtK}`);
    }
    if (below(column.setRecall, recallAtK)) {
      reasons.push(`${column.column}.setRecall=${column.setRecall} < ${recallAtK}`);
    }
    if (below(column.noSkillPrecision, noSkillPrecision)) {
      reasons.push(`${column.column}.noSkillPrecision=${column.noSkillPrecision} < ${noSkillPrecision}`);
    }
    if (below(column.confuserNotRecalled, confuserNotRecalled)) {
      reasons.push(
        `${column.column}.confuserNotRecalled=${column.confuserNotRecalled} < ${confuserNotRecalled}`,
      );
    }
    if (below(column.goldPreservedInTopK, goldPreservedInTopK)) {
      reasons.push(
        `${column.column}.goldPreservedInTopK=${column.goldPreservedInTopK} < ${goldPreservedInTopK}`,
      );
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
