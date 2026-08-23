import { createHash } from "node:crypto";

import {
  ACTIVATION_MEMORY_CATALOG_HASH,
  FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH,
} from "./cases.ts";
import {
  ACTIVATION_MEMORY_EXPERIMENT_CONDITIONS,
  ACTIVATION_MEMORY_FORMATION_CONTRACT_HASH,
  ACTIVATION_MEMORY_LEARNING_CURVE_POINTS,
} from "./formation-contract.ts";

export const ACTIVATION_MEMORY_CALIBRATION_CONFIG = Object.freeze({
  schemaVersion: 1 as const,
  sourceMode: "evaluation_fixture" as const,
  partition: "calibration" as const,
  catalogHash: ACTIVATION_MEMORY_CATALOG_HASH,
  fixtureHash: FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH,
  formationContractHash: ACTIVATION_MEMORY_FORMATION_CONTRACT_HASH,
  topK: 5,
  memoryBoost: 5,
  nearMissPenalty: 1,
  learningCurvePoints: ACTIVATION_MEMORY_LEARNING_CURVE_POINTS,
  conditionIds: Object.freeze(ACTIVATION_MEMORY_EXPERIMENT_CONDITIONS.map((item) => item.id)),
});

export function computeActivationMemoryCalibrationConfigHash(): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(ACTIVATION_MEMORY_CALIBRATION_CONFIG), "utf8")
    .digest("hex")}`;
}

// Frozen before the calibration retrieval run is executed.
export const ACTIVATION_MEMORY_CALIBRATION_CONFIG_HASH =
  "sha256:770e80357df5a2f5e11334844a9c2748ef5fca899fa28300b38bf3ca674748c1";
