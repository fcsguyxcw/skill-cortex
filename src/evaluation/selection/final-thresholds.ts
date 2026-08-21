import { createHash } from "node:crypto";

export const FINAL_SELECTION_THRESHOLDS = Object.freeze({
  schemaVersion: 1 as const,
  minimumRetrievalGoldAvailability: 0.8,
  maximumPairedExactSetRegressionWhenGoldAvailable: 0.05,
  maximumNoSkillAccuracyRegression: 0,
  maximumStrictParseFailureRate: 0,
  maximumInvalidSkillIdCaseRate: 0,
  minimumActualInputTokenReduction: 0.8,
  requiredBreakdowns: Object.freeze([
    "single",
    "multi",
    "no_skill",
    "hard_confuser",
    "zh",
    "en",
    "overall",
  ]),
});

export const FINAL_SELECTION_THRESHOLD_CONFIG_HASH = hashThresholds(
  FINAL_SELECTION_THRESHOLDS,
);

export function hashThresholds(
  thresholds: typeof FINAL_SELECTION_THRESHOLDS,
): string {
  const canonical = {
    schemaVersion: thresholds.schemaVersion,
    minimumRetrievalGoldAvailability: thresholds.minimumRetrievalGoldAvailability,
    maximumPairedExactSetRegressionWhenGoldAvailable:
      thresholds.maximumPairedExactSetRegressionWhenGoldAvailable,
    maximumNoSkillAccuracyRegression: thresholds.maximumNoSkillAccuracyRegression,
    maximumStrictParseFailureRate: thresholds.maximumStrictParseFailureRate,
    maximumInvalidSkillIdCaseRate: thresholds.maximumInvalidSkillIdCaseRate,
    minimumActualInputTokenReduction: thresholds.minimumActualInputTokenReduction,
    requiredBreakdowns: [...thresholds.requiredBreakdowns],
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}
