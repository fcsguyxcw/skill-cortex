import { createHash } from "node:crypto";

import type { SkillRecord } from "../../core/contracts/index.ts";
import { buildQueryExpansionIndex } from "../../discovery/query-expansion.ts";
import { computeCatalogHash, computeGoldSetHash } from "../selection/paired.ts";
import {
  SELECTION_MEMORY_CALIBRATION_CONFIG,
  computeSelectionMemoryCalibrationConfigHash,
  type SelectionMemoryCalibrationConfig,
} from "./calibration-config.ts";
import { SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS } from "./catalog.ts";
import {
  computeSelectionMemoryCaseSetHash,
  type SelectionMemoryEvalCase,
} from "./evidence-cases.ts";
import {
  runSelectionMemoryEvaluation,
  type SelectionMemoryEvaluationLayer,
  type SelectionMemoryEvaluationReport,
  type SelectionMemoryInvocationRequest,
} from "./runner.ts";

export interface RealSelectionMemoryUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number;
  readonly totalTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

export interface RealSelectionMemoryCompletion {
  readonly text: string;
  readonly usage: RealSelectionMemoryUsage;
  readonly stopReason: string;
  readonly responseModel?: string;
}

export type RealSelectionMemoryCompleter = (
  request: SelectionMemoryInvocationRequest,
) => Promise<RealSelectionMemoryCompletion>;

export interface RunRealSelectionMemoryCalibrationOptions {
  readonly catalog: readonly SkillRecord[];
  readonly cases: readonly SelectionMemoryEvalCase[];
  readonly config: SelectionMemoryCalibrationConfig;
  readonly generatedAt: string;
  readonly complete: RealSelectionMemoryCompleter;
}

export interface RealSelectionMemoryCallEvidence {
  readonly caseId: string;
  readonly layer: SelectionMemoryEvaluationLayer;
  readonly arm: SelectionMemoryInvocationRequest["arm"];
  readonly repeatIndex: number;
  readonly rawOutputHash?: string;
  readonly usage?: RealSelectionMemoryUsage;
  readonly stopReason: string;
  readonly responseModel?: string;
  readonly failureCategory?: "provider_error";
}

export interface RealSelectionMemoryUsageSummary {
  readonly available: boolean;
  readonly callCount: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
  readonly totalTokens: number;
  readonly costTotal: number;
}

export interface RealSelectionMemoryCalibrationReport {
  readonly schemaVersion: 1;
  readonly sourceMode: "real_model";
  readonly generatedAt: string;
  readonly config: SelectionMemoryCalibrationConfig;
  readonly protocol: {
    readonly rawPromptsStored: false;
    readonly rawResponsesStored: false;
    readonly queriesStored: false;
    readonly layerOrder: readonly ["selection_isolated", "retrieval_controlled"];
  };
  readonly usage: RealSelectionMemoryUsageSummary;
  readonly calls: readonly RealSelectionMemoryCallEvidence[];
  readonly layers: {
    readonly selection_isolated: Omit<SelectionMemoryEvaluationReport, "sourceMode">;
    readonly retrieval_controlled: Omit<SelectionMemoryEvaluationReport, "sourceMode">;
  };
}

/** Runs the frozen two-layer calibration through a caller-owned real provider seam. */
export async function runRealSelectionMemoryCalibration(
  options: RunRealSelectionMemoryCalibrationOptions,
): Promise<RealSelectionMemoryCalibrationReport> {
  assertFrozenSelectionMemoryCalibrationPreflight(options);
  const calls: RealSelectionMemoryCallEvidence[] = [];
  const queryExpansionIndex = buildQueryExpansionIndex(options.catalog);
  const invoke = async (request: SelectionMemoryInvocationRequest) => {
    try {
      const completion = await options.complete(request);
      calls.push(Object.freeze({
        caseId: request.caseId,
        layer: request.layer,
        arm: request.arm,
        repeatIndex: request.repeatIndex,
        rawOutputHash: sha256(completion.text),
        usage: completion.usage,
        stopReason: completion.stopReason,
        ...(completion.responseModel === undefined ? {} : { responseModel: completion.responseModel }),
        ...(isProviderFailure(completion.stopReason) ? { failureCategory: "provider_error" as const } : {}),
      }));
      if (isProviderFailure(completion.stopReason)) throw new Error("selection_memory_provider_failure");
      return {
        text: completion.text,
        usage: {
          inputTokens: completion.usage.input,
          outputTokens: completion.usage.output,
          reasoningTokens: completion.usage.reasoning ?? 0,
          totalTokens: completion.usage.totalTokens,
        },
      };
    } catch (error) {
      if (!calls.some((item) =>
        item.caseId === request.caseId
        && item.layer === request.layer
        && item.arm === request.arm
        && item.repeatIndex === request.repeatIndex
      )) {
        calls.push(Object.freeze({
          caseId: request.caseId,
          layer: request.layer,
          arm: request.arm,
          repeatIndex: request.repeatIndex,
          stopReason: "error",
          failureCategory: "provider_error",
        }));
      }
      throw error;
    }
  };

  const selectionIsolated = await runSelectionMemoryEvaluation({
    layer: "selection_isolated",
    catalog: options.catalog,
    cases: options.cases,
    repeatCount: options.config.repeatCount,
    abortOnInvokerError: true,
    invoker: invoke,
  });
  const retrievalControlled = await runSelectionMemoryEvaluation({
    layer: "retrieval_controlled",
    catalog: options.catalog,
    cases: options.cases,
    repeatCount: options.config.repeatCount,
    retrieveCandidates: (item) => queryExpansionIndex.search(item.query, { limit: options.config.topK }),
    abortOnInvokerError: true,
    invoker: invoke,
  });
  if (calls.length !== options.config.expectedInvocationCount) {
    throw new Error("selection_memory_invocation_count_mismatch");
  }
  const { sourceMode: _selectionFixture, ...selectionLayer } = selectionIsolated;
  const { sourceMode: _retrievalFixture, ...retrievalLayer } = retrievalControlled;

  return Object.freeze({
    schemaVersion: 1,
    sourceMode: "real_model",
    generatedAt: options.generatedAt,
    config: options.config,
    protocol: Object.freeze({
      rawPromptsStored: false,
      rawResponsesStored: false,
      queriesStored: false,
      layerOrder: options.config.layers,
    }),
    usage: summarizeUsage(calls),
    calls: Object.freeze(calls),
    layers: Object.freeze({
      selection_isolated: selectionLayer,
      retrieval_controlled: retrievalLayer,
    }),
  });
}

export function assertFrozenSelectionMemoryCalibrationPreflight(
  options: Pick<RunRealSelectionMemoryCalibrationOptions, "catalog" | "cases" | "config">,
): void {
  if (
    computeSelectionMemoryCalibrationConfigHash(options.config) !== options.config.configHash
    || options.config.configHash !== SELECTION_MEMORY_CALIBRATION_CONFIG.configHash
  ) throw new Error("selection_memory_calibration_config_hash_mismatch");
  const catalogHash = computeCatalogHash(options.catalog);
  if (catalogHash !== options.config.catalogContentHash) {
    throw new Error("selection_memory_calibration_catalog_hash_mismatch");
  }
  const ids = options.catalog.map((item) => item.skillId).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS])) {
    throw new Error("selection_memory_calibration_catalog_membership_mismatch");
  }
  if (computeSelectionMemoryCaseSetHash(options.cases) !== options.config.calibrationCaseHash) {
    throw new Error("selection_memory_calibration_case_hash_mismatch");
  }
  if (computeGoldSetHash(catalogHash, options.cases) !== options.config.calibrationGoldSetHash) {
    throw new Error("selection_memory_calibration_gold_hash_mismatch");
  }
}

function summarizeUsage(calls: readonly RealSelectionMemoryCallEvidence[]): RealSelectionMemoryUsageSummary {
  const available = calls.filter((item) => item.usage !== undefined);
  return Object.freeze({
    available: available.length === calls.length,
    callCount: calls.length,
    input: sum(available.map((item) => item.usage!.input)),
    output: sum(available.map((item) => item.usage!.output)),
    cacheRead: sum(available.map((item) => item.usage!.cacheRead)),
    cacheWrite: sum(available.map((item) => item.usage!.cacheWrite)),
    reasoning: sum(available.map((item) => item.usage!.reasoning ?? 0)),
    totalTokens: sum(available.map((item) => item.usage!.totalTokens)),
    costTotal: sum(available.map((item) => item.usage!.cost.total)),
  });
}

function isProviderFailure(stopReason: string): boolean {
  return stopReason === "error" || stopReason === "aborted";
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
