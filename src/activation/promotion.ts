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

/** Gate P6 冻结门槛（合成/held-out 校准前按此值冻结；后续按真实分布校准）。 */
export const PROMOTION_THRESHOLDS = {
  /** 每栏 Recall@K / set recall 最低值（gold 非空栏）。 */
  recallAtK: 0.8,
  /** no-skill 栏不误召率最低值。 */
  noSkillPrecision: 1,
  /** hard-confuser 栏 confuser 不误召率最低值。 */
  confuserNotRecalled: 0.8,
  /** 退化检测：learned Top-K 保留 static gold 命中比例最低值。 */
  goldPreservedInTopK: 1,
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
