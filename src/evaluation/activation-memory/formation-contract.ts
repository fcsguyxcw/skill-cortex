import { createHash } from "node:crypto";

import { tokenize } from "../../discovery/tokenize.ts";
import { ACTIVATION_MEMORY_CATALOG_HASH, FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH } from "./cases.ts";

export type ActivationMemoryRetrieverKind = "bm25" | "bm25_qe";
export type ActivationMemoryProducerKind = "none" | "naive" | "verified";
export type ActivationMemoryFormationSourceMode = "evaluation_fixture" | "formal_real_store";
export type ActivationMemoryEvidenceClass =
  | "verified_positive"
  | "near_miss"
  | "boundary"
  | "external_failure"
  | "unverified_success";

export interface ActivationMemoryExperimentCondition {
  readonly id: "A" | "B" | "C1" | "C2" | "D1" | "D2";
  readonly retriever: ActivationMemoryRetrieverKind;
  readonly producer: ActivationMemoryProducerKind;
  readonly role: "baseline" | "naive_control" | "treatment";
}

export interface ActivationMemoryFormationArtifactContract {
  readonly producer: ActivationMemoryProducerKind;
  readonly sourceMode: ActivationMemoryFormationSourceMode;
  readonly parentSkillId: string;
  readonly parentSkillRevision: string;
  readonly evidenceIds: readonly string[];
  readonly persistenceEligibility: "none" | "never" | "production_gate_required";
}

export interface ActivationMemorySemanticFeatureContract {
  readonly featureId: string;
  readonly text: string;
  readonly parentSkillId: string;
  readonly parentSkillRevision: string;
  readonly evidenceIds: readonly string[];
  readonly sourceMode: ActivationMemoryFormationSourceMode;
}

export interface ActivationMemoryEvidenceClassContract {
  readonly evidenceClass: ActivationMemoryEvidenceClass;
  readonly formationDisposition: "positive_cue" | "soft_negative_cue" | "proposal_only" | "ignore" | "reject";
  readonly requiresIndependentVerifier: boolean;
}

export interface QueryLeakageReference {
  readonly id: string;
  readonly text: string;
}

export interface QueryLeakageEvaluationCase {
  readonly id: string;
  readonly text: string;
}

export type QueryLeakageReason =
  | "exact_normalized_match"
  | "jaccard_above_threshold"
  | "evaluation_containment_above_threshold";

export interface QueryLeakagePolicy {
  readonly exactNormalizedMatchAllowed: false;
  readonly maxJaccard: number;
  readonly maxEvaluationContainment: number;
}

export interface QueryLeakageViolation {
  readonly referenceId: string;
  readonly evaluationId: string;
  readonly reasons: readonly QueryLeakageReason[];
  readonly exactNormalizedMatch: boolean;
  readonly jaccard: number;
  readonly evaluationContainment: number;
}

export interface QueryLeakageReport {
  readonly passed: boolean;
  readonly referenceCount: number;
  readonly evaluationCount: number;
  readonly comparedPairCount: number;
  readonly maxObservedJaccard: number;
  readonly maxObservedEvaluationContainment: number;
  readonly violations: readonly QueryLeakageViolation[];
}

export const ACTIVATION_MEMORY_FORMATION_CONTRACT_VERSION = 1;

export const ACTIVATION_MEMORY_LEARNING_CURVE_POINTS: readonly number[] = Object.freeze([0, 1, 2, 4, 8]);

export const ACTIVATION_MEMORY_EVIDENCE_CLASS_CONTRACTS: readonly ActivationMemoryEvidenceClassContract[] = Object.freeze([
  evidenceClass("verified_positive", "positive_cue", true),
  evidenceClass("near_miss", "soft_negative_cue", false),
  evidenceClass("boundary", "proposal_only", true),
  evidenceClass("external_failure", "ignore", false),
  evidenceClass("unverified_success", "reject", true),
]);

/**
 * A/B are no-memory retrieval baselines. C1/D1 isolate raw lexical carry-over;
 * C2/D2 are the evidence-bound treatment. This avoids calling any keyword
 * preservation effect "verified memory".
 */
export const ACTIVATION_MEMORY_EXPERIMENT_CONDITIONS: readonly ActivationMemoryExperimentCondition[] = Object.freeze([
  condition("A", "bm25", "none", "baseline"),
  condition("B", "bm25_qe", "none", "baseline"),
  condition("C1", "bm25", "naive", "naive_control"),
  condition("C2", "bm25", "verified", "treatment"),
  condition("D1", "bm25_qe", "naive", "naive_control"),
  condition("D2", "bm25_qe", "verified", "treatment"),
]);

/** Frozen before formation or retrieval output is inspected. */
export const ACTIVATION_MEMORY_QUERY_LEAKAGE_POLICY: QueryLeakagePolicy = Object.freeze({
  exactNormalizedMatchAllowed: false,
  maxJaccard: 0.5,
  maxEvaluationContainment: 0.8,
});

export function computeActivationMemoryFormationContractHash(): string {
  const payload = {
    contractVersion: ACTIVATION_MEMORY_FORMATION_CONTRACT_VERSION,
    catalogHash: ACTIVATION_MEMORY_CATALOG_HASH,
    fixtureHash: FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH,
    conditions: ACTIVATION_MEMORY_EXPERIMENT_CONDITIONS,
    learningCurvePoints: ACTIVATION_MEMORY_LEARNING_CURVE_POINTS,
    evidenceClasses: ACTIVATION_MEMORY_EVIDENCE_CLASS_CONTRACTS,
    queryLeakagePolicy: ACTIVATION_MEMORY_QUERY_LEAKAGE_POLICY,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}`;
}

export const ACTIVATION_MEMORY_FORMATION_CONTRACT_HASH =
  "sha256:a3372888d4ab4b4fb6deae36453457a29f71c676ac3f3f49942eb38f2b265541";

/**
 * Trust boundary for producer outputs.
 *
 * - none: no artifact exists;
 * - naive: evaluation-only control and never persistable;
 * - verified + evaluation_fixture: structure/ablation only, never persistable;
 * - verified + formal_real_store: still requires the existing induction,
 *   shadow evaluation and promotion gates before persistence/activation.
 */
export function formationArtifactContract(
  producer: ActivationMemoryProducerKind,
  sourceMode: ActivationMemoryFormationSourceMode,
  parentSkillId: string,
  parentSkillRevision: string,
  evidenceIds: readonly string[],
): ActivationMemoryFormationArtifactContract {
  const persistenceEligibility = producer === "none"
    ? "none"
    : producer === "naive" || sourceMode === "evaluation_fixture"
      ? "never"
      : "production_gate_required";
  return Object.freeze({
    producer,
    sourceMode,
    parentSkillId,
    parentSkillRevision,
    evidenceIds: Object.freeze([...evidenceIds]),
    persistenceEligibility,
  });
}

/**
 * Pairwise leakage audit. It returns identifiers and bounded numeric metrics,
 * never the reference/evaluation text. CJK behavior follows the same tokenizer
 * as discovery so the diagnostic matches the lexical mechanism under test.
 */
export function measureQueryLeakage(
  references: readonly QueryLeakageReference[],
  evaluationCases: readonly QueryLeakageEvaluationCase[],
  policy: QueryLeakagePolicy = ACTIVATION_MEMORY_QUERY_LEAKAGE_POLICY,
): QueryLeakageReport {
  const violations: QueryLeakageViolation[] = [];
  let maxObservedJaccard = 0;
  let maxObservedEvaluationContainment = 0;

  for (const reference of references) {
    const referenceTokens = new Set(tokenize(reference.text));
    const normalizedReference = normalizeForExactMatch(reference.text);
    for (const evaluationCase of evaluationCases) {
      const evaluationTokens = new Set(tokenize(evaluationCase.text));
      const exactNormalizedMatch = normalizedReference !== "" && normalizedReference === normalizeForExactMatch(evaluationCase.text);
      const intersectionSize = intersectionCount(referenceTokens, evaluationTokens);
      const unionSize = new Set([...referenceTokens, ...evaluationTokens]).size;
      const jaccard = unionSize === 0 ? 0 : intersectionSize / unionSize;
      const evaluationContainment = evaluationTokens.size === 0 ? 0 : intersectionSize / evaluationTokens.size;
      maxObservedJaccard = Math.max(maxObservedJaccard, jaccard);
      maxObservedEvaluationContainment = Math.max(maxObservedEvaluationContainment, evaluationContainment);

      const reasons: QueryLeakageReason[] = [];
      if (exactNormalizedMatch) reasons.push("exact_normalized_match");
      if (jaccard > policy.maxJaccard) reasons.push("jaccard_above_threshold");
      if (evaluationContainment > policy.maxEvaluationContainment) reasons.push("evaluation_containment_above_threshold");
      if (reasons.length === 0) continue;
      violations.push(Object.freeze({
        referenceId: reference.id,
        evaluationId: evaluationCase.id,
        reasons: Object.freeze(reasons),
        exactNormalizedMatch,
        jaccard,
        evaluationContainment,
      }));
    }
  }

  return Object.freeze({
    passed: violations.length === 0,
    referenceCount: references.length,
    evaluationCount: evaluationCases.length,
    comparedPairCount: references.length * evaluationCases.length,
    maxObservedJaccard,
    maxObservedEvaluationContainment,
    violations: Object.freeze(violations),
  });
}

function condition(
  id: ActivationMemoryExperimentCondition["id"],
  retriever: ActivationMemoryRetrieverKind,
  producer: ActivationMemoryProducerKind,
  role: ActivationMemoryExperimentCondition["role"],
): ActivationMemoryExperimentCondition {
  return Object.freeze({ id, retriever, producer, role });
}

function evidenceClass(
  value: ActivationMemoryEvidenceClass,
  formationDisposition: ActivationMemoryEvidenceClassContract["formationDisposition"],
  requiresIndependentVerifier: boolean,
): ActivationMemoryEvidenceClassContract {
  return Object.freeze({ evidenceClass: value, formationDisposition, requiresIndependentVerifier });
}

function normalizeForExactMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function intersectionCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}
