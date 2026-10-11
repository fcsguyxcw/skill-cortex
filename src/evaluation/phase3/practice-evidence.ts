import { validatePracticeEvent } from "../../practice/policy/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";

const ASSESSMENT_BRAND: unique symbol = Symbol("phase3-practice-evidence-assessment");
const EVENT_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const SKILL_ID_RE = /^skill:[0-9a-f]{64}$/;
const REVISION_RE = /^rev:[0-9a-f]{64}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

export interface PracticeEvidenceAssessment {
  readonly [ASSESSMENT_BRAND]: true;
  readonly ok: boolean;
  readonly distinctRealCount: number;
  readonly reason: string;
  readonly eventIds: readonly string[];
  readonly parentSkillId: string;
  readonly parentSkillRevision: string;
  readonly sourceHash: string;
  readonly requiredOperationClass: string;
  readonly requiredVerifierId: string;
}

export interface PracticeEvidenceBinding {
  parentSkillId: string;
  parentSkillRevision: string;
  sourceHash: string;
  requiredOperationClass: string;
  requiredVerifierId: string;
}

export interface ResolvePracticeEvidenceInput {
  store: PracticeStore;
  tenantScope: string;
  eventIds: readonly string[];
  expectedParentSkillId: string;
  expectedParentSkillRevision: string;
  expectedSourceHash: string;
  requiredOperationClass: string;
  requiredVerifierId: string;
}

function assessment(
  ok: boolean,
  distinctRealCount: number,
  reason: string,
  eventIds: readonly string[],
  binding: PracticeEvidenceBinding,
): PracticeEvidenceAssessment {
  return Object.freeze({
    [ASSESSMENT_BRAND]: true as const,
    ok,
    distinctRealCount,
    reason,
    eventIds: Object.freeze([...eventIds]),
    parentSkillId: binding.parentSkillId,
    parentSkillRevision: binding.parentSkillRevision,
    sourceHash: binding.sourceHash,
    requiredOperationClass: binding.requiredOperationClass,
    requiredVerifierId: binding.requiredVerifierId,
  });
}

/**
 * Resolve promotion evidence from the project-local PracticeStore. Callers
 * cannot promote by supplying provenance labels: every ID must round-trip
 * from the Store's real partition, pass policy, and match the parent binding.
 */
export async function resolvePracticeEvidence(
  input: ResolvePracticeEvidenceInput,
): Promise<PracticeEvidenceAssessment> {
  const binding = {
    parentSkillId: input.expectedParentSkillId,
    parentSkillRevision: input.expectedParentSkillRevision,
    sourceHash: input.expectedSourceHash,
    requiredOperationClass: input.requiredOperationClass,
    requiredVerifierId: input.requiredVerifierId,
  };
  if (!(input.store instanceof PracticeStore)) {
    return assessment(false, 0, "practice_store_required", [], binding);
  }
  if (
    !SKILL_ID_RE.test(input.expectedParentSkillId) ||
    !REVISION_RE.test(input.expectedParentSkillRevision) ||
    !HASH_RE.test(input.expectedSourceHash) ||
    input.requiredOperationClass.length === 0 ||
    input.requiredVerifierId.length === 0
  ) {
    return assessment(false, 0, "expected_parent_binding_invalid", [], binding);
  }

  const uniqueIds = [...new Set(input.eventIds)];
  if (uniqueIds.some((eventId) => !EVENT_ID_RE.test(eventId))) {
    return assessment(false, 0, "practice_event_id_invalid", [], binding);
  }

  const verifiedIds: string[] = [];
  for (const eventId of uniqueIds) {
    const event = await input.store.getEvent(input.tenantScope, eventId);
    if (event === undefined) {
      return assessment(false, verifiedIds.length, "practice_event_missing", verifiedIds, binding);
    }
    const policy = validatePracticeEvent(event);
    if (!policy.ok) {
      return assessment(false, verifiedIds.length, "practice_event_policy_invalid", verifiedIds, binding);
    }
    if (event.provenance !== "real") {
      return assessment(false, verifiedIds.length, "practice_event_not_real", verifiedIds, binding);
    }
    if (
      event.parentSkillId !== input.expectedParentSkillId ||
      event.parentSkillRevision !== input.expectedParentSkillRevision ||
      event.sourceHash !== input.expectedSourceHash
    ) {
      return assessment(false, verifiedIds.length, "practice_event_parent_mismatch", verifiedIds, binding);
    }
    const coveredStepPassed = event.stepSummaries.some(
      (step) =>
        step.operationClass === input.requiredOperationClass && step.outcome === "ok",
    );
    const verifierPassed = event.verifierResults.some(
      (result) =>
        result.verifierId === input.requiredVerifierId && result.result === "pass",
    );
    if (!coveredStepPassed || !verifierPassed || event.attribution !== "verified_skill_effect") {
      return assessment(
        false,
        verifiedIds.length,
        "practice_event_covered_step_unverified",
        verifiedIds,
        binding,
      );
    }
    verifiedIds.push(eventId);
  }

  if (verifiedIds.length < 2) {
    return assessment(
      false,
      verifiedIds.length,
      `distinct_store_verified_real_events=${verifiedIds.length} < 2`,
      verifiedIds,
      binding,
    );
  }
  return assessment(true, verifiedIds.length, "ok", verifiedIds, binding);
}

export function inspectPracticeEvidenceAssessment(
  value: unknown,
  expectedBinding: PracticeEvidenceBinding,
): { ok: boolean; distinctRealCount: number; reason: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<PracticeEvidenceAssessment>)[ASSESSMENT_BRAND] !== true
  ) {
    return { ok: false, distinctRealCount: 0, reason: "store_verified_assessment_required" };
  }
  const value_ = value as PracticeEvidenceAssessment;
  if (
    value_.parentSkillId !== expectedBinding.parentSkillId ||
    value_.parentSkillRevision !== expectedBinding.parentSkillRevision ||
    value_.sourceHash !== expectedBinding.sourceHash ||
    value_.requiredOperationClass !== expectedBinding.requiredOperationClass ||
    value_.requiredVerifierId !== expectedBinding.requiredVerifierId
  ) {
    return { ok: false, distinctRealCount: 0, reason: "practice_assessment_binding_mismatch" };
  }
  return {
    ok: value_.ok,
    distinctRealCount: value_.distinctRealCount,
    reason: value_.reason,
  };
}
