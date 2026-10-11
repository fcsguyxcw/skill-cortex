import type { SkillRecord } from "../../core/contracts/index.ts";
import {
  ACTIVATION_MEMORY_CALIBRATION_CASES,
  ACTIVATION_MEMORY_CATALOG_HASH,
  ACTIVATION_MEMORY_EXPERIENCE_CASES,
  ACTIVATION_MEMORY_NEGATIVE_CONTROLS,
  ACTIVATION_MEMORY_TARGET_SKILLS,
  FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH,
  computeActivationMemoryFixtureHash,
} from "./cases.ts";
import {
  ACTIVATION_MEMORY_CALIBRATION_CONFIG,
  ACTIVATION_MEMORY_CALIBRATION_CONFIG_HASH,
  computeActivationMemoryCalibrationConfigHash,
} from "./calibration-config.ts";
import type { ActivationMemoryExperimentCondition } from "./formation-contract.ts";
import { runActivationMemoryNegativeControls } from "./negative-controls.ts";
import {
  runActivationMemoryOfflineCalibration,
  type ActivationMemoryOfflineConditionResult,
} from "./offline-runner.ts";

export interface ActivationMemoryCalibrationPoint {
  readonly exposure: number;
  readonly condition: ActivationMemoryExperimentCondition;
  readonly formation: ActivationMemoryOfflineConditionResult["formation"];
  readonly metrics: ActivationMemoryOfflineConditionResult["metrics"];
  readonly cases: ActivationMemoryOfflineConditionResult["cases"];
}

export interface ActivationMemoryCalibrationAblationReport {
  readonly schemaVersion: 1;
  readonly sourceMode: "evaluation_fixture";
  readonly partition: "calibration";
  readonly evidenceLevel: "offline_component";
  readonly catalogHash: string;
  readonly fixtureHash: string;
  readonly configHash: string;
  readonly configuration: typeof ACTIVATION_MEMORY_CALIBRATION_CONFIG;
  readonly pointCount: number;
  readonly points: readonly ActivationMemoryCalibrationPoint[];
  readonly negativeControls: ReturnType<typeof runActivationMemoryNegativeControls>;
}

export function runActivationMemoryCalibrationAblation(options: {
  readonly catalog: readonly SkillRecord[];
  readonly catalogHash: string;
}): ActivationMemoryCalibrationAblationReport {
  validateFrozenIdentity(options.catalog, options.catalogHash);
  const points: ActivationMemoryCalibrationPoint[] = [];

  for (const exposure of ACTIVATION_MEMORY_CALIBRATION_CONFIG.learningCurvePoints) {
    const run = runActivationMemoryOfflineCalibration({
      catalog: options.catalog,
      targets: ACTIVATION_MEMORY_TARGET_SKILLS,
      experiences: ACTIVATION_MEMORY_EXPERIENCE_CASES,
      cases: ACTIVATION_MEMORY_CALIBRATION_CASES,
      exposure,
      topK: ACTIVATION_MEMORY_CALIBRATION_CONFIG.topK,
      memoryBoost: ACTIVATION_MEMORY_CALIBRATION_CONFIG.memoryBoost,
      nearMissPenalty: ACTIVATION_MEMORY_CALIBRATION_CONFIG.nearMissPenalty,
    });
    for (const condition of run.conditions) {
      if (exposure > 0 && condition.condition.producer === "none") continue;
      points.push(Object.freeze({
        exposure,
        condition: condition.condition,
        formation: condition.formation,
        metrics: condition.metrics,
        cases: condition.cases,
      }));
    }
  }

  const negativeControls = runActivationMemoryNegativeControls({
    catalog: options.catalog,
    targets: ACTIVATION_MEMORY_TARGET_SKILLS,
    experiences: ACTIVATION_MEMORY_EXPERIENCE_CASES,
    controls: ACTIVATION_MEMORY_NEGATIVE_CONTROLS,
    topK: ACTIVATION_MEMORY_CALIBRATION_CONFIG.topK,
    memoryBoost: ACTIVATION_MEMORY_CALIBRATION_CONFIG.memoryBoost,
    nearMissPenalty: ACTIVATION_MEMORY_CALIBRATION_CONFIG.nearMissPenalty,
  });

  return Object.freeze({
    schemaVersion: 1,
    sourceMode: "evaluation_fixture",
    partition: "calibration",
    evidenceLevel: "offline_component",
    catalogHash: ACTIVATION_MEMORY_CATALOG_HASH,
    fixtureHash: FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH,
    configHash: ACTIVATION_MEMORY_CALIBRATION_CONFIG_HASH,
    configuration: ACTIVATION_MEMORY_CALIBRATION_CONFIG,
    pointCount: points.length,
    points: Object.freeze(points),
    negativeControls,
  });
}

function validateFrozenIdentity(catalog: readonly SkillRecord[], catalogHash: string): void {
  if (catalogHash !== ACTIVATION_MEMORY_CATALOG_HASH) throw new Error("activation_memory_catalog_hash_mismatch");
  if (computeActivationMemoryFixtureHash() !== FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH) {
    throw new Error("activation_memory_fixture_hash_mismatch");
  }
  if (computeActivationMemoryCalibrationConfigHash() !== ACTIVATION_MEMORY_CALIBRATION_CONFIG_HASH) {
    throw new Error("activation_memory_calibration_config_hash_mismatch");
  }
  const catalogById = new Map(catalog.map((item) => [item.skillId, item]));
  if (catalogById.size !== catalog.length) throw new Error("activation_memory_catalog_duplicate_skill_id");
  for (const target of ACTIVATION_MEMORY_TARGET_SKILLS) {
    const record = catalogById.get(target.skillId);
    if (record === undefined || record.skillRevision !== target.skillRevision) {
      throw new Error("activation_memory_target_identity_mismatch");
    }
  }
}
