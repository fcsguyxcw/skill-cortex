import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVATION_MEMORY_CALIBRATION_CONFIG,
  ACTIVATION_MEMORY_CALIBRATION_CONFIG_HASH,
  computeActivationMemoryCalibrationConfigHash,
} from "./calibration-config.ts";

test("activation-memory calibration config is frozen before retrieval", () => {
  assert.deepEqual(ACTIVATION_MEMORY_CALIBRATION_CONFIG.learningCurvePoints, [0, 1, 2, 4, 8]);
  assert.deepEqual(ACTIVATION_MEMORY_CALIBRATION_CONFIG.conditionIds, ["A", "B", "C1", "C2", "D1", "D2"]);
  assert.equal(ACTIVATION_MEMORY_CALIBRATION_CONFIG.topK, 5);
  assert.equal(ACTIVATION_MEMORY_CALIBRATION_CONFIG.memoryBoost, 5);
  assert.equal(ACTIVATION_MEMORY_CALIBRATION_CONFIG.nearMissPenalty, 1);
  assert.equal(computeActivationMemoryCalibrationConfigHash(), ACTIVATION_MEMORY_CALIBRATION_CONFIG_HASH);
});
