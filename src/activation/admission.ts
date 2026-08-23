/**
 * D1 Learning Admission（纯函数）。
 *
 * PracticeEvent 是 observation，不是学习许可。只有与事件、父 Skill revision/source 绑定的
 * 独立评估通过后，才可能产出 positive 或 boundary；其余情况一律 reject。
 */
import type {
  LearningAdmissionDecision,
  LearningEvidenceAssessment,
  PracticeEvent,
  SkillRecord,
} from "../core/contracts/index.ts";
import { resolveAttribution, validatePracticeEvent } from "../practice/policy/index.ts";

const SAFE_ASSESSMENT_ID_RE = /^assessment:[A-Za-z0-9._-]{1,128}$/u;
const BOUNDARY_FAILURE_CLASSES = new Set([
  "precondition_mismatch",
  "runtime_guard_failure",
  "postcondition_failure",
]);
const TASK_OUTCOMES = new Set(["verified_success", "verified_failure", "unknown"]);
const CONTRIBUTIONS = new Set(["verified", "disproved", "mixed", "unknown"]);
const EVIDENCE_KINDS = new Set(["positive", "near_miss", "boundary", "external_failure"]);
const VERIFIER_KINDS = new Set(["independent_verifier", "user_confirmation"]);
const VERIFIER_RESULTS = new Set(["pass", "fail", "unknown"]);
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLearningEvidenceAssessment(value: unknown): value is LearningEvidenceAssessment {
  if (!isRecord(value) || !isRecord(value.verifier)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.assessmentId === "string" &&
    SAFE_ASSESSMENT_ID_RE.test(value.assessmentId) &&
    typeof value.eventId === "string" &&
    typeof value.tenantScope === "string" &&
    value.tenantScope.length > 0 &&
    value.tenantScope.length <= 256 &&
    typeof value.parentSkillId === "string" &&
    typeof value.parentSkillRevision === "string" &&
    typeof value.sourceHash === "string" &&
    typeof value.taskOutcome === "string" &&
    TASK_OUTCOMES.has(value.taskOutcome) &&
    typeof value.skillContribution === "string" &&
    CONTRIBUTIONS.has(value.skillContribution) &&
    typeof value.evidenceKind === "string" &&
    EVIDENCE_KINDS.has(value.evidenceKind) &&
    typeof value.verifier.kind === "string" &&
    VERIFIER_KINDS.has(value.verifier.kind) &&
    typeof value.verifier.result === "string" &&
    VERIFIER_RESULTS.has(value.verifier.result) &&
    typeof value.assessedAt === "string" &&
    ISO_TIMESTAMP_RE.test(value.assessedAt) &&
    !Number.isNaN(Date.parse(value.assessedAt))
  );
}

function reject(
  assessment: LearningEvidenceAssessment | undefined,
  reason: string,
): LearningAdmissionDecision {
  return {
    decision: "reject",
    taskOutcome: assessment?.taskOutcome ?? "unknown",
    skillContribution: assessment?.skillContribution ?? "unknown",
    reason,
    evidenceIds: [],
  };
}

export interface LearningAdmissionInput {
  event: PracticeEvent;
  parentSkill: SkillRecord;
  assessment?: LearningEvidenceAssessment;
}

/**
 * 决定单条 observation 是否允许进入 Activation induction。
 * 不写 Store、不生成 cue、不从任务成功推断 Skill 贡献。
 */
export function decideLearningAdmission(
  input: LearningAdmissionInput,
): LearningAdmissionDecision {
  const { event, parentSkill, assessment } = input;
  const policy = validatePracticeEvent(event);
  if (!policy.ok) return reject(assessment, "practice_event_policy_invalid");
  if (event.provenance !== "real") return reject(assessment, "practice_event_not_real");
  if (event.executionMode !== "skill_md") return reject(assessment, "frozen_procedure_evidence");
  if (
    event.parentSkillId !== parentSkill.skillId ||
    event.parentSkillRevision !== parentSkill.skillRevision ||
    event.sourceHash !== parentSkill.sourceHash
  ) {
    return reject(assessment, "parent_binding_mismatch");
  }
  if (assessment === undefined) return reject(undefined, "assessment_missing");
  if (!isLearningEvidenceAssessment(assessment)) return reject(undefined, "assessment_invalid");
  if (
    assessment.eventId !== event.eventId ||
    assessment.tenantScope !== event.tenantScope ||
    assessment.parentSkillId !== event.parentSkillId ||
    assessment.parentSkillRevision !== event.parentSkillRevision ||
    assessment.sourceHash !== event.sourceHash
  ) {
    return reject(assessment, "assessment_binding_mismatch");
  }
  if (assessment.verifier.result !== "pass") {
    return reject(assessment, "assessment_not_verified");
  }
  if (assessment.taskOutcome === "unknown") return reject(assessment, "task_outcome_unknown");
  if (assessment.skillContribution === "mixed" || assessment.skillContribution === "unknown") {
    return reject(assessment, "skill_contribution_unresolved");
  }

  const evidenceIds = [event.eventId, assessment.assessmentId] as const;
  const candidate = event.candidateSkillIds.includes(parentSkill.skillId);
  const selected = event.selectedSkillIds.includes(parentSkill.skillId);

  if (assessment.evidenceKind === "positive") {
    if (
      assessment.taskOutcome !== "verified_success" ||
      assessment.skillContribution !== "verified" ||
      !candidate ||
      !selected ||
      resolveAttribution(event) !== "verified_skill_effect"
    ) {
      return reject(assessment, "positive_evidence_incomplete");
    }
    return {
      decision: "positive",
      taskOutcome: assessment.taskOutcome,
      skillContribution: assessment.skillContribution,
      reason: "verified_skill_contribution",
      evidenceIds,
    };
  }

  if (assessment.evidenceKind === "near_miss") {
    if (!candidate || selected || assessment.skillContribution !== "disproved") {
      return reject(assessment, "near_miss_evidence_incomplete");
    }
    return {
      decision: "boundary",
      taskOutcome: assessment.taskOutcome,
      skillContribution: assessment.skillContribution,
      reason: "verified_near_miss",
      evidenceIds,
    };
  }

  if (assessment.evidenceKind === "boundary") {
    if (
      assessment.taskOutcome !== "verified_failure" ||
      assessment.skillContribution !== "disproved" ||
      !candidate ||
      !selected ||
      event.failureClass === undefined ||
      !BOUNDARY_FAILURE_CLASSES.has(event.failureClass)
    ) {
      return reject(assessment, "boundary_evidence_incomplete");
    }
    return {
      decision: "boundary",
      taskOutcome: assessment.taskOutcome,
      skillContribution: assessment.skillContribution,
      reason: "verified_skill_boundary",
      evidenceIds,
    };
  }

  return reject(assessment, "external_failure_observation_only");
}
