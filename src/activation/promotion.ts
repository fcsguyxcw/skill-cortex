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
import type { OverlayEvaluationReport } from "./evaluate.ts";

/**
 * Gate P6 冻结门槛（held-out 校准定值，2026-08-16）：
 * 校准依据（src/activation/heldout.ts HELDOUT_CASES，12 例：四栏各 3，与 dev fixture
 * 不重复）：hard_confuser / multi_skill / cross_language 的 recallAtK=1.0、goldPreserved=1.0、
 * confuserNotRecalled=1.0；no_skill noSkillPrecision=1.0。门槛 = held-out 各栏指标下界减 0.1
 * 容差（recallAtK/confuserNotRecalled/goldPreservedInTopK → 0.9）；noSkillPrecision 是
 * 安全硬边界（no-skill 不误召），不放松（保持 1）。
 * 若后续 held-out 分布扩展后某栏掉到门槛下，须重新校准并如实报告，不得为过门调低。
 */
export const PROMOTION_THRESHOLDS = {
  /** 每栏 Recall@K / set recall 最低值（gold 非空栏）。 */
  recallAtK: 0.9,
  /** no-skill 栏不误召率最低值（安全硬边界）。 */
  noSkillPrecision: 1,
  /** hard-confuser 栏 confuser 不误召率最低值。 */
  confuserNotRecalled: 0.9,
  /** 退化检测：learned Top-K 保留 static gold 命中比例最低值。 */
  goldPreservedInTopK: 0.9,
} as const;

export interface PromotionThresholds {
  recallAtK?: number;
  noSkillPrecision?: number;
  confuserNotRecalled?: number;
  goldPreservedInTopK?: number;
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

  const reasons: string[] = [];
  if (!report.nonInferior) {
    reasons.push("overlay_not_non_inferior");
    for (const violation of report.violations) {
      reasons.push(`violation:${violation}`);
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
