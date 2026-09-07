import { createHash } from "node:crypto";

import type { ExposureObservation, SkillRecord } from "../../core/contracts/index.ts";
import { buildIndex } from "../../discovery/index.ts";
import { observeExposure } from "../../exposure/index.ts";
import {
  ACTIVATION_MEMORY_CATALOG_HASH,
  FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH,
  computeActivationMemoryFixtureHash,
  type ActivationMemoryEvalCase,
  type ActivationMemoryEvalPartition,
} from "../activation-memory/cases.ts";

export const FROZEN_EXPOSURE_POLICY_CONFIG = Object.freeze({
  schemaVersion: 1 as const,
  sourceMode: "evaluation_fixture" as const,
  catalogHash: ACTIVATION_MEMORY_CATALOG_HASH,
  fixtureHash: FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH,
  retriever: "bm25" as const,
  topK: 5,
  policy: Object.freeze({
    id: "exact-reference-or-full-budget-or-top-score-v1",
    preserveExactDeclaredReference: true,
    minimumCandidateCount: 5,
    minimumTopScore: 12,
  }),
});

export const FROZEN_EXPOSURE_POLICY_CONFIG_HASH =
  "sha256:ad9c31165dd8cbf76521c4d67d9d70b229d2e6f469a1a74c77c62af6fb4d6f96";

export interface FrozenExposureMetrics {
  readonly caseCount: number;
  readonly necessaryCandidateCaseCount: number;
  readonly baselineNecessaryExposureRecall: number | null;
  readonly policyNecessaryExposureRecall: number | null;
  readonly noSkillCaseCount: number;
  readonly baselineNoSkillExposureFalsePositiveCount: number;
  readonly policyNoSkillExposureFalsePositiveCount: number;
  readonly baselineNoSkillExposureFalsePositiveRate: number | null;
  readonly policyNoSkillExposureFalsePositiveRate: number | null;
  readonly exactReferenceCaseCount: number;
  readonly exactReferencePreservedCount: number;
}

export interface FrozenExposureEvaluationReport {
  readonly schemaVersion: 1;
  readonly evidenceLevel: "offline_component";
  readonly partition: ActivationMemoryEvalPartition;
  readonly catalogHash: string;
  readonly fixtureHash: string;
  readonly configHash: string;
  readonly metrics: FrozenExposureMetrics;
  readonly caseResults: ReadonlyArray<{
    readonly caseId: string;
    readonly labelType: ActivationMemoryEvalCase["labelType"];
    readonly baselineWouldInject: boolean;
    readonly policyWouldInject: boolean;
    readonly necessaryCandidateAvailable: boolean;
    readonly exactDeclaredReference: boolean;
  }>;
}

/** Evaluation-only comparator. Production Exposure remains observation-only. */
export function evaluationPolicyWouldInject(observation: ExposureObservation): boolean {
  return observation.baselineWouldInject && (
    observation.exactDeclaredReference
    || observation.candidateCount >= FROZEN_EXPOSURE_POLICY_CONFIG.policy.minimumCandidateCount
    || (observation.topScore ?? 0) >= FROZEN_EXPOSURE_POLICY_CONFIG.policy.minimumTopScore
  );
}

export function computeFrozenExposurePolicyConfigHash(): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(FROZEN_EXPOSURE_POLICY_CONFIG), "utf8")
    .digest("hex")}`;
}

export function runFrozenExposureEvaluation(options: {
  readonly catalog: readonly SkillRecord[];
  readonly catalogHash: string;
  readonly cases: readonly ActivationMemoryEvalCase[];
  readonly partition: ActivationMemoryEvalPartition;
}): FrozenExposureEvaluationReport {
  validateInput(options);
  const index = buildIndex(options.catalog);
  const caseResults = options.cases.map((item) => {
    const candidates = index.search(item.query, { limit: FROZEN_EXPOSURE_POLICY_CONFIG.topK });
    const observation = observeExposure(item.query, options.catalog, candidates);
    return Object.freeze({
      caseId: item.id,
      labelType: item.labelType,
      baselineWouldInject: observation.baselineWouldInject,
      policyWouldInject: evaluationPolicyWouldInject(observation),
      necessaryCandidateAvailable: item.goldSkillIds.some((skillId) =>
        candidates.some((candidate) => candidate.skillId === skillId),
      ),
      exactDeclaredReference: observation.exactDeclaredReference,
    });
  });

  const necessary = caseResults.filter((item) => item.necessaryCandidateAvailable);
  const noSkill = caseResults.filter((item) => item.labelType === "no_skill");
  const exactReference = caseResults.filter((item) =>
    item.baselineWouldInject && item.exactDeclaredReference,
  );
  const baselineNoSkillFp = noSkill.filter((item) => item.baselineWouldInject).length;
  const policyNoSkillFp = noSkill.filter((item) => item.policyWouldInject).length;

  return Object.freeze({
    schemaVersion: 1,
    evidenceLevel: "offline_component",
    partition: options.partition,
    catalogHash: options.catalogHash,
    fixtureHash: FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH,
    configHash: FROZEN_EXPOSURE_POLICY_CONFIG_HASH,
    metrics: Object.freeze({
      caseCount: caseResults.length,
      necessaryCandidateCaseCount: necessary.length,
      baselineNecessaryExposureRecall: rate(
        necessary.filter((item) => item.baselineWouldInject).length,
        necessary.length,
      ),
      policyNecessaryExposureRecall: rate(
        necessary.filter((item) => item.policyWouldInject).length,
        necessary.length,
      ),
      noSkillCaseCount: noSkill.length,
      baselineNoSkillExposureFalsePositiveCount: baselineNoSkillFp,
      policyNoSkillExposureFalsePositiveCount: policyNoSkillFp,
      baselineNoSkillExposureFalsePositiveRate: rate(baselineNoSkillFp, noSkill.length),
      policyNoSkillExposureFalsePositiveRate: rate(policyNoSkillFp, noSkill.length),
      exactReferenceCaseCount: exactReference.length,
      exactReferencePreservedCount: exactReference.filter((item) => item.policyWouldInject).length,
    }),
    caseResults: Object.freeze(caseResults),
  });
}

function validateInput(options: {
  readonly catalog: readonly SkillRecord[];
  readonly catalogHash: string;
  readonly cases: readonly ActivationMemoryEvalCase[];
  readonly partition: ActivationMemoryEvalPartition;
}): void {
  if (options.catalogHash !== ACTIVATION_MEMORY_CATALOG_HASH) {
    throw new Error("exposure_evaluation_catalog_hash_mismatch");
  }
  if (computeActivationMemoryFixtureHash() !== FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH) {
    throw new Error("exposure_evaluation_fixture_hash_mismatch");
  }
  if (computeFrozenExposurePolicyConfigHash() !== FROZEN_EXPOSURE_POLICY_CONFIG_HASH) {
    throw new Error("exposure_evaluation_config_hash_mismatch");
  }
  if (options.cases.some((item) => item.partition !== options.partition)) {
    throw new Error("exposure_evaluation_partition_mismatch");
  }
  const catalogIds = new Set(options.catalog.map((item) => item.skillId));
  if (catalogIds.size !== options.catalog.length) throw new Error("exposure_evaluation_catalog_duplicate");
  if (options.cases.some((item) => item.goldSkillIds.some((skillId) => !catalogIds.has(skillId)))) {
    throw new Error("exposure_evaluation_gold_not_in_catalog");
  }
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
