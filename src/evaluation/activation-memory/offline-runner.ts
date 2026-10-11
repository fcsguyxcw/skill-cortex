import type { ActivationProfile, SkillCandidate, SkillRecord } from "../../core/contracts/index.ts";
import { matchLearnedOverlay } from "../../activation/rerank.ts";
import { buildIndex } from "../../discovery/bm25.ts";
import { buildQueryExpansionIndex } from "../../discovery/query-expansion.ts";
import type {
  ActivationMemoryEvalCase,
  ActivationMemoryExperienceCase,
  ActivationMemoryTargetSkill,
} from "./cases.ts";
import {
  ACTIVATION_MEMORY_EXPERIMENT_CONDITIONS,
  type ActivationMemoryExperimentCondition,
} from "./formation-contract.ts";
import {
  DEFAULT_EVALUATION_TENANT_SCOPE_HASH,
  evaluationProfilesForScope,
  formEvaluationActivationMemory,
  measureEvaluationFormationCueLeakage,
  type EvaluationFormationArtifact,
} from "./formation.ts";

export interface ActivationMemoryOfflineCaseResult {
  readonly caseId: string;
  readonly language: "zh" | "en";
  readonly labelType: "single" | "multi" | "no_skill";
  readonly hardConfuser: boolean;
  readonly goldSkillIds: readonly string[];
  readonly candidateSkillIds: readonly string[];
  readonly learnedCandidateSkillIds: readonly string[];
  readonly matchedExpansionRuleIds: readonly string[];
  readonly goldAvailable: boolean | null;
  readonly perGoldRecall: number | null;
  readonly reciprocalRank: number | null;
  /** Memory-specific FP: at least one learned-cue candidate on a No-Skill case. */
  readonly noSkillFalsePositive: boolean;
  /** A learned-cue candidate outside Gold on a hard-confuser case. */
  readonly hardConfuserFalsePositive: boolean;
}

export interface ActivationMemoryDiscoveryMetrics {
  readonly caseCount: number;
  readonly goldCaseCount: number;
  readonly goldAvailableCases: number;
  readonly goldAvailabilityRecallAtK: number | null;
  readonly multiSkillCaseCount: number;
  readonly multiSkillFullSetAvailableCases: number;
  readonly multiSkillFullSetAvailability: number | null;
  readonly meanPerGoldRecall: number | null;
  readonly meanReciprocalRank: number | null;
  readonly noSkillCaseCount: number;
  readonly noSkillFalsePositiveCases: number;
  readonly noSkillFalsePositiveRate: number | null;
  readonly hardConfuserCaseCount: number;
  readonly hardConfuserGoldAvailableCases: number;
  readonly hardConfuserGoldAvailabilityRecallAtK: number | null;
  readonly hardConfuserFalsePositiveCases: number;
  readonly hardConfuserFalsePositiveRate: number | null;
  readonly learnedCandidateCaseCount: number;
  readonly staticAvailableGoldCount: number;
  readonly staticPreservedGoldCount: number;
  readonly staticGoldPreservationRate: number | null;
}

export interface ActivationMemoryMetricSlices {
  readonly overall: ActivationMemoryDiscoveryMetrics;
  readonly zh: ActivationMemoryDiscoveryMetrics;
  readonly en: ActivationMemoryDiscoveryMetrics;
  readonly single: ActivationMemoryDiscoveryMetrics;
  readonly multi: ActivationMemoryDiscoveryMetrics;
  readonly noSkill: ActivationMemoryDiscoveryMetrics;
  readonly hardConfuser: ActivationMemoryDiscoveryMetrics;
}

export interface ActivationMemoryOfflineConditionResult {
  readonly condition: ActivationMemoryExperimentCondition;
  readonly formation: {
    readonly sourceMode: "evaluation_fixture";
    readonly exposure: number;
    readonly inputExperienceCount: number;
    readonly profileCount: number;
    readonly learnedAliasCount: number;
    readonly positiveExampleCount: number;
    readonly nearMissExampleCount: number;
    readonly cueCount: number;
    readonly evidenceReferenceCount: number;
    readonly evidenceComplete: boolean;
    readonly parentRevisionBound: boolean;
    readonly persistenceEligibility: "none" | "never";
    readonly artifactHash: string;
    readonly cueLeakage: {
      readonly passed: true;
      readonly comparedPairCount: number;
      readonly maxObservedJaccard: number;
      readonly maxObservedEvaluationContainment: number;
    };
  };
  readonly metrics: ActivationMemoryMetricSlices;
  readonly cases: readonly ActivationMemoryOfflineCaseResult[];
}

export interface ActivationMemoryOfflineReport {
  readonly schemaVersion: 1;
  readonly sourceMode: "evaluation_fixture";
  readonly partition: "calibration";
  readonly topK: number;
  readonly memoryBoost: number;
  readonly nearMissPenalty: number;
  readonly exposure: number;
  readonly tenantScopeHash: string;
  readonly conditions: readonly ActivationMemoryOfflineConditionResult[];
}

/** Calibration-only runner. Held-out requires a separate post-freeze entry point. */
export function runActivationMemoryOfflineCalibration(options: {
  readonly catalog: readonly SkillRecord[];
  readonly targets: readonly ActivationMemoryTargetSkill[];
  readonly experiences: readonly ActivationMemoryExperienceCase[];
  readonly cases: readonly ActivationMemoryEvalCase[];
  readonly exposure: number;
  readonly topK: number;
  readonly memoryBoost: number;
  readonly nearMissPenalty: number;
  readonly tenantScopeHash?: string;
}): ActivationMemoryOfflineReport {
  validateRunnerInput(options);
  const tenantScopeHash = options.tenantScopeHash ?? DEFAULT_EVALUATION_TENANT_SCOPE_HASH;
  const artifacts = new Map<"none" | "naive" | "verified", EvaluationFormationArtifact>();
  const leakageByProducer = new Map<"none" | "naive" | "verified", ReturnType<typeof measureEvaluationFormationCueLeakage>>();
  for (const producer of ["none", "naive", "verified"] as const) {
    const formation = formEvaluationActivationMemory({
      producer,
      exposure: producer === "none" ? 0 : options.exposure,
      targets: options.targets,
      experiences: options.experiences,
      tenantScopeHash,
    });
    const leakage = measureEvaluationFormationCueLeakage(formation, options.cases);
    if (!leakage.passed) throw new Error(`activation_memory_cue_leakage_detected:${producer}:${leakage.violations.length}`);
    artifacts.set(producer, formation);
    leakageByProducer.set(producer, leakage);
  }

  const baseline = buildIndex(options.catalog);
  const expanded = buildQueryExpansionIndex(options.catalog);
  const catalogById = new Map(options.catalog.map((item) => [item.skillId, item]));
  const baselineCases = new Map<"bm25" | "bm25_qe", readonly ActivationMemoryOfflineCaseResult[]>();

  const conditions = ACTIVATION_MEMORY_EXPERIMENT_CONDITIONS.map((condition): ActivationMemoryOfflineConditionResult => {
    const formation = artifacts.get(condition.producer)!;
    const leakage = leakageByProducer.get(condition.producer)!;
    const profiles = evaluationProfilesForScope(formation, tenantScopeHash);
    const cases = options.cases.map((item): ActivationMemoryOfflineCaseResult => {
      const staticResult = condition.retriever === "bm25_qe"
        ? expanded.searchWithTrace(item.query, { limit: options.topK })
        : { candidates: baseline.search(item.query, { limit: options.topK }), expansion: undefined };
      const candidates = condition.producer === "none"
        ? staticResult.candidates
        : retrieveWithEvaluationMemory(
          staticResult.candidates,
          profiles,
          catalogById,
          item.query,
          options.topK,
          options.memoryBoost,
          options.nearMissPenalty,
        );
      return caseResult(item, candidates, staticResult.expansion?.matchedRuleIds ?? []);
    });
    if (condition.producer === "none") baselineCases.set(condition.retriever, cases);
    const staticCases = baselineCases.get(condition.retriever);
    if (staticCases === undefined) throw new Error("activation_memory_static_baseline_missing");
    return Object.freeze({
      condition,
      formation: formationSummary(formation, leakage, catalogById),
      metrics: metricSlices(cases, staticCases),
      cases: Object.freeze(cases),
    });
  });

  return Object.freeze({
    schemaVersion: 1,
    sourceMode: "evaluation_fixture",
    partition: "calibration",
    topK: options.topK,
    memoryBoost: options.memoryBoost,
    nearMissPenalty: options.nearMissPenalty,
    exposure: options.exposure,
    tenantScopeHash,
    conditions: Object.freeze(conditions),
  });
}

/** Evaluation-only recall-expansion seam; production overlay remains bounded to static Top-K. */
export function retrieveWithEvaluationMemory(
  staticCandidates: readonly SkillCandidate[],
  profiles: readonly ActivationProfile[],
  catalogById: ReadonlyMap<string, SkillRecord>,
  query: string,
  topK: number,
  memoryBoost: number,
  nearMissPenalty: number,
): SkillCandidate[] {
  const combined = new Map<string, SkillCandidate>(staticCandidates.map((item) => [item.skillId, item]));
  for (const profile of profiles) {
    if (profile.status === "suspended" || profile.status === "retired") continue;
    const record = catalogById.get(profile.parentSkillId);
    if (record === undefined || record.skillRevision !== profile.parentSkillRevision) continue;
    const match = matchLearnedOverlay(query, profile);
    const cueIds = [...match.aliasCueIds, ...match.positiveCueIds];
    if (cueIds.length === 0) continue;
    const current = combined.get(record.skillId);
    const existingCueIds = new Set(current?.evidence
      .filter((entry) => entry.kind === "learned_cue")
      .map((entry) => entry.cueId) ?? []);
    const evidence = [
      ...(current?.evidence ?? []),
      ...cueIds.filter((cueId) => !existingCueIds.has(cueId)).map((cueId) => ({ kind: "learned_cue" as const, cueId })),
    ];
    combined.set(record.skillId, {
      skillId: record.skillId,
      skillRevision: record.skillRevision,
      name: record.name,
      description: record.description,
      scope: record.scope,
      retrievalScore: (current?.retrievalScore ?? 0) + memoryBoost - nearMissPenalty * match.nearMissCueIds.length,
      evidence,
    });
  }
  return [...combined.values()]
    .sort((left, right) => right.retrievalScore - left.retrievalScore || left.skillId.localeCompare(right.skillId))
    .slice(0, topK);
}

function caseResult(
  item: ActivationMemoryEvalCase,
  candidates: readonly SkillCandidate[],
  matchedExpansionRuleIds: readonly string[],
): ActivationMemoryOfflineCaseResult {
  const candidateSkillIds = candidates.map((candidate) => candidate.skillId);
  const candidateSet = new Set(candidateSkillIds);
  const learnedCandidateSkillIds = candidates
    .filter((candidate) => candidate.evidence.some((entry) => entry.kind === "learned_cue"))
    .map((candidate) => candidate.skillId);
  const goldHits = item.goldSkillIds.filter((skillId) => candidateSet.has(skillId));
  const goldRanks = item.goldSkillIds
    .map((skillId) => candidateSkillIds.indexOf(skillId))
    .filter((rank) => rank >= 0);
  return Object.freeze({
    caseId: item.id,
    language: item.language,
    labelType: item.labelType,
    hardConfuser: item.hardConfuser,
    goldSkillIds: Object.freeze([...item.goldSkillIds]),
    candidateSkillIds: Object.freeze(candidateSkillIds),
    learnedCandidateSkillIds: Object.freeze(learnedCandidateSkillIds),
    matchedExpansionRuleIds: Object.freeze([...matchedExpansionRuleIds]),
    goldAvailable: item.goldSkillIds.length === 0 ? null : goldHits.length === item.goldSkillIds.length,
    perGoldRecall: item.goldSkillIds.length === 0 ? null : goldHits.length / item.goldSkillIds.length,
    reciprocalRank: item.goldSkillIds.length === 0 || goldRanks.length === 0 ? (item.goldSkillIds.length === 0 ? null : 0) : 1 / (Math.min(...goldRanks) + 1),
    noSkillFalsePositive: item.goldSkillIds.length === 0 && learnedCandidateSkillIds.length > 0,
    hardConfuserFalsePositive: item.hardConfuser && learnedCandidateSkillIds.some((skillId) => !item.goldSkillIds.includes(skillId)),
  });
}

function formationSummary(
  formation: EvaluationFormationArtifact,
  leakage: ReturnType<typeof measureEvaluationFormationCueLeakage>,
  catalogById: ReadonlyMap<string, SkillRecord>,
): ActivationMemoryOfflineConditionResult["formation"] {
  const aliases = formation.profiles.flatMap((profile) => profile.learnedAliases);
  const positive = formation.profiles.flatMap((profile) => profile.positiveExamples);
  const nearMiss = formation.profiles.flatMap((profile) => profile.nearMissExamples);
  const environment = formation.profiles.flatMap((profile) => profile.environmentCues);
  const cues = [...aliases, ...positive, ...nearMiss, ...environment];
  return Object.freeze({
    sourceMode: formation.sourceMode,
    exposure: formation.exposure,
    inputExperienceCount: formation.inputExperienceIds.length,
    profileCount: formation.profiles.length,
    learnedAliasCount: aliases.length,
    positiveExampleCount: positive.length,
    nearMissExampleCount: nearMiss.length,
    cueCount: cues.length,
    evidenceReferenceCount: cues.reduce((sum, cue) => sum + cue.evidenceIds.length, 0),
    evidenceComplete: cues.every((cue) => cue.evidenceIds.length > 0),
    parentRevisionBound: formation.profiles.every((profile) => catalogById.get(profile.parentSkillId)?.skillRevision === profile.parentSkillRevision),
    persistenceEligibility: formation.persistenceEligibility,
    artifactHash: formation.artifactHash,
    cueLeakage: Object.freeze({
      passed: true,
      comparedPairCount: leakage.comparedPairCount,
      maxObservedJaccard: leakage.maxObservedJaccard,
      maxObservedEvaluationContainment: leakage.maxObservedEvaluationContainment,
    }),
  });
}

function metricSlices(
  cases: readonly ActivationMemoryOfflineCaseResult[],
  staticCases: readonly ActivationMemoryOfflineCaseResult[],
): ActivationMemoryMetricSlices {
  const baselineById = new Map(staticCases.map((item) => [item.caseId, item]));
  const select = (predicate: (item: ActivationMemoryOfflineCaseResult) => boolean) => {
    const selected = cases.filter(predicate);
    return summarizeMetrics(selected, selected.map((item) => baselineById.get(item.caseId)!));
  };
  return Object.freeze({
    overall: select(() => true),
    zh: select((item) => item.language === "zh"),
    en: select((item) => item.language === "en"),
    single: select((item) => item.labelType === "single"),
    multi: select((item) => item.labelType === "multi"),
    noSkill: select((item) => item.labelType === "no_skill"),
    hardConfuser: select((item) => item.hardConfuser),
  });
}

function summarizeMetrics(
  cases: readonly ActivationMemoryOfflineCaseResult[],
  staticCases: readonly ActivationMemoryOfflineCaseResult[],
): ActivationMemoryDiscoveryMetrics {
  const goldCases = cases.filter((item) => item.goldSkillIds.length > 0);
  const multiCases = cases.filter((item) => item.labelType === "multi");
  const noSkillCases = cases.filter((item) => item.labelType === "no_skill");
  const hardCases = cases.filter((item) => item.hardConfuser);
  const hardGoldCases = hardCases.filter((item) => item.goldSkillIds.length > 0);
  let staticAvailableGoldCount = 0;
  let staticPreservedGoldCount = 0;
  for (let index = 0; index < cases.length; index += 1) {
    const currentSet = new Set(cases[index]!.candidateSkillIds);
    for (const skillId of staticCases[index]!.goldSkillIds) {
      if (!staticCases[index]!.candidateSkillIds.includes(skillId)) continue;
      staticAvailableGoldCount += 1;
      if (currentSet.has(skillId)) staticPreservedGoldCount += 1;
    }
  }
  return Object.freeze({
    caseCount: cases.length,
    goldCaseCount: goldCases.length,
    goldAvailableCases: goldCases.filter((item) => item.goldAvailable).length,
    goldAvailabilityRecallAtK: ratio(goldCases.filter((item) => item.goldAvailable).length, goldCases.length),
    multiSkillCaseCount: multiCases.length,
    multiSkillFullSetAvailableCases: multiCases.filter((item) => item.goldAvailable).length,
    multiSkillFullSetAvailability: ratio(multiCases.filter((item) => item.goldAvailable).length, multiCases.length),
    meanPerGoldRecall: mean(goldCases.map((item) => item.perGoldRecall!)),
    meanReciprocalRank: mean(goldCases.map((item) => item.reciprocalRank!)),
    noSkillCaseCount: noSkillCases.length,
    noSkillFalsePositiveCases: noSkillCases.filter((item) => item.noSkillFalsePositive).length,
    noSkillFalsePositiveRate: ratio(noSkillCases.filter((item) => item.noSkillFalsePositive).length, noSkillCases.length),
    hardConfuserCaseCount: hardCases.length,
    hardConfuserGoldAvailableCases: hardGoldCases.filter((item) => item.goldAvailable).length,
    hardConfuserGoldAvailabilityRecallAtK: ratio(hardGoldCases.filter((item) => item.goldAvailable).length, hardGoldCases.length),
    hardConfuserFalsePositiveCases: hardCases.filter((item) => item.hardConfuserFalsePositive).length,
    hardConfuserFalsePositiveRate: ratio(hardCases.filter((item) => item.hardConfuserFalsePositive).length, hardCases.length),
    learnedCandidateCaseCount: cases.filter((item) => item.learnedCandidateSkillIds.length > 0).length,
    staticAvailableGoldCount,
    staticPreservedGoldCount,
    staticGoldPreservationRate: ratio(staticPreservedGoldCount, staticAvailableGoldCount),
  });
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function validateRunnerInput(options: {
  readonly catalog: readonly SkillRecord[];
  readonly targets: readonly ActivationMemoryTargetSkill[];
  readonly cases: readonly ActivationMemoryEvalCase[];
  readonly topK: number;
  readonly memoryBoost: number;
  readonly nearMissPenalty: number;
}): void {
  if (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > 10) throw new Error("activation_memory_top_k_invalid");
  if (!Number.isFinite(options.memoryBoost) || options.memoryBoost <= 0) throw new Error("activation_memory_boost_invalid");
  if (!Number.isFinite(options.nearMissPenalty) || options.nearMissPenalty < 0) throw new Error("activation_memory_near_miss_penalty_invalid");
  if (options.cases.some((item) => item.partition !== "calibration")) throw new Error("activation_memory_heldout_not_allowed_before_freeze");
  const catalogById = new Map(options.catalog.map((item) => [item.skillId, item]));
  if (catalogById.size !== options.catalog.length) throw new Error("activation_memory_catalog_duplicate_skill_id");
  for (const target of options.targets) {
    const record = catalogById.get(target.skillId);
    if (record === undefined) throw new Error("activation_memory_target_not_in_catalog");
    if (record.skillRevision !== target.skillRevision) throw new Error("activation_memory_target_revision_mismatch");
  }
  const caseIds = new Set<string>();
  for (const item of options.cases) {
    if (caseIds.has(item.id)) throw new Error("activation_memory_duplicate_eval_case_id");
    caseIds.add(item.id);
    if (item.labelType === "no_skill" && item.goldSkillIds.length !== 0) throw new Error("activation_memory_no_skill_gold_invalid");
    if (item.labelType !== "no_skill" && item.goldSkillIds.length === 0) throw new Error("activation_memory_gold_missing");
    if (item.goldSkillIds.some((skillId) => !catalogById.has(skillId))) throw new Error("activation_memory_gold_not_in_catalog");
  }
}
