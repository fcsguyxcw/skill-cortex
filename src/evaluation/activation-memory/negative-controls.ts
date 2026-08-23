import type { ActivationProfile, SkillCandidate, SkillRecord } from "../../core/contracts/index.ts";
import { removeCuesReferencingEvidence } from "../../activation/cascade.ts";
import { buildIndex } from "../../discovery/bm25.ts";
import { tokenize } from "../../discovery/tokenize.ts";
import type {
  ActivationMemoryExperienceCase,
  ActivationMemoryNegativeControlCase,
  ActivationMemoryTargetSkill,
} from "./cases.ts";
import {
  DEFAULT_EVALUATION_TENANT_SCOPE_HASH,
  evaluationProfilesForScope,
  formEvaluationActivationMemory,
  verifyEvaluationFormationArtifact,
  type EvaluationFormationArtifact,
} from "./formation.ts";
import { retrieveWithEvaluationMemory } from "./offline-runner.ts";

export interface ActivationMemoryNegativeControlResult {
  readonly id: string;
  readonly kind: ActivationMemoryNegativeControlCase["kind"];
  readonly targetSkillId: string;
  readonly expectedOutcome: ActivationMemoryNegativeControlCase["expectedOutcome"];
  readonly observedOutcome: ActivationMemoryNegativeControlCase["expectedOutcome"] | "control_failed";
  readonly passed: boolean;
}

export interface ActivationMemoryNegativeControlReport {
  readonly schemaVersion: 1;
  readonly sourceMode: "evaluation_fixture";
  readonly formationArtifactHash: string;
  readonly controlCount: number;
  readonly allPassed: boolean;
  readonly results: readonly ActivationMemoryNegativeControlResult[];
}

/**
 * Executes the six frozen safety controls against evaluation-only profiles.
 * It stores IDs/outcomes only and never promotes or persists the profiles.
 */
export function runActivationMemoryNegativeControls(options: {
  readonly catalog: readonly SkillRecord[];
  readonly targets: readonly ActivationMemoryTargetSkill[];
  readonly experiences: readonly ActivationMemoryExperienceCase[];
  readonly controls: readonly ActivationMemoryNegativeControlCase[];
  readonly topK: number;
  readonly memoryBoost: number;
  readonly nearMissPenalty: number;
  readonly tenantScopeHash?: string;
}): ActivationMemoryNegativeControlReport {
  validateControls(options);
  const tenantScopeHash = options.tenantScopeHash ?? DEFAULT_EVALUATION_TENANT_SCOPE_HASH;
  const formation = formEvaluationActivationMemory({
    producer: "verified",
    exposure: 1,
    targets: options.targets,
    experiences: options.experiences,
    tenantScopeHash,
  });
  const catalogById = new Map(options.catalog.map((item) => [item.skillId, item]));
  const index = buildIndex(options.catalog);
  const firstExperienceByTarget = new Map<string, ActivationMemoryExperienceCase>();
  for (const item of [...options.experiences].sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))) {
    if (!firstExperienceByTarget.has(item.targetSkillId)) firstExperienceByTarget.set(item.targetSkillId, item);
  }

  const results = options.controls.map((control): ActivationMemoryNegativeControlResult => {
    const profile = formation.profiles.find((item) => item.parentSkillId === control.targetSkillId)!;
    const probe = firstExperienceByTarget.get(control.targetSkillId)!;
    const staticCandidates = index.search(probe.query, { limit: options.topK });
    const passed = executeControl({
      control,
      formation,
      profile,
      probeQuery: probe.query,
      staticCandidates,
      catalogById,
      topK: options.topK,
      memoryBoost: options.memoryBoost,
      nearMissPenalty: options.nearMissPenalty,
      tenantScopeHash,
    });
    return Object.freeze({
      id: control.id,
      kind: control.kind,
      targetSkillId: control.targetSkillId,
      expectedOutcome: control.expectedOutcome,
      observedOutcome: passed ? control.expectedOutcome : "control_failed",
      passed,
    });
  });

  return Object.freeze({
    schemaVersion: 1,
    sourceMode: "evaluation_fixture",
    formationArtifactHash: formation.artifactHash,
    controlCount: results.length,
    allPassed: results.every((item) => item.passed),
    results: Object.freeze(results),
  });
}

function executeControl(options: {
  readonly control: ActivationMemoryNegativeControlCase;
  readonly formation: EvaluationFormationArtifact;
  readonly profile: ActivationProfile;
  readonly probeQuery: string;
  readonly staticCandidates: readonly SkillCandidate[];
  readonly catalogById: ReadonlyMap<string, SkillRecord>;
  readonly topK: number;
  readonly memoryBoost: number;
  readonly nearMissPenalty: number;
  readonly tenantScopeHash: string;
}): boolean {
  switch (options.control.kind) {
    case "shuffled_profile": {
      const alternate = options.formation.profiles.find((item) => item.parentSkillId !== options.profile.parentSkillId)!;
      const shuffled: EvaluationFormationArtifact = {
        ...options.formation,
        profiles: options.formation.profiles.map((item) => item.profileId === options.profile.profileId
          ? { ...item, parentSkillId: alternate.parentSkillId, parentSkillRevision: alternate.parentSkillRevision }
          : item),
      };
      return !verifyEvaluationFormationArtifact(shuffled);
    }
    case "unverified_success":
      return options.formation.persistenceEligibility === "never" && options.formation.profiles.every((item) => item.status === "draft");
    case "stale_revision": {
      const stale = { ...options.profile, parentSkillRevision: `rev:${"f".repeat(64)}` } as ActivationProfile;
      return sameCandidates(
        retrieveWithEvaluationMemory(options.staticCandidates, [stale], options.catalogById, options.probeQuery, options.topK, options.memoryBoost, options.nearMissPenalty),
        options.staticCandidates,
      );
    }
    case "deleted_evidence": {
      const deletedEvidenceIds = profileEvidenceIds(options.profile);
      const deletion = removeCuesReferencingEvidence(options.profile, deletedEvidenceIds);
      return deletion.removedCues.length > 0 && sameCandidates(
        retrieveWithEvaluationMemory(options.staticCandidates, [deletion.profile], options.catalogById, options.probeQuery, options.topK, options.memoryBoost, options.nearMissPenalty),
        options.staticCandidates,
      );
    }
    case "cross_scope": {
      const profiles = evaluationProfilesForScope(options.formation, `sha256:${"0".repeat(64)}`);
      return profiles.length === 0 && sameCandidates(
        retrieveWithEvaluationMemory(options.staticCandidates, profiles, options.catalogById, options.probeQuery, options.topK, options.memoryBoost, options.nearMissPenalty),
        options.staticCandidates,
      );
    }
    case "near_miss_contamination": {
      const nearMissProfile: ActivationProfile = {
        ...options.profile,
        nearMissExamples: [{
          cueId: `near-miss:${options.control.id}`,
          features: [...new Set(tokenize(options.probeQuery))],
          evidenceIds: [`negative-control:${options.control.id}`],
        }],
      };
      const withoutPenalty = retrieveWithEvaluationMemory(
        options.staticCandidates, [options.profile], options.catalogById, options.probeQuery,
        options.topK, options.memoryBoost, 0,
      );
      const withPenalty = retrieveWithEvaluationMemory(
        options.staticCandidates, [nearMissProfile], options.catalogById, options.probeQuery,
        options.topK, options.memoryBoost, options.nearMissPenalty,
      );
      const before = withoutPenalty.find((item) => item.skillId === options.profile.parentSkillId);
      const after = withPenalty.find((item) => item.skillId === options.profile.parentSkillId);
      return before !== undefined && after !== undefined && after.retrievalScore < before.retrievalScore;
    }
  }
}

function profileEvidenceIds(profile: ActivationProfile): string[] {
  return [...new Set([
    ...profile.learnedAliases.flatMap((item) => item.evidenceIds),
    ...profile.positiveExamples.flatMap((item) => item.evidenceIds),
    ...profile.nearMissExamples.flatMap((item) => item.evidenceIds),
    ...profile.environmentCues.flatMap((item) => item.evidenceIds),
  ])];
}

function sameCandidates(left: readonly SkillCandidate[], right: readonly SkillCandidate[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateControls(options: {
  readonly catalog: readonly SkillRecord[];
  readonly targets: readonly ActivationMemoryTargetSkill[];
  readonly experiences: readonly ActivationMemoryExperienceCase[];
  readonly controls: readonly ActivationMemoryNegativeControlCase[];
  readonly topK: number;
  readonly memoryBoost: number;
  readonly nearMissPenalty: number;
}): void {
  if (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > 10) throw new Error("activation_memory_top_k_invalid");
  if (!Number.isFinite(options.memoryBoost) || options.memoryBoost <= 0) throw new Error("activation_memory_boost_invalid");
  if (!Number.isFinite(options.nearMissPenalty) || options.nearMissPenalty <= 0) throw new Error("activation_memory_near_miss_penalty_invalid");
  const expectedKinds = new Set([
    "shuffled_profile", "unverified_success", "stale_revision", "deleted_evidence", "cross_scope", "near_miss_contamination",
  ]);
  const expectedOutcomeByKind: Readonly<Record<ActivationMemoryNegativeControlCase["kind"], ActivationMemoryNegativeControlCase["expectedOutcome"]>> = {
    shuffled_profile: "no_cross_task_transfer",
    unverified_success: "no_active_overlay",
    stale_revision: "fallback_baseline",
    deleted_evidence: "fallback_baseline",
    cross_scope: "fallback_baseline",
    near_miss_contamination: "no_cross_task_transfer",
  };
  if (options.controls.length !== expectedKinds.size || new Set(options.controls.map((item) => item.kind)).size !== expectedKinds.size) {
    throw new Error("activation_memory_negative_controls_incomplete");
  }
  const targetIds = new Set(options.targets.map((item) => item.skillId));
  const experienceTargets = new Set(options.experiences.filter((item) => item.ordinal === 1).map((item) => item.targetSkillId));
  for (const control of options.controls) {
    if (!expectedKinds.has(control.kind)) throw new Error("activation_memory_negative_control_kind_invalid");
    if (control.expectedOutcome !== expectedOutcomeByKind[control.kind]) throw new Error("activation_memory_negative_control_outcome_invalid");
    if (!targetIds.has(control.targetSkillId) || !experienceTargets.has(control.targetSkillId)) throw new Error("activation_memory_negative_control_target_missing");
  }
  if (options.targets.length < 2) throw new Error("activation_memory_shuffled_control_needs_alternate_target");
  const catalogIds = new Set(options.catalog.map((item) => item.skillId));
  if (options.targets.some((item) => !catalogIds.has(item.skillId))) throw new Error("activation_memory_target_not_in_catalog");
}
