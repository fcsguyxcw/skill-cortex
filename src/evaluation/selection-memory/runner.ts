import { createHash } from "node:crypto";

import type { SkillCandidate, SkillRecord } from "../../core/contracts/index.ts";
import {
  computeCatalogHash,
  computeGoldSetHash,
  exactSkillSetEqual,
  parseSelectionResponse,
  type SelectionParseFailure,
} from "../selection/paired.ts";
import {
  SELECTION_MEMORY_TARGET_SKILLS,
  buildSelectionMemoryEvaluationProjection,
  type SelectionMemoryEvalCase,
} from "./evidence-cases.ts";
import { projectSelectionMemoryCard, type SelectionMemoryCard } from "./memory-card.ts";
import {
  buildSelectionMemoryPrompt,
  type SelectionMemoryExperimentArm,
} from "./prompt.ts";

export const SELECTION_MEMORY_RUNNER_VERSION = 1;

export const SELECTION_MEMORY_ARMS: readonly SelectionMemoryExperimentArm[] = Object.freeze([
  "description_only",
  "positive_memory",
  "structured_memory",
]);

export type SelectionMemoryEvaluationLayer = "selection_isolated" | "retrieval_controlled";

export interface SelectionMemoryUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly totalTokens: number;
}

export interface SelectionMemoryCompletion {
  readonly text: string;
  readonly latencyMs?: number;
  readonly usage?: SelectionMemoryUsage;
}

export interface SelectionMemoryInvocationRequest {
  readonly layer: SelectionMemoryEvaluationLayer;
  readonly caseId: string;
  readonly arm: SelectionMemoryExperimentArm;
  readonly repeatIndex: number;
  readonly query: string;
  readonly prompt: string;
  readonly promptHash: string;
  readonly candidateInventory: string;
  readonly visibleCandidates: readonly SkillCandidate[];
  readonly visibleSkillIds: readonly string[];
}

export type SelectionMemoryInvoker = (
  request: SelectionMemoryInvocationRequest,
) => Promise<SelectionMemoryCompletion>;

export interface RunSelectionMemoryEvaluationOptions {
  readonly layer: SelectionMemoryEvaluationLayer;
  readonly catalog: readonly SkillRecord[];
  readonly cases: readonly SelectionMemoryEvalCase[];
  readonly repeatCount?: number;
  readonly retrieveCandidates?: (
    item: SelectionMemoryEvalCase,
    catalog: readonly SkillRecord[],
  ) => readonly SkillCandidate[];
  /** Real-provider adapters use this to stop before another billable call. */
  readonly abortOnInvokerError?: boolean;
  readonly invoker: SelectionMemoryInvoker;
}

export interface SelectionMemoryCallResult {
  readonly caseId: string;
  readonly arm: SelectionMemoryExperimentArm;
  readonly repeatIndex: number;
  readonly promptHash: string;
  readonly responseHash?: string;
  readonly strictParseFailure: boolean;
  readonly parseFailureReason?: SelectionParseFailure["reason"];
  readonly selectedSkillIds: readonly string[];
  readonly unknownSkillIds: readonly string[];
  readonly unlistedSkillIds: readonly string[];
  readonly duplicateSkillIds: readonly string[];
  readonly exactSetMatch: boolean;
  readonly memoryChars: number;
  readonly memoryTruncatedCards: number;
  readonly memoryOmittedEntries: number;
  readonly memoryOmissionReasons: Readonly<Record<string, number>>;
  readonly latencyMs: number;
  readonly usage?: SelectionMemoryUsage;
}

export interface SelectionMemoryCaseReport {
  readonly caseId: string;
  readonly labelType: SelectionMemoryEvalCase["labelType"];
  readonly language: SelectionMemoryEvalCase["language"];
  readonly hardConfuser: boolean;
  readonly goldSkillIds: readonly string[];
  readonly candidateSkillIds: readonly string[];
  readonly goldAvailable: boolean;
  readonly memoryCardCount: number;
  readonly memoryProjectionOmissions: Readonly<Record<string, number>>;
}

export interface SelectionMemoryUsageSummary {
  readonly available: boolean;
  readonly callCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

export interface SelectionMemoryArmSummary {
  readonly invocationCount: number;
  readonly exactSetMatches: number;
  readonly exactSetAccuracy: number;
  readonly exactSetAccuracyWhenGoldAvailable: number;
  readonly strictParseFailures: number;
  readonly unknownSkillIdCalls: number;
  readonly unlistedSkillIdCalls: number;
  readonly duplicateSkillIdCalls: number;
  readonly noSkillFalsePositiveCalls: number;
  readonly noSkillFalsePositiveRate: number;
  readonly repeatAgreementMean: number;
  readonly pairwiseSetJaccardMean: number;
  readonly memoryCharsMean: number;
  readonly memoryTruncatedCards: number;
  readonly memoryOmittedEntries: number;
  readonly memoryOmissionReasons: Readonly<Record<string, number>>;
  readonly latencyMeanMs: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly usage: SelectionMemoryUsageSummary;
}

export type SelectionMemoryArmSummaries = Readonly<Record<SelectionMemoryExperimentArm, SelectionMemoryArmSummary>>;

export interface SelectionMemoryEvaluationReport {
  readonly schemaVersion: 1;
  readonly sourceMode: "evaluation_fixture";
  readonly layer: SelectionMemoryEvaluationLayer;
  readonly catalogHash: string;
  readonly goldSetHash: string;
  readonly repeatCount: number;
  readonly protocol: {
    readonly armOrder: typeof SELECTION_MEMORY_ARMS;
    readonly rawPromptsStored: false;
    readonly rawResponsesStored: false;
    readonly queriesStored: false;
  };
  readonly goldAvailability: {
    readonly availableCases: number;
    readonly missedCases: number;
    readonly recallAtK: number;
  };
  readonly cases: readonly SelectionMemoryCaseReport[];
  readonly calls: readonly SelectionMemoryCallResult[];
  readonly arms: SelectionMemoryArmSummaries;
  readonly slices: Readonly<Record<"all" | "single" | "multi" | "no_skill" | "hard_confuser" | "zh" | "en", SelectionMemoryArmSummaries>>;
}

interface PreparedCase {
  readonly item: SelectionMemoryEvalCase;
  readonly candidates: readonly SkillCandidate[];
  readonly cards: readonly SelectionMemoryCard[];
  readonly goldAvailable: boolean;
  readonly projectionOmissions: Readonly<Record<string, number>>;
}

/** Evaluation-only three-arm runner. It never performs provider or retrieval I/O itself. */
export async function runSelectionMemoryEvaluation(
  options: RunSelectionMemoryEvaluationOptions,
): Promise<SelectionMemoryEvaluationReport> {
  const catalog = [...options.catalog];
  const cases = [...options.cases];
  const repeatCount = normalizeRepeatCount(options.repeatCount);
  const catalogById = validateInputs(options, catalog, cases);
  const catalogIds = new Set(catalogById.keys());
  const prepared = cases.map((item) => prepareCase(options, item, catalog, catalogById));
  const calls: SelectionMemoryCallResult[] = [];

  for (const current of prepared) {
    for (const arm of SELECTION_MEMORY_ARMS) {
      const built = buildSelectionMemoryPrompt({
        query: current.item.query,
        candidates: current.candidates,
        cards: current.cards,
        arm,
      });
      const promptHash = sha256(built.prompt);
      for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
        const startedAt = performance.now();
        let completion: SelectionMemoryCompletion | undefined;
        let parsed: ReturnType<typeof parseSelectionResponse>;
        try {
          completion = await options.invoker(Object.freeze({
            layer: options.layer,
            caseId: current.item.id,
            arm,
            repeatIndex,
            query: current.item.query,
            prompt: built.prompt,
            promptHash,
            candidateInventory: built.candidateInventory,
            visibleCandidates: Object.freeze([...current.candidates]),
            visibleSkillIds: Object.freeze([...built.visibleSkillIds]),
          }));
          parsed = parseSelectionResponse(completion.text);
        } catch {
          if (options.abortOnInvokerError === true) throw new Error("selection_memory_invoker_error");
          parsed = { ok: false, reason: "invoker_error" };
        }

        const selectedSkillIds = parsed.ok ? [...parsed.selectedSkillIds] : [];
        const duplicateSkillIds = parsed.ok ? duplicateIds(selectedSkillIds) : [];
        const unknownSkillIds = parsed.ok
          ? unique(selectedSkillIds.filter((id) => !catalogIds.has(id)))
          : [];
        const visible = new Set(built.visibleSkillIds);
        const unlistedSkillIds = parsed.ok
          ? unique(selectedSkillIds.filter((id) => catalogIds.has(id) && !visible.has(id)))
          : [];
        const validSelection = parsed.ok
          && duplicateSkillIds.length === 0
          && unknownSkillIds.length === 0
          && unlistedSkillIds.length === 0;
        const measuredLatency = Math.max(0, performance.now() - startedAt);

        calls.push(Object.freeze({
          caseId: current.item.id,
          arm,
          repeatIndex,
          promptHash,
          ...(completion === undefined ? {} : { responseHash: sha256(completion.text) }),
          strictParseFailure: !parsed.ok,
          ...(parsed.ok ? {} : { parseFailureReason: parsed.reason }),
          selectedSkillIds: Object.freeze(selectedSkillIds),
          unknownSkillIds: Object.freeze(unknownSkillIds),
          unlistedSkillIds: Object.freeze(unlistedSkillIds),
          duplicateSkillIds: Object.freeze(duplicateSkillIds),
          exactSetMatch: validSelection && exactSkillSetEqual(selectedSkillIds, current.item.goldSkillIds),
          memoryChars: built.memoryChars,
          memoryTruncatedCards: built.memoryRenders.filter((item) => item.truncated).length,
          memoryOmittedEntries: sum(built.memoryRenders.map((item) => item.omittedEntryCount)),
          memoryOmissionReasons: Object.freeze(countRenderOmissionReasons(built.memoryRenders)),
          latencyMs: completion?.latencyMs ?? measuredLatency,
          ...(completion?.usage === undefined ? {} : { usage: completion.usage }),
        }));
      }
    }
  }

  const caseReports = prepared.map((current) => Object.freeze({
    caseId: current.item.id,
    labelType: current.item.labelType,
    language: current.item.language,
    hardConfuser: current.item.hardConfuser,
    goldSkillIds: Object.freeze([...current.item.goldSkillIds]),
    candidateSkillIds: Object.freeze(current.candidates.map((item) => item.skillId)),
    goldAvailable: current.goldAvailable,
    memoryCardCount: current.cards.length,
    memoryProjectionOmissions: current.projectionOmissions,
  }));
  const availableCases = prepared.filter((item) => item.goldAvailable).length;

  return Object.freeze({
    schemaVersion: 1,
    sourceMode: "evaluation_fixture",
    layer: options.layer,
    catalogHash: computeCatalogHash(catalog),
    goldSetHash: computeGoldSetHash(computeCatalogHash(catalog), cases),
    repeatCount,
    protocol: Object.freeze({
      armOrder: SELECTION_MEMORY_ARMS,
      rawPromptsStored: false,
      rawResponsesStored: false,
      queriesStored: false,
    }),
    goldAvailability: Object.freeze({
      availableCases,
      missedCases: prepared.length - availableCases,
      recallAtK: ratio(availableCases, prepared.length),
    }),
    cases: Object.freeze(caseReports),
    calls: Object.freeze(calls),
    arms: summarizeArms(calls, caseReports),
    slices: Object.freeze({
      all: summarizeArms(calls, caseReports),
      single: summarizeArms(calls, caseReports.filter((item) => item.labelType === "single")),
      multi: summarizeArms(calls, caseReports.filter((item) => item.labelType === "multi")),
      no_skill: summarizeArms(calls, caseReports.filter((item) => item.labelType === "no_skill")),
      hard_confuser: summarizeArms(calls, caseReports.filter((item) => item.hardConfuser)),
      zh: summarizeArms(calls, caseReports.filter((item) => item.language === "zh")),
      en: summarizeArms(calls, caseReports.filter((item) => item.language === "en")),
    }),
  });
}

function prepareCase(
  options: RunSelectionMemoryEvaluationOptions,
  item: SelectionMemoryEvalCase,
  catalog: readonly SkillRecord[],
  catalogById: ReadonlyMap<string, SkillRecord>,
): PreparedCase {
  const candidates = options.layer === "selection_isolated"
    ? item.candidateSkillIds.map((id) => toCandidate(catalogById.get(id)!))
    : [...options.retrieveCandidates!(item, catalog)];
  validateCandidates(item, candidates, catalogById);
  const targetIds = new Set(SELECTION_MEMORY_TARGET_SKILLS.map((target) => target.skillId));
  const cards: SelectionMemoryCard[] = [];
  const omissions: Record<string, number> = {};

  for (const candidate of candidates) {
    if (!targetIds.has(candidate.skillId)) {
      increment(omissions, "not_target_skill");
      continue;
    }
    const projection = buildSelectionMemoryEvaluationProjection(candidate.skillId);
    const result = projectSelectionMemoryCard({
      candidate,
      profile: projection.profile,
      tenantScopeHash: projection.tenantScopeHash,
      profileTenantScopeHash: projection.tenantScopeHash,
      sourceMode: "evaluation_fixture",
      boundaryExamples: projection.boundaryExamples,
      forbiddenVerbatimTexts: [item.query],
    });
    if (result.ok) cards.push(result.card);
    else increment(omissions, result.reason);
  }

  const visibleIds = new Set(candidates.map((candidate) => candidate.skillId));
  const goldAvailable = item.goldSkillIds.length === 0
    || item.goldSkillIds.every((id) => visibleIds.has(id));
  return Object.freeze({
    item,
    candidates: Object.freeze([...candidates]),
    cards: Object.freeze(cards),
    goldAvailable,
    projectionOmissions: Object.freeze({ ...omissions }),
  });
}

function summarizeArms(
  allCalls: readonly SelectionMemoryCallResult[],
  cases: readonly SelectionMemoryCaseReport[],
): SelectionMemoryArmSummaries {
  const caseIds = new Set(cases.map((item) => item.caseId));
  return Object.freeze(Object.fromEntries(SELECTION_MEMORY_ARMS.map((arm) => [
    arm,
    summarizeArm(
      arm,
      allCalls.filter((call) => call.arm === arm && caseIds.has(call.caseId)),
      cases,
    ),
  ])) as unknown as SelectionMemoryArmSummaries);
}

function summarizeArm(
  arm: SelectionMemoryExperimentArm,
  calls: readonly SelectionMemoryCallResult[],
  cases: readonly SelectionMemoryCaseReport[],
): SelectionMemoryArmSummary {
  const byCase = new Map(cases.map((item) => [item.caseId, item]));
  const availableCalls = calls.filter((call) => byCase.get(call.caseId)?.goldAvailable === true);
  const noSkillCalls = calls.filter((call) => byCase.get(call.caseId)?.labelType === "no_skill");
  const stability = cases.map((item) => summarizeStability(calls.filter((call) => call.caseId === item.caseId)));
  const usageCalls = calls.filter((call) => call.usage !== undefined);
  const latencies = calls.map((call) => call.latencyMs);
  return Object.freeze({
    invocationCount: calls.length,
    exactSetMatches: calls.filter((call) => call.exactSetMatch).length,
    exactSetAccuracy: ratio(calls.filter((call) => call.exactSetMatch).length, calls.length),
    exactSetAccuracyWhenGoldAvailable: ratio(
      availableCalls.filter((call) => call.exactSetMatch).length,
      availableCalls.length,
    ),
    strictParseFailures: calls.filter((call) => call.strictParseFailure).length,
    unknownSkillIdCalls: calls.filter((call) => call.unknownSkillIds.length > 0).length,
    unlistedSkillIdCalls: calls.filter((call) => call.unlistedSkillIds.length > 0).length,
    duplicateSkillIdCalls: calls.filter((call) => call.duplicateSkillIds.length > 0).length,
    noSkillFalsePositiveCalls: noSkillCalls.filter((call) => call.selectedSkillIds.length > 0).length,
    noSkillFalsePositiveRate: ratio(
      noSkillCalls.filter((call) => call.selectedSkillIds.length > 0).length,
      noSkillCalls.length,
    ),
    repeatAgreementMean: mean(stability.map((item) => item.agreement)),
    pairwiseSetJaccardMean: mean(stability.map((item) => item.pairwiseJaccard)),
    memoryCharsMean: mean(calls.map((call) => call.memoryChars)),
    memoryTruncatedCards: sum(calls.map((call) => call.memoryTruncatedCards)),
    memoryOmittedEntries: sum(calls.map((call) => call.memoryOmittedEntries)),
    memoryOmissionReasons: Object.freeze(mergeCounts(calls.map((call) => call.memoryOmissionReasons))),
    latencyMeanMs: mean(latencies),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    usage: Object.freeze({
      available: usageCalls.length === calls.length,
      callCount: calls.length,
      inputTokens: sum(usageCalls.map((call) => call.usage!.inputTokens)),
      outputTokens: sum(usageCalls.map((call) => call.usage!.outputTokens)),
      reasoningTokens: sum(usageCalls.map((call) => call.usage!.reasoningTokens ?? 0)),
      totalTokens: sum(usageCalls.map((call) => call.usage!.totalTokens)),
    }),
  });
}

function summarizeStability(calls: readonly SelectionMemoryCallResult[]): {
  readonly agreement: number;
  readonly pairwiseJaccard: number;
} {
  if (calls.length === 0) return { agreement: 0, pairwiseJaccard: 0 };
  const valid = calls.every((call) =>
    !call.strictParseFailure
    && call.unknownSkillIds.length === 0
    && call.unlistedSkillIds.length === 0
    && call.duplicateSkillIds.length === 0
  );
  const canonical = calls.map((call) => [...new Set(call.selectedSkillIds)].sort().join("+"));
  const agreement = valid && new Set(canonical).size === 1 ? 1 : 0;
  if (!valid) return { agreement: 0, pairwiseJaccard: 0 };
  if (calls.length === 1) return { agreement, pairwiseJaccard: valid ? 1 : 0 };
  const pairs: number[] = [];
  for (let left = 0; left < calls.length; left += 1) {
    for (let right = left + 1; right < calls.length; right += 1) {
      pairs.push(setJaccard(calls[left]!.selectedSkillIds, calls[right]!.selectedSkillIds));
    }
  }
  return { agreement, pairwiseJaccard: mean(pairs) };
}

function validateInputs(
  options: RunSelectionMemoryEvaluationOptions,
  catalog: readonly SkillRecord[],
  cases: readonly SelectionMemoryEvalCase[],
): Map<string, SkillRecord> {
  const catalogById = new Map(catalog.map((item) => [item.skillId, item]));
  if (catalogById.size !== catalog.length) throw new RangeError("selection_memory_catalog_ids_not_unique");
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new RangeError("selection_memory_case_ids_not_unique");
  }
  if (options.layer === "retrieval_controlled" && options.retrieveCandidates === undefined) {
    throw new TypeError("selection_memory_retriever_required");
  }
  if (options.layer === "selection_isolated") {
    for (const item of cases) {
      for (const id of item.candidateSkillIds) {
        if (!catalogById.has(id)) throw new RangeError(`selection_memory_candidate_missing:${item.id}/${id}`);
      }
    }
  }
  return catalogById;
}

function validateCandidates(
  item: SelectionMemoryEvalCase,
  candidates: readonly SkillCandidate[],
  catalogById: ReadonlyMap<string, SkillRecord>,
): void {
  if (new Set(candidates.map((candidate) => candidate.skillId)).size !== candidates.length) {
    throw new RangeError(`selection_memory_candidate_ids_not_unique:${item.id}`);
  }
  for (const candidate of candidates) {
    const record = catalogById.get(candidate.skillId);
    if (record === undefined) throw new RangeError(`selection_memory_candidate_unknown:${item.id}/${candidate.skillId}`);
    if (candidate.skillRevision !== record.skillRevision) {
      throw new RangeError(`selection_memory_candidate_revision_mismatch:${item.id}/${candidate.skillId}`);
    }
  }
}

function toCandidate(record: SkillRecord): SkillCandidate {
  return {
    skillId: record.skillId,
    skillRevision: record.skillRevision,
    name: record.name,
    description: record.description,
    scope: record.scope,
    retrievalScore: 0,
    evidence: [{ kind: "declared_text", field: "description" }],
  };
}

function normalizeRepeatCount(value: number | undefined): number {
  if (value === undefined) return 3;
  if (!Number.isFinite(value) || value < 1) throw new RangeError("selection_memory_repeat_count_invalid");
  return Math.floor(value);
}

function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function setJaccard(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const id of leftSet) if (rightSet.has(id)) intersection += 1;
  return intersection / union.size;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function countRenderOmissionReasons(
  renders: readonly { readonly truncated: boolean; readonly omittedReason?: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const render of renders) {
    if (render.omittedReason !== undefined) increment(counts, render.omittedReason);
    else if (render.truncated) increment(counts, "card_char_budget");
  }
  return counts;
}

function mergeCounts(values: readonly Readonly<Record<string, number>>[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const value of values) {
    for (const [key, count] of Object.entries(value)) merged[key] = (merged[key] ?? 0) + count;
  }
  return merged;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
