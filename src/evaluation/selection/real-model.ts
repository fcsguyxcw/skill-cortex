import { createHash } from "node:crypto";

import type { SkillRecord } from "../../core/contracts/index.ts";
import {
  computeCatalogHash,
  computeGoldSetHash,
  runSelectionPaired,
  type SelectionArm,
  type SelectionEvalCase,
  type SelectionInvocationRequest,
  type SelectionPairedReport,
} from "./paired.ts";

export const REAL_SELECTION_SOURCE_MODE = "real_model" as const;

export interface SelectionUsage {
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

export interface RealSelectionCompletion {
  readonly text: string;
  readonly usage: SelectionUsage;
  readonly stopReason: string;
  readonly responseModel?: string;
}

export type RealSelectionCompleter = (
  request: SelectionInvocationRequest,
) => Promise<RealSelectionCompletion>;

export interface RealSelectionModelConfig {
  readonly provider: string;
  readonly modelId: string;
  readonly api: string;
  readonly thinkingLevel: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

export interface RunRealSelectionOptions {
  readonly catalog: readonly SkillRecord[];
  readonly cases: readonly SelectionEvalCase[];
  readonly expectedCatalogHash: string;
  readonly expectedGoldSetHash: string;
  readonly topK: number;
  readonly generatedAt: string;
  readonly model: RealSelectionModelConfig;
  readonly complete: RealSelectionCompleter;
}

export interface RealSelectionCallEvidence {
  readonly caseId: string;
  readonly arm: SelectionArm;
  readonly rawOutputHash?: string;
  readonly usage?: SelectionUsage;
  readonly stopReason: string;
  readonly responseModel?: string;
  readonly failureCategory?: "provider_error";
}

export interface SelectionUsageSummary {
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

export interface RealSelectionReport {
  readonly schemaVersion: 1;
  readonly sourceMode: typeof REAL_SELECTION_SOURCE_MODE;
  readonly generatedAt: string;
  readonly model: RealSelectionModelConfig;
  readonly protocol: {
    readonly topK: number;
    readonly armOrder: "full_catalog_then_top_k";
    readonly rawPromptsStored: false;
    readonly rawResponsesStored: false;
  };
  readonly usage: {
    readonly fullCatalog: SelectionUsageSummary;
    readonly topK: SelectionUsageSummary;
    readonly total: SelectionUsageSummary;
  };
  readonly calls: readonly RealSelectionCallEvidence[];
  readonly paired: Omit<SelectionPairedReport, "sourceMode">;
}

/**
 * Run a frozen dev comparator through a caller-owned real provider adapter.
 * The catalog and Gold hashes are checked before the first billable call.
 * Only parsed IDs, response hashes, usage and failure categories are retained.
 */
export async function runRealSelectionPaired(
  options: RunRealSelectionOptions,
): Promise<RealSelectionReport> {
  const catalogHash = computeCatalogHash(options.catalog);
  if (catalogHash !== options.expectedCatalogHash) {
    throw new Error("selection_catalog_hash_mismatch");
  }
  const goldSetHash = computeGoldSetHash(catalogHash, options.cases);
  if (goldSetHash !== options.expectedGoldSetHash) {
    throw new Error("selection_gold_set_hash_mismatch");
  }

  const calls: RealSelectionCallEvidence[] = [];
  const pairedWithFixtureMarker = await runSelectionPaired({
    catalog: options.catalog,
    cases: options.cases,
    topK: options.topK,
    invoker: async (request) => {
      try {
        const completion = await options.complete(request);
        calls.push({
          caseId: request.caseId,
          arm: request.arm,
          rawOutputHash: sha256(completion.text),
          usage: completion.usage,
          stopReason: completion.stopReason,
          ...(completion.stopReason === "error" || completion.stopReason === "aborted"
            ? { failureCategory: "provider_error" as const }
            : {}),
          ...(completion.responseModel === undefined
            ? {}
            : { responseModel: completion.responseModel }),
        });
        if (completion.stopReason === "error" || completion.stopReason === "aborted") {
          throw new Error("selection_provider_failure");
        }
        return completion.text;
      } catch {
        if (!calls.some(
          (item) => item.caseId === request.caseId && item.arm === request.arm,
        )) {
          calls.push({
            caseId: request.caseId,
            arm: request.arm,
            stopReason: "error",
            failureCategory: "provider_error",
          });
        }
        throw new Error("selection_provider_failure");
      }
    },
  });
  const { sourceMode: _fixtureMarker, ...paired } = pairedWithFixtureMarker;

  return {
    schemaVersion: 1,
    sourceMode: REAL_SELECTION_SOURCE_MODE,
    generatedAt: options.generatedAt,
    model: options.model,
    protocol: {
      topK: options.topK,
      armOrder: "full_catalog_then_top_k",
      rawPromptsStored: false,
      rawResponsesStored: false,
    },
    usage: {
      fullCatalog: summarizeUsage(calls.filter((item) => item.arm === "full_catalog")),
      topK: summarizeUsage(calls.filter((item) => item.arm === "top_k")),
      total: summarizeUsage(calls),
    },
    calls,
    paired,
  };
}

function summarizeUsage(
  calls: readonly RealSelectionCallEvidence[],
): SelectionUsageSummary {
  const available = calls.filter((item) => item.usage !== undefined);
  return {
    available: available.length === calls.length,
    callCount: calls.length,
    input: sum(available, (item) => item.usage!.input),
    output: sum(available, (item) => item.usage!.output),
    cacheRead: sum(available, (item) => item.usage!.cacheRead),
    cacheWrite: sum(available, (item) => item.usage!.cacheWrite),
    reasoning: sum(available, (item) => item.usage!.reasoning ?? 0),
    totalTokens: sum(available, (item) => item.usage!.totalTokens),
    costTotal: sum(available, (item) => item.usage!.cost.total),
  };
}

function sum(
  items: readonly RealSelectionCallEvidence[],
  select: (item: RealSelectionCallEvidence) => number,
): number {
  return items.reduce((total, item) => total + select(item), 0);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
