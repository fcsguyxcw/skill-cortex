/**
 * D1 bounded contribution verifier seam.
 *
 * A PracticeEvent verifier pass is observation only. Positive assessment creation additionally
 * requires an explicitly registered verifier bound to one immutable parent Skill revision/source.
 */
import { createHash } from "node:crypto";

import type {
  LearningEvidenceAssessment,
  PracticeEvent,
  SkillRecord,
} from "../core/contracts/index.ts";
import { resolveAttribution, validatePracticeEvent } from "../practice/policy/index.ts";
import type { LearningAssessmentEventSource } from "./admission-store.ts";
import { LearningAssessmentStore } from "./admission-store.ts";

export interface PositiveContributionVerifier {
  verifierId: string;
  parentSkillId: string;
  parentSkillRevision: string;
  sourceHash: string;
  requiredOperationClass: string;
  requiredPracticeVerifierId: string;
  verify(event: PracticeEvent): Promise<"verified_contribution" | "unverified">;
}

export interface VerifyAndStoreContributionInput {
  tenantScope: string;
  eventId: string;
  eventSource: LearningAssessmentEventSource;
  assessmentStore: LearningAssessmentStore;
  catalogRecords: readonly SkillRecord[];
  verifiers: readonly PositiveContributionVerifier[];
  assessedAt?: () => string;
}

export interface VerifyAndStoreContributionResult {
  status: "stored" | "skipped";
  reason:
    | "stored"
    | "event_missing"
    | "event_ineligible"
    | "parent_binding_missing"
    | "verifier_missing"
    | "verifier_binding_ambiguous"
    | "required_practice_evidence_missing"
    | "contribution_unverified"
    | "already_assessed";
  assessment?: LearningEvidenceAssessment;
}

function exactParent(event: PracticeEvent, catalogRecords: readonly SkillRecord[]): SkillRecord | undefined {
  return catalogRecords.find(
    (record) =>
      record.skillId === event.parentSkillId &&
      record.skillRevision === event.parentSkillRevision &&
      record.sourceHash === event.sourceHash,
  );
}

function matchingVerifiers(
  event: PracticeEvent,
  verifiers: readonly PositiveContributionVerifier[],
): PositiveContributionVerifier[] {
  return verifiers.filter(
    (verifier) =>
      verifier.parentSkillId === event.parentSkillId &&
      verifier.parentSkillRevision === event.parentSkillRevision &&
      verifier.sourceHash === event.sourceHash &&
      verifier.verifierId.length > 0 &&
      verifier.requiredOperationClass.length > 0 &&
      verifier.requiredPracticeVerifierId.length > 0,
  );
}

function assessmentId(event: PracticeEvent, verifier: PositiveContributionVerifier): string {
  const digest = createHash("sha256")
    .update(`${event.tenantScope}\0${event.eventId}\0${verifier.verifierId}`, "utf8")
    .digest("hex");
  return `assessment:contribution-${digest}`;
}

/**
 * Reads the persisted event, resolves only an exact catalog + verifier binding, independently
 * re-runs that verifier, and then appends a positive assessment. No registration means no learning.
 */
export async function verifyAndStorePositiveContribution(
  input: VerifyAndStoreContributionInput,
): Promise<VerifyAndStoreContributionResult> {
  const event = await input.eventSource.getEvent(input.tenantScope, input.eventId);
  if (event === undefined) return { status: "skipped", reason: "event_missing" };

  const policy = validatePracticeEvent(event);
  if (
    !policy.ok ||
    event.provenance !== "real" ||
    event.executionMode !== "skill_md" ||
    resolveAttribution(event) !== "verified_skill_effect" ||
    !event.candidateSkillIds.includes(event.parentSkillId) ||
    !event.selectedSkillIds.includes(event.parentSkillId)
  ) {
    return { status: "skipped", reason: "event_ineligible" };
  }

  if (exactParent(event, input.catalogRecords) === undefined) {
    return { status: "skipped", reason: "parent_binding_missing" };
  }
  const verifierMatches = matchingVerifiers(event, input.verifiers);
  if (verifierMatches.length === 0) return { status: "skipped", reason: "verifier_missing" };
  if (verifierMatches.length > 1) {
    return { status: "skipped", reason: "verifier_binding_ambiguous" };
  }
  const verifier = verifierMatches[0]!;

  const requiredStepPassed = event.stepSummaries.some(
    (step) => step.operationClass === verifier.requiredOperationClass && step.outcome === "ok",
  );
  const requiredVerifierPassed = event.verifierResults.some(
    (result) =>
      result.verifierId === verifier.requiredPracticeVerifierId && result.result === "pass",
  );
  if (!requiredStepPassed || !requiredVerifierPassed) {
    return { status: "skipped", reason: "required_practice_evidence_missing" };
  }

  if ((await input.assessmentStore.getAssessment(event.tenantScope, event.eventId)) !== undefined) {
    return { status: "skipped", reason: "already_assessed" };
  }
  if ((await verifier.verify(event)) !== "verified_contribution") {
    return { status: "skipped", reason: "contribution_unverified" };
  }

  const assessment: LearningEvidenceAssessment = {
    schemaVersion: 1,
    assessmentId: assessmentId(event, verifier),
    eventId: event.eventId,
    tenantScope: event.tenantScope,
    parentSkillId: event.parentSkillId,
    parentSkillRevision: event.parentSkillRevision,
    sourceHash: event.sourceHash,
    taskOutcome: "verified_success",
    skillContribution: "verified",
    evidenceKind: "positive",
    verifier: { kind: "independent_verifier", result: "pass" },
    assessedAt: (input.assessedAt ?? (() => new Date().toISOString()))(),
  };
  await input.assessmentStore.append(assessment, input.eventSource);
  return { status: "stored", reason: "stored", assessment };
}
