import { createHash } from "node:crypto";

import type { ActivationProfile } from "../../core/contracts/index.ts";
import { tokenize } from "../../discovery/tokenize.ts";
import type {
  ActivationMemoryEvalCase,
  ActivationMemoryExperienceCase,
  ActivationMemoryTargetSkill,
} from "./cases.ts";
import {
  measureQueryLeakage,
  type ActivationMemoryProducerKind,
  type QueryLeakageReport,
} from "./formation-contract.ts";

const FIXED_EVALUATION_TIME = "2000-01-01T00:00:00.000Z";
const MAX_EVALUATION_FEATURES = 24;
export const DEFAULT_EVALUATION_TENANT_SCOPE_HASH =
  `sha256:${sha256("activation-memory-evaluation-scope")}`;

export interface EvaluationFormationArtifact {
  readonly schemaVersion: 1;
  readonly sourceMode: "evaluation_fixture";
  readonly producer: ActivationMemoryProducerKind;
  readonly exposure: number;
  readonly tenantScopeHash: string;
  readonly persistenceEligibility: "none" | "never";
  readonly inputExperienceIds: readonly string[];
  readonly profiles: readonly ActivationProfile[];
  readonly artifactHash: string;
}

/**
 * Evaluation-only formation seam.
 *
 * It never constructs or relabels PracticeEvent, never writes a Store, and
 * always returns draft profiles with persistenceEligibility=never. M2 is an
 * evaluation analogue of verified induction, not proof of real provenance.
 */
export function formEvaluationActivationMemory(options: {
  readonly producer: ActivationMemoryProducerKind;
  readonly exposure: number;
  readonly targets: readonly ActivationMemoryTargetSkill[];
  readonly experiences: readonly ActivationMemoryExperienceCase[];
  readonly tenantScopeHash?: string;
}): EvaluationFormationArtifact {
  validateExposure(options.exposure);
  validateFormationInputs(options.targets, options.experiences);

  if (options.producer === "none" || options.exposure === 0) {
    return artifact(options.producer, options.exposure, options.tenantScopeHash ?? DEFAULT_EVALUATION_TENANT_SCOPE_HASH, [], []);
  }

  const selected = options.experiences
    .filter((item) => item.ordinal <= options.exposure)
    .sort((left, right) => left.id.localeCompare(right.id));
  const profiles = options.targets.map((target) => {
    const targetExperiences = selected.filter((item) => item.targetSkillId === target.skillId);
    return options.producer === "naive"
      ? naiveProfile(target, targetExperiences)
      : verifiedEvaluationProfile(target, targetExperiences);
  });
  return artifact(
    options.producer,
    options.exposure,
    options.tenantScopeHash ?? DEFAULT_EVALUATION_TENANT_SCOPE_HASH,
    selected.map((item) => item.id),
    profiles,
  );
}

/** Rejects tampered formation artifacts before they can affect evaluation retrieval. */
export function verifyEvaluationFormationArtifact(artifactValue: EvaluationFormationArtifact): boolean {
  return artifactValue.artifactHash === artifactHash(canonicalArtifact(artifactValue));
}

/** Scope mismatch is a memory miss, never a cross-scope overlay. */
export function evaluationProfilesForScope(
  artifactValue: EvaluationFormationArtifact,
  tenantScopeHash: string,
): readonly ActivationProfile[] {
  return artifactValue.tenantScopeHash === tenantScopeHash ? artifactValue.profiles : [];
}

/** Structural cue audit only; it does not invoke retrieval or expose cue/query text. */
export function measureEvaluationFormationCueLeakage(
  artifact: EvaluationFormationArtifact,
  cases: readonly ActivationMemoryEvalCase[],
): QueryLeakageReport {
  const references = artifact.profiles.flatMap((profile) => [
    ...profile.learnedAliases.map((cue) => ({ id: cue.cueId, text: cue.text })),
    ...profile.positiveExamples.map((cue) => ({ id: cue.cueId, text: cue.features.join(" ") })),
  ]);
  return measureQueryLeakage(
    references,
    cases.map((item) => ({ id: item.id, text: item.query })),
  );
}

function naiveProfile(
  target: ActivationMemoryTargetSkill,
  experiences: readonly ActivationMemoryExperienceCase[],
): ActivationProfile {
  return baseProfile(target, "naive", {
    learnedAliases: experiences.map((item) => ({
      cueId: cueId(target.skillId, "naive", item.id),
      text: semanticFeatures(item.query).join(" ").slice(0, 120),
      evidenceIds: [item.id],
    })).filter((item) => item.text !== ""),
    positiveExamples: [],
  });
}

function verifiedEvaluationProfile(
  target: ActivationMemoryTargetSkill,
  experiences: readonly ActivationMemoryExperienceCase[],
): ActivationProfile {
  return baseProfile(target, "verified", {
    learnedAliases: [],
    positiveExamples: experiences.map((item) => ({
      cueId: cueId(target.skillId, "verified_positive", item.id),
      features: semanticFeatures(item.query),
      evidenceIds: [item.id],
    })).filter((item) => item.features.length > 0),
  });
}

function baseProfile(
  target: ActivationMemoryTargetSkill,
  producer: "naive" | "verified",
  cues: Pick<ActivationProfile, "learnedAliases" | "positiveExamples">,
): ActivationProfile {
  return {
    schemaVersion: 1,
    profileId: `profile:${sha256(`${producer}\u0000${target.skillId}\u0000${target.skillRevision}`).slice(0, 24)}`,
    parentSkillId: target.skillId,
    parentSkillRevision: target.skillRevision,
    status: "draft",
    learnedAliases: cues.learnedAliases,
    positiveExamples: cues.positiveExamples,
    nearMissExamples: [],
    environmentCues: [],
    createdAt: FIXED_EVALUATION_TIME,
    updatedAt: FIXED_EVALUATION_TIME,
  };
}

function artifact(
  producer: ActivationMemoryProducerKind,
  exposure: number,
  tenantScopeHash: string,
  inputExperienceIds: readonly string[],
  profiles: readonly ActivationProfile[],
): EvaluationFormationArtifact {
  const canonical = canonicalArtifact({
    schemaVersion: 1,
    sourceMode: "evaluation_fixture",
    producer,
    exposure,
    tenantScopeHash,
    persistenceEligibility: producer === "none" || exposure === 0 ? "none" : "never",
    inputExperienceIds: [...inputExperienceIds].sort(),
    profiles: [...profiles].sort((left, right) => left.parentSkillId.localeCompare(right.parentSkillId)),
  });
  return Object.freeze({
    ...canonical,
    inputExperienceIds: Object.freeze(canonical.inputExperienceIds),
    profiles: Object.freeze(canonical.profiles),
    artifactHash: artifactHash(canonical),
  });
}

function canonicalArtifact(value: Omit<EvaluationFormationArtifact, "artifactHash">): Omit<EvaluationFormationArtifact, "artifactHash"> {
  return {
    schemaVersion: 1,
    sourceMode: "evaluation_fixture",
    producer: value.producer,
    exposure: value.exposure,
    tenantScopeHash: value.tenantScopeHash,
    persistenceEligibility: value.persistenceEligibility,
    inputExperienceIds: [...value.inputExperienceIds].sort(),
    profiles: [...value.profiles].sort((left, right) => left.parentSkillId.localeCompare(right.parentSkillId)),
  };
}

function artifactHash(value: Omit<EvaluationFormationArtifact, "artifactHash">): string {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

function semanticFeatures(query: string): string[] {
  return [...new Set(tokenize(query))].slice(0, MAX_EVALUATION_FEATURES);
}

function cueId(skillId: string, kind: string, evidenceId: string): string {
  return `cue:${sha256(`${skillId}\u0000${kind}\u0000${evidenceId}`).slice(0, 24)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateExposure(exposure: number): void {
  if (![0, 1, 2, 4, 8].includes(exposure)) throw new Error("activation_memory_exposure_not_frozen");
}

function validateFormationInputs(
  targets: readonly ActivationMemoryTargetSkill[],
  experiences: readonly ActivationMemoryExperienceCase[],
): void {
  const targetById = new Map(targets.map((item) => [item.skillId, item]));
  if (targetById.size !== targets.length) throw new Error("activation_memory_duplicate_target_skill_id");
  const experienceIds = new Set<string>();
  const ordinalsByTarget = new Map<string, Set<number>>();
  for (const item of experiences) {
    if (experienceIds.has(item.id)) throw new Error("activation_memory_duplicate_experience_id");
    experienceIds.add(item.id);
    const target = targetById.get(item.targetSkillId);
    if (target === undefined) throw new Error("activation_memory_experience_target_missing");
    if (target.skillRevision !== item.targetSkillRevision) throw new Error("activation_memory_experience_revision_mismatch");
    const ordinals = ordinalsByTarget.get(item.targetSkillId) ?? new Set<number>();
    if (ordinals.has(item.ordinal)) throw new Error("activation_memory_duplicate_experience_ordinal");
    ordinals.add(item.ordinal);
    ordinalsByTarget.set(item.targetSkillId, ordinals);
  }
}
