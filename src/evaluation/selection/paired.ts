/**
 * Paired model-side selection evaluation.
 *
 * This module is deliberately an evaluation seam, not a host/model adapter.
 * The catalog, cases and model invoker are supplied by the caller; the report
 * is therefore always marked `evaluation_fixture` and can never be promoted to
 * formal real-model evidence. Each case is sent to the same injected invoker
 * twice: once with the full catalog and once with the bounded Top-K cards.
 */

import { createHash } from "node:crypto";

import type {
  SkillCandidate,
  SkillRecord,
} from "../../core/contracts/index.ts";
import {
  buildIndex,
  DEFAULT_TOP_K,
  formatCandidateCards,
  MAX_TOP_K,
} from "../../discovery/index.ts";

export const SELECTION_SOURCE_MODE = "evaluation_fixture" as const;
export const ESTIMATED_TOKEN_METHOD = "ceil(promptChars / 4)" as const;

export type SelectionArm = "full_catalog" | "top_k";

/** Structural subset accepted from the hand-authored Phase 1 cases. */
export interface SelectionEvalCase {
  readonly id: string;
  readonly query: string;
  readonly goldSkillIds: readonly string[];
}

/** Only the visible arm prompt and cards are exposed to the model invoker. */
export interface SelectionInvocationRequest {
  readonly arm: SelectionArm;
  readonly caseId: string;
  readonly query: string;
  readonly prompt: string;
  readonly visibleCandidates: readonly SkillCandidate[];
  readonly visibleSkillIds: readonly string[];
  readonly sourceMode: typeof SELECTION_SOURCE_MODE;
}

/** Injected model seam. Real model calls are intentionally outside this core. */
export type SelectionModelInvoker = (
  request: SelectionInvocationRequest,
) => Promise<string>;

export interface RunSelectionPairedOptions {
  readonly catalog: readonly SkillRecord[];
  readonly cases: readonly SelectionEvalCase[];
  /** Requested Top-K budget; `buildIndex` clamps it to the supported range. */
  readonly topK?: number;
  readonly invoker: SelectionModelInvoker;
}

/**
 * Hash only the immutable catalog identity/content fields used by selection.
 * The canonical JSON is a compact array sorted by `skillId`; object key order
 * is explicit in the mapping below and input order cannot affect the result.
 */
export function computeCatalogHash(
  catalog: readonly SkillRecord[],
): string {
  const canonicalCatalog = [...catalog]
    .map((skill) => ({
      skillId: skill.skillId,
      skillRevision: skill.skillRevision,
      name: skill.name,
      description: skill.description,
    }))
    .sort((left, right) => compareStrings(left.skillId, right.skillId));
  return sha256Canonical(canonicalCatalog);
}

/**
 * Hash the catalog binding and hand-authored gold cases. Cases and each gold
 * set are sorted before serialization so fixture file order is not identity.
 */
export function computeGoldSetHash(
  catalogHash: string,
  cases: readonly SelectionEvalCase[],
): string {
  const canonicalGoldSet = {
    catalogHash,
    cases: [...cases]
      .map((item) => ({
        id: item.id,
        query: item.query,
        goldSkillIds: [...item.goldSkillIds].sort(compareStrings),
      }))
      .sort((left, right) => compareStrings(left.id, right.id)),
  };
  return sha256Canonical(canonicalGoldSet);
}

export interface ParsedSelectionResponse {
  readonly ok: true;
  readonly selectedSkillIds: string[];
}

export interface SelectionParseFailure {
  readonly ok: false;
  readonly reason:
    | "not_json"
    | "wrong_root"
    | "wrong_keys"
    | "wrong_selected_skill_ids"
    | "invoker_error";
}

export type SelectionResponseParseResult =
  | ParsedSelectionResponse
  | SelectionParseFailure;

export interface SelectionCaseResult {
  readonly caseId: string;
  readonly arm: SelectionArm;
  readonly goldSkillIds: string[];
  readonly retrievedSkillIds: string[];
  readonly retrievalGoldAvailable: boolean;
  readonly strictParseFailure: boolean;
  readonly parseFailureReason?: SelectionParseFailure["reason"];
  readonly selectedSkillIds: string[];
  /** Selected IDs that do not occur in the catalog at all. */
  readonly unknownSkillIds: string[];
  /** Selected catalog IDs omitted from this arm's visible cards. */
  readonly unlistedSkillIds: string[];
  readonly duplicateSkillIds: string[];
  readonly exactSetMatch: boolean;
  readonly promptChars: number;
  /** Estimated with `ceil(promptChars / 4)`; this is not a tokenizer count. */
  readonly estimatedTokens: number;
  readonly latencyMs: number;
}

export interface SelectionArmReport {
  readonly arm: SelectionArm;
  readonly caseCount: number;
  readonly cases: SelectionCaseResult[];
  readonly retrievalGoldAvailable: number;
  readonly retrievalGoldMiss: number;
  readonly retrievalGoldAvailability: number;
  readonly retrievalGoldMissRate: number;
  readonly strictParseFailures: number;
  readonly unknownSkillIds: number;
  readonly unknownSkillIdCases: number;
  readonly unlistedSkillIds: number;
  readonly unlistedSkillIdCases: number;
  /** Total invalid selected IDs (unknown + unlisted). */
  readonly invalidSkillIds: number;
  readonly invalidSkillIdCases: number;
  readonly duplicateSkillIds: number;
  readonly duplicateSkillIdCases: number;
  readonly exactSetMatches: number;
  readonly exactSetAccuracy: number;
  /** Exact-set accuracy restricted to retrieval-gold-available cases. */
  readonly exactSetAccuracyWhenGoldAvailable: number;
  /** Sum of UTF-16 prompt code units over all cases in this arm. */
  readonly promptChars: number;
  /** Sum of `ceil(promptChars / 4)` per case; explicitly an estimate. */
  readonly estimatedTokens: number;
  readonly tokenEstimateMethod: typeof ESTIMATED_TOKEN_METHOD;
  readonly promptCharsMean: number;
  readonly estimatedTokensMean: number;
  readonly latencyMeanMs: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
}

export interface SelectionPairedCaseResult {
  readonly caseId: string;
  readonly fullCatalog: SelectionCaseResult;
  readonly topK: SelectionCaseResult;
}

export interface SelectionPairedReport {
  readonly schemaVersion: 1;
  readonly sourceMode: typeof SELECTION_SOURCE_MODE;
  readonly catalogHash: string;
  readonly goldSetHash: string;
  readonly catalogSize: number;
  readonly caseCount: number;
  /** Effective Top-K candidate budget used by the retrieval arm. */
  readonly topKLimit: number;
  readonly fullCatalog: SelectionArmReport;
  readonly topK: SelectionArmReport;
  readonly cases: SelectionPairedCaseResult[];
}

/**
 * Parse the model contract exactly: one JSON object with one key and a string
 * array value. Markdown fences, prose, extra keys and non-string items fail.
 */
export function parseSelectionResponse(
  raw: string,
): SelectionResponseParseResult {
  if (typeof raw !== "string") return { ok: false, reason: "not_json" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "not_json" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "wrong_root" };
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "selected_skill_ids") {
    return { ok: false, reason: "wrong_keys" };
  }

  const selected = (parsed as { selected_skill_ids?: unknown })
    .selected_skill_ids;
  if (!Array.isArray(selected) || !selected.every((id) => typeof id === "string")) {
    return { ok: false, reason: "wrong_selected_skill_ids" };
  }

  return { ok: true, selectedSkillIds: [...selected] };
}

/**
 * Set equality for selection labels. Both sides must be duplicate-free; order
 * is irrelevant. This is intentionally stricter than comparing sorted arrays.
 */
export function exactSkillSetEqual(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actualSet.size !== actual.length || expectedSet.size !== expected.length) {
    return false;
  }
  if (actualSet.size !== expectedSet.size) return false;
  for (const id of expectedSet) {
    if (!actualSet.has(id)) return false;
  }
  return true;
}

/** Naive, explicit estimate used by the report; no model tokenizer is implied. */
export function estimateSelectionTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}

/** Build the prompt for an arm without exposing any hidden catalog entries. */
export function buildSelectionPrompt(
  query: string,
  arm: SelectionArm,
  candidates: readonly SkillCandidate[],
): string {
  const inventory =
    arm === "full_catalog"
      ? formatFullCatalog(candidates)
      : formatCandidateCards(candidates);
  return [
    "You select installed skills for the task below.",
    'Output exactly one JSON object: {"selected_skill_ids":["skill-id"]}.',
    "Do not output markdown or explanatory text.",
    "",
    `Task: ${query}`,
    "",
    inventory,
  ].join("\n");
}

/** Full-catalog comparator inventory: every name and complete description. */
export function formatFullCatalog(
  candidates: readonly SkillCandidate[],
): string {
  if (candidates.length === 0) return "(empty skill catalog)";
  const lines: string[] = [];
  candidates.forEach((candidate, index) => {
    lines.push(
      `${index + 1}. ${candidate.name} [skill_id=${candidate.skillId}, scope=${candidate.scope}, skill_revision=${candidate.skillRevision}]`,
    );
    lines.push(`   ${candidate.description}`);
  });
  return ["## Full skill catalog", "", ...lines].join("\n");
}

/**
 * Run the paired selection comparator. The invoker is called exactly once for
 * each arm/case pair and always receives a fixture provenance marker.
 */
export async function runSelectionPaired(
  options: RunSelectionPairedOptions,
): Promise<SelectionPairedReport> {
  const catalog = [...options.catalog];
  const cases = [...options.cases];
  const topK = normalizeTopK(options.topK);
  const catalogIds = new Set(catalog.map((record) => record.skillId));
  validateInputs(catalog, cases, catalogIds);
  const catalogHash = computeCatalogHash(catalog);
  const goldSetHash = computeGoldSetHash(catalogHash, cases);
  const index = buildIndex(catalog);
  const fullCandidates = catalog.map(toFullCatalogCandidate);

  const fullCatalog = await evaluateArm({
    arm: "full_catalog",
    candidatesFor: () => fullCandidates,
    catalogIds,
    cases,
    invoker: options.invoker,
  });
  const topKArm = await evaluateArm({
    arm: "top_k",
    candidatesFor: (item) => index.search(item.query, { limit: topK }),
    catalogIds,
    cases,
    invoker: options.invoker,
  });

  const pairedCases: SelectionPairedCaseResult[] = cases.map((item, indexOfCase) => ({
    caseId: item.id,
    fullCatalog: fullCatalog.cases[indexOfCase]!,
    topK: topKArm.cases[indexOfCase]!,
  }));

  return {
    schemaVersion: 1,
    sourceMode: SELECTION_SOURCE_MODE,
    catalogHash,
    goldSetHash,
    catalogSize: catalog.length,
    caseCount: cases.length,
    topKLimit: topK,
    fullCatalog,
    topK: topKArm,
    cases: pairedCases,
  };
}

interface EvaluateArmInput {
  readonly arm: SelectionArm;
  readonly candidatesFor: (item: SelectionEvalCase) => readonly SkillCandidate[];
  readonly catalogIds: ReadonlySet<string>;
  readonly cases: readonly SelectionEvalCase[];
  readonly invoker: SelectionModelInvoker;
}

async function evaluateArm(input: EvaluateArmInput): Promise<SelectionArmReport> {
  const results: SelectionCaseResult[] = [];

  for (const item of input.cases) {
    const candidates = [...input.candidatesFor(item)];
    const retrievedSkillIds = candidates.map((candidate) => candidate.skillId);
    const visibleSkillIds = [...new Set(retrievedSkillIds)];
    const prompt = buildSelectionPrompt(item.query, input.arm, candidates);
    const request: SelectionInvocationRequest = Object.freeze({
      arm: input.arm,
      caseId: item.id,
      query: item.query,
      prompt,
      visibleCandidates: Object.freeze(candidates),
      visibleSkillIds: Object.freeze(visibleSkillIds),
      sourceMode: SELECTION_SOURCE_MODE,
    });

    const startedAt = performance.now();
    let parsed: SelectionResponseParseResult;
    try {
      parsed = parseSelectionResponse(await input.invoker(request));
    } catch {
      parsed = { ok: false, reason: "invoker_error" };
    }
    const latencyMs = Math.max(0, performance.now() - startedAt);

    const selectedSkillIds = parsed.ok ? [...parsed.selectedSkillIds] : [];
    const duplicateSkillIds = parsed.ok
      ? duplicateIds(selectedSkillIds)
      : [];
    const unknownSkillIds = parsed.ok
      ? uniqueIds(selectedSkillIds.filter((id) => !input.catalogIds.has(id)))
      : [];
    const unlistedSkillIds = parsed.ok
      ? uniqueIds(
          selectedSkillIds.filter(
            (id) => input.catalogIds.has(id) && !visibleSkillIds.includes(id),
          ),
        )
      : [];
    const retrievalGoldAvailable =
      item.goldSkillIds.length === 0 ||
      item.goldSkillIds.every((id) => visibleSkillIds.includes(id));
    const exactSetMatch =
      parsed.ok &&
      duplicateSkillIds.length === 0 &&
      unknownSkillIds.length === 0 &&
      unlistedSkillIds.length === 0 &&
      exactSkillSetEqual(selectedSkillIds, item.goldSkillIds);

    results.push({
      caseId: item.id,
      arm: input.arm,
      goldSkillIds: [...item.goldSkillIds],
      retrievedSkillIds,
      retrievalGoldAvailable,
      strictParseFailure: !parsed.ok,
      ...(parsed.ok ? {} : { parseFailureReason: parsed.reason }),
      selectedSkillIds,
      unknownSkillIds,
      unlistedSkillIds,
      duplicateSkillIds,
      exactSetMatch,
      promptChars: prompt.length,
      estimatedTokens: estimateSelectionTokens(prompt),
      latencyMs,
    });
  }

  return summarizeArm(input.arm, results);
}

function summarizeArm(
  arm: SelectionArm,
  cases: SelectionCaseResult[],
): SelectionArmReport {
  const caseCount = cases.length;
  const retrievalGoldAvailable = cases.filter(
    (item) => item.retrievalGoldAvailable,
  ).length;
  const retrievalGoldMiss = caseCount - retrievalGoldAvailable;
  const strictParseFailures = cases.filter((item) => item.strictParseFailure).length;
  const unknownSkillIds = cases.reduce(
    (sum, item) => sum + item.unknownSkillIds.length,
    0,
  );
  const unknownSkillIdCases = cases.filter(
    (item) => item.unknownSkillIds.length > 0,
  ).length;
  const unlistedSkillIds = cases.reduce(
    (sum, item) => sum + item.unlistedSkillIds.length,
    0,
  );
  const unlistedSkillIdCases = cases.filter(
    (item) => item.unlistedSkillIds.length > 0,
  ).length;
  const invalidSkillIds = unknownSkillIds + unlistedSkillIds;
  const invalidSkillIdCases = cases.filter(
    (item) => item.unknownSkillIds.length > 0 || item.unlistedSkillIds.length > 0,
  ).length;
  const duplicateSkillIds = cases.reduce(
    (sum, item) => sum + item.duplicateSkillIds.length,
    0,
  );
  const duplicateSkillIdCases = cases.filter(
    (item) => item.duplicateSkillIds.length > 0,
  ).length;
  const exactSetMatches = cases.filter((item) => item.exactSetMatch).length;
  const promptChars = cases.reduce((sum, item) => sum + item.promptChars, 0);
  const estimatedTokens = cases.reduce(
    (sum, item) => sum + item.estimatedTokens,
    0,
  );
  const latencies = cases.map((item) => item.latencyMs);
  const latencyMeanMs = mean(latencies);

  return {
    arm,
    caseCount,
    cases,
    retrievalGoldAvailable,
    retrievalGoldMiss,
    retrievalGoldAvailability: ratio(retrievalGoldAvailable, caseCount),
    retrievalGoldMissRate: ratio(retrievalGoldMiss, caseCount),
    strictParseFailures,
    unknownSkillIds,
    unknownSkillIdCases,
    unlistedSkillIds,
    unlistedSkillIdCases,
    invalidSkillIds,
    invalidSkillIdCases,
    duplicateSkillIds,
    duplicateSkillIdCases,
    exactSetMatches,
    exactSetAccuracy: ratio(exactSetMatches, caseCount),
    exactSetAccuracyWhenGoldAvailable: ratio(
      cases.filter((item) => item.retrievalGoldAvailable && item.exactSetMatch)
        .length,
      retrievalGoldAvailable,
    ),
    promptChars,
    estimatedTokens,
    tokenEstimateMethod: ESTIMATED_TOKEN_METHOD,
    promptCharsMean: mean(cases.map((item) => item.promptChars)),
    estimatedTokensMean: mean(cases.map((item) => item.estimatedTokens)),
    latencyMeanMs,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
  };
}

function toFullCatalogCandidate(record: SkillRecord): SkillCandidate {
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

function validateInputs(
  catalog: readonly SkillRecord[],
  cases: readonly SelectionEvalCase[],
  catalogIds: ReadonlySet<string>,
): void {
  if (catalogIds.size !== catalog.length) {
    throw new RangeError("catalog skill IDs must be unique");
  }
  const caseIds = new Set<string>();
  for (const item of cases) {
    if (caseIds.has(item.id)) {
      throw new RangeError(`case IDs must be unique: ${item.id}`);
    }
    caseIds.add(item.id);
    if (new Set(item.goldSkillIds).size !== item.goldSkillIds.length) {
      throw new RangeError(`gold skill IDs must be unique: ${item.id}`);
    }
    for (const skillId of item.goldSkillIds) {
      if (!catalogIds.has(skillId)) {
        throw new RangeError(
          `gold skill id is not present in catalog: ${item.id}/${skillId}`,
        );
      }
    }
  }
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

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function normalizeTopK(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TOP_K;
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), MAX_TOP_K);
}

function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index]!;
}
