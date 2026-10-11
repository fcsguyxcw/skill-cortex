import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FINAL_SELECTION_THRESHOLD_CONFIG_HASH,
  FINAL_SELECTION_THRESHOLDS,
  hashThresholds,
} from "./final-thresholds.ts";

describe("final Selection thresholds", () => {
  it("freezes separate retrieval, paired quality, protocol, and cost gates", () => {
    assert.equal(FINAL_SELECTION_THRESHOLDS.minimumRetrievalGoldAvailability, 0.8);
    assert.equal(
      FINAL_SELECTION_THRESHOLDS.maximumPairedExactSetRegressionWhenGoldAvailable,
      0.05,
    );
    assert.equal(FINAL_SELECTION_THRESHOLDS.maximumNoSkillAccuracyRegression, 0);
    assert.equal(FINAL_SELECTION_THRESHOLDS.maximumStrictParseFailureRate, 0);
    assert.equal(FINAL_SELECTION_THRESHOLDS.maximumInvalidSkillIdCaseRate, 0);
    assert.equal(FINAL_SELECTION_THRESHOLDS.minimumActualInputTokenReduction, 0.8);
    assert.deepEqual(FINAL_SELECTION_THRESHOLDS.requiredBreakdowns, [
      "single",
      "multi",
      "no_skill",
      "hard_confuser",
      "zh",
      "en",
      "overall",
    ]);
  });

  it("has a deterministic machine-readable identity", () => {
    assert.match(FINAL_SELECTION_THRESHOLD_CONFIG_HASH, /^sha256:[0-9a-f]{64}$/);
    assert.equal(
      hashThresholds(FINAL_SELECTION_THRESHOLDS),
      FINAL_SELECTION_THRESHOLD_CONFIG_HASH,
    );
  });
});
