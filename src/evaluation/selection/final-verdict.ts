import type { FrozenSelectionFinalHeldoutCase } from "./final-heldout-cases.ts";
import type { FrozenFinalSelectionReport } from "./final-runner.ts";
import {
  FINAL_SELECTION_THRESHOLD_CONFIG_HASH,
  FINAL_SELECTION_THRESHOLDS,
} from "./final-thresholds.ts";

export type FinalSelectionBreakdown =
  | "single"
  | "multi"
  | "no_skill"
  | "hard_confuser"
  | "zh"
  | "en"
  | "overall";

export interface FinalSelectionBreakdownResult {
  readonly caseCount: number;
  readonly fullCatalogExactSetAccuracy: number;
  readonly topKExactSetAccuracy: number;
  readonly topKRetrievalGoldAvailability: number;
}

export interface FinalSelectionGateResult {
  readonly passed: boolean;
  readonly actual: number | null;
  readonly threshold: number;
}

export interface FinalSelectionVerdict {
  readonly schemaVersion: 1;
  readonly thresholdConfigHash: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly gates: {
    readonly retrievalGoldAvailability: FinalSelectionGateResult;
    readonly pairedExactSetRegressionWhenGoldAvailable: FinalSelectionGateResult;
    readonly noSkillAccuracyRegression: FinalSelectionGateResult;
    readonly fullCatalogStrictParseFailureRate: FinalSelectionGateResult;
    readonly topKStrictParseFailureRate: FinalSelectionGateResult;
    readonly fullCatalogInvalidSkillIdCaseRate: FinalSelectionGateResult;
    readonly topKInvalidSkillIdCaseRate: FinalSelectionGateResult;
    readonly actualInputTokenReduction: FinalSelectionGateResult;
  };
  readonly breakdowns: Readonly<Record<FinalSelectionBreakdown, FinalSelectionBreakdownResult>>;
}

/** Compute the frozen v1 gates without model- or retriever-dependent judgment. */
export function evaluateFinalSelection(
  report: Pick<FrozenFinalSelectionReport, "paired" | "usage">,
  cases: readonly FrozenSelectionFinalHeldoutCase[],
): FinalSelectionVerdict {
  const metadata = new Map(cases.map((item) => [item.id, item]));
  if (metadata.size !== cases.length || report.paired.cases.length !== cases.length) {
    throw new Error("final_selection_verdict_case_set_mismatch");
  }
  for (const item of report.paired.cases) {
    if (!metadata.has(item.caseId)) throw new Error("final_selection_verdict_case_set_mismatch");
  }

  const topKAvailable = report.paired.cases.filter((item) => item.topK.retrievalGoldAvailable);
  const fullAvailableAccuracy = accuracy(topKAvailable, (item) => item.fullCatalog.exactSetMatch);
  const topKAvailableAccuracy = accuracy(topKAvailable, (item) => item.topK.exactSetMatch);
  const pairedRegression = fullAvailableAccuracy - topKAvailableAccuracy;
  const noSkill = report.paired.cases.filter(
    (item) => metadata.get(item.caseId)!.labelType === "no_skill",
  );
  const noSkillRegression =
    accuracy(noSkill, (item) => item.fullCatalog.exactSetMatch) -
    accuracy(noSkill, (item) => item.topK.exactSetMatch);
  const inputReduction = report.usage.fullCatalog.available &&
      report.usage.topK.available && report.usage.fullCatalog.input > 0
    ? 1 - report.usage.topK.input / report.usage.fullCatalog.input
    : null;
  const count = report.paired.caseCount;

  const gates = {
    retrievalGoldAvailability: minimumGate(
      report.paired.topK.retrievalGoldAvailability,
      FINAL_SELECTION_THRESHOLDS.minimumRetrievalGoldAvailability,
    ),
    pairedExactSetRegressionWhenGoldAvailable: maximumGate(
      pairedRegression,
      FINAL_SELECTION_THRESHOLDS.maximumPairedExactSetRegressionWhenGoldAvailable,
    ),
    noSkillAccuracyRegression: maximumGate(
      noSkillRegression,
      FINAL_SELECTION_THRESHOLDS.maximumNoSkillAccuracyRegression,
    ),
    fullCatalogStrictParseFailureRate: maximumGate(
      report.paired.fullCatalog.strictParseFailures / count,
      FINAL_SELECTION_THRESHOLDS.maximumStrictParseFailureRate,
    ),
    topKStrictParseFailureRate: maximumGate(
      report.paired.topK.strictParseFailures / count,
      FINAL_SELECTION_THRESHOLDS.maximumStrictParseFailureRate,
    ),
    fullCatalogInvalidSkillIdCaseRate: maximumGate(
      report.paired.fullCatalog.invalidSkillIdCases / count,
      FINAL_SELECTION_THRESHOLDS.maximumInvalidSkillIdCaseRate,
    ),
    topKInvalidSkillIdCaseRate: maximumGate(
      report.paired.topK.invalidSkillIdCases / count,
      FINAL_SELECTION_THRESHOLDS.maximumInvalidSkillIdCaseRate,
    ),
    actualInputTokenReduction: minimumGate(
      inputReduction,
      FINAL_SELECTION_THRESHOLDS.minimumActualInputTokenReduction,
    ),
  };
  const failures = Object.entries(gates)
    .filter(([, gate]) => !gate.passed)
    .map(([name]) => name);

  return {
    schemaVersion: 1,
    thresholdConfigHash: FINAL_SELECTION_THRESHOLD_CONFIG_HASH,
    passed: failures.length === 0,
    failures,
    gates,
    breakdowns: {
      single: breakdown(report, metadata, (item) => item.labelType === "single"),
      multi: breakdown(report, metadata, (item) => item.labelType === "multi"),
      no_skill: breakdown(report, metadata, (item) => item.labelType === "no_skill"),
      hard_confuser: breakdown(report, metadata, (item) => item.hardConfuser),
      zh: breakdown(report, metadata, (item) => item.language === "zh"),
      en: breakdown(report, metadata, (item) => item.language === "en"),
      overall: breakdown(report, metadata, () => true),
    },
  };
}

function breakdown(
  report: Pick<FrozenFinalSelectionReport, "paired">,
  metadata: ReadonlyMap<string, FrozenSelectionFinalHeldoutCase>,
  include: (item: FrozenSelectionFinalHeldoutCase) => boolean,
): FinalSelectionBreakdownResult {
  const selected = report.paired.cases.filter((item) => include(metadata.get(item.caseId)!));
  return {
    caseCount: selected.length,
    fullCatalogExactSetAccuracy: accuracy(selected, (item) => item.fullCatalog.exactSetMatch),
    topKExactSetAccuracy: accuracy(selected, (item) => item.topK.exactSetMatch),
    topKRetrievalGoldAvailability: accuracy(
      selected,
      (item) => item.topK.retrievalGoldAvailable,
    ),
  };
}

function accuracy<T>(items: readonly T[], matches: (item: T) => boolean): number {
  if (items.length === 0) return 0;
  return items.filter(matches).length / items.length;
}

function minimumGate(actual: number | null, threshold: number): FinalSelectionGateResult {
  return { passed: actual !== null && actual >= threshold, actual, threshold };
}

function maximumGate(actual: number | null, threshold: number): FinalSelectionGateResult {
  return { passed: actual !== null && actual <= threshold, actual, threshold };
}
