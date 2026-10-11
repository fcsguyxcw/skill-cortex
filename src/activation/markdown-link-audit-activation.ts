import type {
  ActivationProfile,
  LearningEvidenceAssessment,
  PracticeEvent,
  SkillRecord,
} from "../core/contracts/index.ts";
import { validatePracticeEvent } from "../practice/policy/index.ts";
import type {
  LearningAssessmentEventSource,
  LearningAssessmentReader,
} from "./admission-store.ts";
import {
  type ActivationInductionResult,
  induceActivationProfile,
} from "./induction.ts";
import {
  MARKDOWN_LINK_AUDIT_OPERATION_CLASS,
  MARKDOWN_LINK_AUDIT_PRACTICE_VERIFIER_ID,
  MARKDOWN_LINK_AUDIT_SKILL_NAME,
} from "./markdown-link-audit-contribution-verifier.ts";
import { transitionProfileToShadow, type DraftActivationProfile } from "./state.ts";
import type { ActivationProfileStore, TriggerSource } from "./store.ts";

/** Reviewed vocabulary shared by every result class. No model-authored text enters this list. */
export const MARKDOWN_LINK_AUDIT_SEMANTIC_FEATURES = [
  "task-family:markdown-relative-link-audit",
  "audit-scope:project-markdown",
  "link-class:relative-file",
] as const;

export const MARKDOWN_LINK_AUDIT_SHADOW_REPORT_ID = "shadow:markdown-link-audit-verified";

export function produceMarkdownLinkAuditSemanticFeatures(input: {
  brokenLinkCount: number;
}): string[] {
  if (!Number.isSafeInteger(input.brokenLinkCount) || input.brokenLinkCount < 0) {
    throw new TypeError("markdown_link_audit_broken_link_count_invalid");
  }
  return [
    ...MARKDOWN_LINK_AUDIT_SEMANTIC_FEATURES,
    input.brokenLinkCount === 0
      ? "result-class:clean"
      : "result-class:broken-links-present",
  ];
}

export interface MarkdownLinkAuditInductionInput {
  events: readonly PracticeEvent[];
  assessments: readonly LearningEvidenceAssessment[];
  parentSkill: SkillRecord;
  brokenLinkCount: number;
  tenantScope?: string;
}

const PROMPT_HASH_FEATURE_RE = /^prompt-hash:[0-9a-f]{32}$/u;
const COUNT_FEATURE_RE = /^(?:candidate|selected)-count:\d+$/u;

function hasMinimalObserverFeatures(event: PracticeEvent): boolean {
  return event.redactedTaskFeatures.length === 3
    && PROMPT_HASH_FEATURE_RE.test(event.redactedTaskFeatures[0] ?? "")
    && /^candidate-count:\d+$/u.test(event.redactedTaskFeatures[1] ?? "")
    && /^selected-count:\d+$/u.test(event.redactedTaskFeatures[2] ?? "")
    && event.redactedTaskFeatures.slice(1).every((feature) => COUNT_FEATURE_RE.test(feature));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function deduplicatePositiveExamples(
  examples: ActivationProfile["positiveExamples"],
): ActivationProfile["positiveExamples"] {
  const grouped = new Map<string, ActivationProfile["positiveExamples"][number]>();
  for (const example of examples) {
    const signature = JSON.stringify(example.features);
    const prior = grouped.get(signature);
    if (prior === undefined) {
      grouped.set(signature, {
        cueId: example.cueId,
        features: [...example.features],
        evidenceIds: uniqueSorted(example.evidenceIds),
      });
      continue;
    }
    grouped.set(signature, {
      cueId: prior.cueId < example.cueId ? prior.cueId : example.cueId,
      features: prior.features,
      evidenceIds: uniqueSorted([...prior.evidenceIds, ...example.evidenceIds]),
    });
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, example]) => example);
}

/**
 * Project verified Markdown-audit events onto a closed semantic vocabulary, then reuse the
 * generic admission/parent-binding checks. Raw observer features are deliberately discarded.
 */
export function induceMarkdownLinkAuditProfile(
  input: MarkdownLinkAuditInductionInput,
): ActivationInductionResult {
  if (input.parentSkill.name !== MARKDOWN_LINK_AUDIT_SKILL_NAME) {
    return { ok: false, reason: "markdown_link_audit_parent_required", passed: 0 };
  }
  if (
    input.tenantScope !== undefined
    && input.events.some((event) => event.tenantScope !== input.tenantScope)
  ) {
    return { ok: false, reason: "tenant_scope_mismatch", passed: 0 };
  }
  if (input.events.some((event) => !validatePracticeEvent(event).ok)) {
    return { ok: false, reason: "practice_event_policy_invalid", passed: 0 };
  }
  if (input.events.some((event) => !hasMinimalObserverFeatures(event))) {
    return { ok: false, reason: "minimal_observer_features_required", passed: 0 };
  }
  if (
    input.assessments.length !== input.events.length
    || input.assessments.some(
      (assessment) =>
        assessment.verifier.kind !== "independent_verifier"
        || assessment.verifier.result !== "pass",
    )
  ) {
    return { ok: false, reason: "exact_bound_assessment_required", passed: 0 };
  }
  if (input.events.some((event) =>
    !event.stepSummaries.some(
      (step) =>
        step.operationClass === MARKDOWN_LINK_AUDIT_OPERATION_CLASS
        && step.outcome === "ok",
    )
    || !event.verifierResults.some(
      (result) =>
        result.verifierId === MARKDOWN_LINK_AUDIT_PRACTICE_VERIFIER_ID
        && result.result === "pass",
    )
  )) {
    return { ok: false, reason: "markdown_link_audit_evidence_required", passed: 0 };
  }

  let features: string[];
  try {
    features = produceMarkdownLinkAuditSemanticFeatures({
      brokenLinkCount: input.brokenLinkCount,
    });
  } catch {
    return { ok: false, reason: "semantic_feature_input_invalid", passed: 0 };
  }
  const projectedEvents = input.events.map((event) => ({
    ...event,
    redactedTaskFeatures: [...features],
  }));
  const induced = induceActivationProfile({
    events: projectedEvents,
    assessments: input.assessments,
    parentSkill: input.parentSkill,
  });
  if (!induced.ok) return induced;

  const positiveExamples = deduplicatePositiveExamples(induced.profile.positiveExamples);
  return {
    ok: true,
    profile: { ...induced.profile, positiveExamples },
    summary: {
      ...induced.summary,
      positiveExampleCount: positiveExamples.length,
    },
  };
}

export interface MarkdownLinkAuditShadowInput {
  activationStore: ActivationProfileStore;
  eventSource: LearningAssessmentEventSource;
  assessmentSource: LearningAssessmentReader;
  tenantScope: string;
  eventId: string;
  parentSkill: SkillRecord;
  brokenLinkCount: number;
  learningEnabled?: () => Promise<boolean>;
  trigger?: TriggerSource;
}

export type MarkdownLinkAuditShadowResult =
  | { ok: true; profileId: string; status: "draft" | "shadow"; created: boolean }
  | { ok: false; reason: string };

/** Store-read-only formation path. It may create draft/shadow state, never active state. */
export async function induceAndStoreMarkdownLinkAuditShadow(
  input: MarkdownLinkAuditShadowInput,
): Promise<MarkdownLinkAuditShadowResult> {
  if (input.learningEnabled !== undefined && !(await input.learningEnabled())) {
    return { ok: false, reason: "learning_paused" };
  }
  const [event, assessment] = await Promise.all([
    input.eventSource.getEvent(input.tenantScope, input.eventId),
    input.assessmentSource.getAssessment(input.tenantScope, input.eventId),
  ]);
  if (event === undefined) return { ok: false, reason: "event_missing" };
  if (assessment === undefined) return { ok: false, reason: "assessment_missing" };

  const induced = induceMarkdownLinkAuditProfile({
    events: [event],
    assessments: [assessment],
    parentSkill: input.parentSkill,
    tenantScope: input.tenantScope,
    brokenLinkCount: input.brokenLinkCount,
  });
  if (!induced.ok) return { ok: false, reason: induced.reason };

  const draft = induced.profile as DraftActivationProfile;
  const existing = await input.activationStore.getProfile(draft.profileId);
  if (existing !== undefined) {
    if (existing.status !== "draft" && existing.status !== "shadow") {
      return { ok: false, reason: "existing_profile_not_shadow_only" };
    }
    return {
      ok: true,
      profileId: draft.profileId,
      status: existing.status,
      created: false,
    };
  }
  if (input.learningEnabled !== undefined && !(await input.learningEnabled())) {
    return { ok: false, reason: "learning_paused" };
  }

  const trigger = input.trigger ?? "agent";
  await input.activationStore.save(draft, { trigger });
  if (input.learningEnabled !== undefined && !(await input.learningEnabled())) {
    return { ok: true, profileId: draft.profileId, status: "draft", created: true };
  }
  const shadow = transitionProfileToShadow(draft, {
    decision: "shadow",
    shadowReportId: MARKDOWN_LINK_AUDIT_SHADOW_REPORT_ID,
  });
  await input.activationStore.transition(draft, shadow, {
    trigger,
    reportId: MARKDOWN_LINK_AUDIT_SHADOW_REPORT_ID,
  });
  return { ok: true, profileId: draft.profileId, status: "shadow", created: true };
}
