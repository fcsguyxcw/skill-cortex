import { createHash } from "node:crypto";

import type { SkillRecord } from "../../core/contracts/index.ts";
import { computeCatalogHash, computeGoldSetHash } from "../selection/paired.ts";
import {
  SELECTION_MEMORY_CALIBRATION_CONFIG,
  SELECTION_MEMORY_CALIBRATION_SYSTEM_PROMPT,
  computeSelectionMemoryCalibrationConfigHash,
  type SelectionMemoryCalibrationConfig,
} from "./calibration-config.ts";
import { SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS } from "./catalog.ts";
import {
  computeSelectionMemoryCaseSetHash,
  type SelectionMemoryEvalCase,
} from "./evidence-cases.ts";
import { SELECTION_MEMORY_HELDOUT_CASES } from "./heldout-cases.ts";
import type { RealSelectionMemoryCalibrationReport } from "./real-model.ts";
import { SELECTION_MEMORY_ARMS } from "./runner.ts";

export const SELECTION_MEMORY_CALIBRATION_REPORT_HASH =
  "sha256:a77aef8bf705e885229f8934ab535b54eb5e5f1b1766bb30d7c6ce6925b3861b";
export const SELECTION_MEMORY_HELDOUT_CASE_HASH =
  "sha256:b93564482ce4c5bdfc3f30e6b56489ace33628fb0ae9dabc491d4836d80d19ac";
export const SELECTION_MEMORY_HELDOUT_GOLD_SET_HASH =
  "sha256:17a9c5d7a527ca0a5f146a9e13bb0e950bcc49455404d8a862034ad088813422";

export interface SelectionMemoryHeldoutConfig {
  readonly schemaVersion: 1;
  readonly protocol: "selection-memory-context-heldout-v1";
  readonly calibrationReportHash: string;
  readonly calibrationConfigHash: string;
  readonly calibrationGateVersion: 1;
  readonly freezeHash: string;
  readonly parentCatalogHash: string;
  readonly experimentCatalogHash: string;
  readonly catalogContentHash: string;
  readonly evidenceHash: string;
  readonly heldoutCaseHash: string;
  readonly heldoutGoldSetHash: string;
  readonly queryExpansionRulesHash: string;
  readonly promptVersion: number;
  readonly runnerVersion: number;
  readonly systemPromptHash: string;
  readonly candidateScope: "user";
  readonly memoryLimits: SelectionMemoryCalibrationConfig["memoryLimits"];
  readonly layers: SelectionMemoryCalibrationConfig["layers"];
  readonly arms: typeof SELECTION_MEMORY_ARMS;
  readonly topK: number;
  readonly repeatCount: number;
  readonly expectedInvocationCount: number;
  readonly model: SelectionMemoryCalibrationConfig["model"];
  readonly thresholds: {
    readonly selectionIsolatedS2MustExceedS0: true;
    readonly selectionIsolatedS2MustExceedS1: true;
    readonly protectedSlices: readonly ["no_skill", "hard_confuser", "multi"];
    readonly protocolFailureMaximum: 0;
    readonly addedPromptInputMaximum: 1000;
  };
  readonly report: {
    readonly file: "2026-08-20-selection-memory-context-heldout.json";
    readonly rawPromptsStored: false;
    readonly rawResponsesStored: false;
    readonly queriesStored: false;
    readonly overwriteAllowed: false;
  };
  readonly configHash: string;
}

const configWithoutHash: Omit<SelectionMemoryHeldoutConfig, "configHash"> = Object.freeze({
  schemaVersion: 1,
  protocol: "selection-memory-context-heldout-v1",
  calibrationReportHash: SELECTION_MEMORY_CALIBRATION_REPORT_HASH,
  calibrationConfigHash: SELECTION_MEMORY_CALIBRATION_CONFIG.configHash,
  calibrationGateVersion: 1,
  freezeHash: SELECTION_MEMORY_CALIBRATION_CONFIG.freezeHash,
  parentCatalogHash: SELECTION_MEMORY_CALIBRATION_CONFIG.parentCatalogHash,
  experimentCatalogHash: SELECTION_MEMORY_CALIBRATION_CONFIG.experimentCatalogHash,
  catalogContentHash: SELECTION_MEMORY_CALIBRATION_CONFIG.catalogContentHash,
  evidenceHash: SELECTION_MEMORY_CALIBRATION_CONFIG.evidenceHash,
  heldoutCaseHash: SELECTION_MEMORY_HELDOUT_CASE_HASH,
  heldoutGoldSetHash: SELECTION_MEMORY_HELDOUT_GOLD_SET_HASH,
  queryExpansionRulesHash: SELECTION_MEMORY_CALIBRATION_CONFIG.queryExpansionRulesHash,
  promptVersion: SELECTION_MEMORY_CALIBRATION_CONFIG.promptVersion,
  runnerVersion: SELECTION_MEMORY_CALIBRATION_CONFIG.runnerVersion,
  systemPromptHash: SELECTION_MEMORY_CALIBRATION_CONFIG.systemPromptHash,
  candidateScope: SELECTION_MEMORY_CALIBRATION_CONFIG.candidateScope,
  memoryLimits: SELECTION_MEMORY_CALIBRATION_CONFIG.memoryLimits,
  layers: SELECTION_MEMORY_CALIBRATION_CONFIG.layers,
  arms: SELECTION_MEMORY_ARMS,
  topK: SELECTION_MEMORY_CALIBRATION_CONFIG.topK,
  repeatCount: SELECTION_MEMORY_CALIBRATION_CONFIG.repeatCount,
  expectedInvocationCount: SELECTION_MEMORY_HELDOUT_CASES.length
    * SELECTION_MEMORY_CALIBRATION_CONFIG.layers.length
    * SELECTION_MEMORY_ARMS.length
    * SELECTION_MEMORY_CALIBRATION_CONFIG.repeatCount,
  model: SELECTION_MEMORY_CALIBRATION_CONFIG.model,
  thresholds: Object.freeze({
    selectionIsolatedS2MustExceedS0: true,
    selectionIsolatedS2MustExceedS1: true,
    protectedSlices: Object.freeze(["no_skill", "hard_confuser", "multi"] as const),
    protocolFailureMaximum: 0,
    addedPromptInputMaximum: 1000,
  }),
  report: Object.freeze({
    file: "2026-08-20-selection-memory-context-heldout.json",
    rawPromptsStored: false,
    rawResponsesStored: false,
    queriesStored: false,
    overwriteAllowed: false,
  }),
});

export const SELECTION_MEMORY_HELDOUT_CONFIG: SelectionMemoryHeldoutConfig = Object.freeze({
  ...configWithoutHash,
  configHash: hashCanonical(configWithoutHash),
});

export function computeSelectionMemoryHeldoutConfigHash(
  config: SelectionMemoryHeldoutConfig | Omit<SelectionMemoryHeldoutConfig, "configHash">,
): string {
  const { configHash: _ignored, ...semantic } = config as SelectionMemoryHeldoutConfig;
  return hashCanonical(semantic);
}

export function assertFrozenSelectionMemoryHeldoutPreflight(options: {
  readonly catalog: readonly SkillRecord[];
  readonly cases: readonly SelectionMemoryEvalCase[];
  readonly config: SelectionMemoryHeldoutConfig;
  readonly calibrationReport: RealSelectionMemoryCalibrationReport;
  readonly calibrationReportHash: string;
}): void {
  if (
    computeSelectionMemoryHeldoutConfigHash(options.config) !== options.config.configHash
    || options.config.configHash !== SELECTION_MEMORY_HELDOUT_CONFIG.configHash
  ) throw new Error("selection_memory_heldout_config_hash_mismatch");
  if (options.calibrationReportHash !== options.config.calibrationReportHash) {
    throw new Error("selection_memory_calibration_report_hash_mismatch");
  }
  assertFrozenCalibrationPass(options.calibrationReport, options.config);
  const catalogHash = computeCatalogHash(options.catalog);
  if (catalogHash !== options.config.catalogContentHash) {
    throw new Error("selection_memory_heldout_catalog_hash_mismatch");
  }
  const ids = options.catalog.map((item) => item.skillId).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS])) {
    throw new Error("selection_memory_heldout_catalog_membership_mismatch");
  }
  if (computeSelectionMemoryCaseSetHash(options.cases) !== options.config.heldoutCaseHash) {
    throw new Error("selection_memory_heldout_case_hash_mismatch");
  }
  if (computeGoldSetHash(catalogHash, options.cases) !== options.config.heldoutGoldSetHash) {
    throw new Error("selection_memory_heldout_gold_hash_mismatch");
  }
}

function assertFrozenCalibrationPass(
  report: RealSelectionMemoryCalibrationReport,
  config: SelectionMemoryHeldoutConfig,
): void {
  if (
    report.sourceMode !== "real_model"
    || report.config.configHash !== config.calibrationConfigHash
    || computeSelectionMemoryCalibrationConfigHash(report.config) !== report.config.configHash
    || report.calls.length !== report.config.expectedInvocationCount
    || report.usage.callCount !== report.calls.length
    || report.protocol.rawPromptsStored
    || report.protocol.rawResponsesStored
    || report.protocol.queriesStored
  ) throw new Error("selection_memory_calibration_evidence_invalid");
  const uniqueCalls = new Set(report.calls.map((item) =>
    `${item.layer}|${item.caseId}|${item.arm}|${item.repeatIndex}`
  ));
  if (uniqueCalls.size !== report.calls.length) {
    throw new Error("selection_memory_calibration_call_identity_invalid");
  }
  const layer = report.layers.selection_isolated;
  const s0 = layer.arms.description_only;
  const s1 = layer.arms.positive_memory;
  const s2 = layer.arms.structured_memory;
  if (!(s2.exactSetAccuracy > s0.exactSetAccuracy && s2.exactSetAccuracy > s1.exactSetAccuracy)) {
    throw new Error("selection_memory_calibration_accuracy_gate_failed");
  }
  for (const slice of config.thresholds.protectedSlices) {
    if (layer.slices[slice].structured_memory.exactSetAccuracy
      < layer.slices[slice].description_only.exactSetAccuracy) {
      throw new Error("selection_memory_calibration_protected_slice_gate_failed");
    }
  }
  const protocolFailures = s2.strictParseFailures
    + s2.unknownSkillIdCalls
    + s2.unlistedSkillIdCalls
    + s2.duplicateSkillIdCalls;
  if (protocolFailures > config.thresholds.protocolFailureMaximum) {
    throw new Error("selection_memory_calibration_protocol_gate_failed");
  }
  const selectionCalls = report.calls.filter((item) => item.layer === "selection_isolated");
  const s0Calls = selectionCalls.filter((item) => item.arm === "description_only");
  const s2Calls = selectionCalls.filter((item) => item.arm === "structured_memory");
  if (s0Calls.length === 0 || s0Calls.length !== s2Calls.length) {
    throw new Error("selection_memory_calibration_usage_gate_unavailable");
  }
  const meanAddedInput = (sumPromptInput(s2Calls) - sumPromptInput(s0Calls)) / s2Calls.length;
  if (meanAddedInput > config.thresholds.addedPromptInputMaximum) {
    throw new Error("selection_memory_calibration_input_gate_failed");
  }
}

function sumPromptInput(calls: RealSelectionMemoryCalibrationReport["calls"]): number {
  let total = 0;
  for (const call of calls) {
    if (call.usage === undefined) throw new Error("selection_memory_calibration_usage_gate_unavailable");
    total += call.usage.input + call.usage.cacheRead;
  }
  return total;
}

function hashCanonical(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export { SELECTION_MEMORY_CALIBRATION_SYSTEM_PROMPT as SELECTION_MEMORY_HELDOUT_SYSTEM_PROMPT };
