/**
 * Phase 2 observation replay for the project-local synthetic docx pilot.
 *
 * This is an evaluation fixture, not a capture from a real user invocation.
 * It deliberately does not invoke the installed docx skill, Python helpers, or
 * a verifier host.  The step/verifier entries describe the bounded slow-path
 * surface and retain `unknown` where this harness did not execute the host.
 */
import { createHash } from "node:crypto";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import { validatePracticeEvent } from "../../practice/policy/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";

const HASH_HEX_LENGTH = 64;

function sha256(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sourceHash(payload: string): string {
  return `sha256:${sha256(payload)}`;
}

/** Stable identifiers for this synthetic/evaluation parent Skill revision. */
export const DOCX_PILOT_SKILL_ID = "evaluation:docx-pilot";
export const DOCX_PILOT_TENANT_SCOPE = "project:phase2-eval";
export const DOCX_PILOT_EVENT_ID = "phase2-docx-pilot-001";
export const DOCX_PILOT_OCCURRED_AT = "2026-08-14T00:00:00.000Z";

const DOCX_PILOT_SOURCE_HASH = sourceHash(
  "skill-cortex|phase2|docx-pilot|synthetic-skill-md|v1",
);
const DOCX_PILOT_TOOL_SCHEMA_HASH = sourceHash(
  "skill-cortex|phase2|docx-pilot|tool-schema|validate-unpack-readback|v1",
);
const DOCX_PILOT_PERMISSION_POLICY_HASH = sourceHash(
  "skill-cortex|phase2|docx-pilot|permission-policy|read-only-plus-project-temp|v1",
);

/** `rev:<64 hex>` follows the registry revision contract. */
export const DOCX_PILOT_SKILL_REVISION = `rev:${sha256(
  [DOCX_PILOT_SKILL_ID, DOCX_PILOT_SOURCE_HASH, DOCX_PILOT_TOOL_SCHEMA_HASH].join("|"),
)}`;

export const DOCX_PILOT_SOURCE_HASH_FULL = DOCX_PILOT_SOURCE_HASH;

/**
 * Every content/dependency hash is deterministic and full length.  The
 * environment class is intentionally a bounded class label, never a path.
 */
export const DOCX_PILOT_DEPENDENCY_FINGERPRINT = Object.freeze({
  sourceHash: DOCX_PILOT_SOURCE_HASH,
  toolSchemaHash: DOCX_PILOT_TOOL_SCHEMA_HASH,
  permissionPolicyHash: DOCX_PILOT_PERMISSION_POLICY_HASH,
  environmentClass: "project-temp-eval-v1",
});

const DOCX_PILOT_TASK_FEATURES = [
  "docx",
  "read-only",
  "ooxml-validate",
  "temp-unpack",
  "text-readback",
] as const;

const DOCX_PILOT_STEPS: PracticeEvent["stepSummaries"] = [
  {
    stepId: "validate",
    actor: "tool",
    operationClass: "docx-validate-read-only",
    outcome: "unknown",
  },
  {
    stepId: "unpack",
    actor: "tool",
    operationClass: "docx-unpack-project-temp-idempotent",
    outcome: "unknown",
  },
  {
    stepId: "readback",
    actor: "tool",
    operationClass: "docx-text-readback-deterministic",
    outcome: "unknown",
  },
];

const DOCX_PILOT_AUTHORIZATION_RESULTS: PracticeEvent["authorizationResults"] = [
  { gateId: "docx-read-only", result: "unknown" },
  { gateId: "project-temp-write", result: "unknown" },
];

const DOCX_PILOT_GUARD_RESULTS: PracticeEvent["guardResults"] = [
  { predicateId: "fixture-project-local", phase: "precondition", result: "unknown" },
  { predicateId: "unpack-project-temp-only", phase: "runtime", result: "unknown" },
  { predicateId: "text-readback-match", phase: "postcondition", result: "unknown" },
];

const DOCX_PILOT_VERIFIER_RESULTS: PracticeEvent["verifierResults"] = [
  {
    verifierId: "ooxml-schema-validation",
    result: "unknown",
    observedEffect: "replay-not-executed",
  },
  {
    verifierId: "deterministic-text-readback",
    result: "unknown",
    observedEffect: "replay-not-executed",
  },
];

/**
 * Build a fresh deterministic event.  The caller supplies the event ID so a
 * replay can be explicitly distinct; the Store still rejects accidental ID
 * reuse instead of silently replacing an append-only event.
 */
export function createDocxPilotEvent(
  eventId = DOCX_PILOT_EVENT_ID,
  tenantScope = DOCX_PILOT_TENANT_SCOPE,
): PracticeEvent {
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: DOCX_PILOT_OCCURRED_AT,
    tenantScope,
    provenance: "evaluation",
    parentSkillId: DOCX_PILOT_SKILL_ID,
    parentSkillRevision: DOCX_PILOT_SKILL_REVISION,
    sourceHash: DOCX_PILOT_SOURCE_HASH,
    routeDecisionId: "phase2-docx-route",
    candidateSkillIds: [DOCX_PILOT_SKILL_ID],
    selectedSkillIds: [DOCX_PILOT_SKILL_ID],
    executionMode: "skill_md",
    redactedTaskFeatures: [...DOCX_PILOT_TASK_FEATURES],
    environmentFingerprint: "project-temp-eval-v1",
    dependencyFingerprint: { ...DOCX_PILOT_DEPENDENCY_FINGERPRINT },
    stepSummaries: DOCX_PILOT_STEPS.map((step) => ({ ...step })),
    authorizationResults: DOCX_PILOT_AUTHORIZATION_RESULTS.map((result) => ({ ...result })),
    guardResults: DOCX_PILOT_GUARD_RESULTS.map((result) => ({ ...result })),
    verifierResults: DOCX_PILOT_VERIFIER_RESULTS.map((result) => ({ ...result })),
    // The policy computes the persisted attribution; no host result is self-attested.
    attribution: "unknown",
    sensitivity: "none",
    retentionClass: "project_manual",
  };
}

/** A stable fixture value for tests and offline inspection. */
export const DOCX_PILOT_EVENT = createDocxPilotEvent();

export interface DocxPilotReplayOptions {
  /** Explicitly choose a unique event ID for each replay. */
  eventId?: string;
  tenantScope?: string;
}

/**
 * Replay one evaluation observation into a caller-owned PracticeStore.
 *
 * The policy gate is called before Store.append (which calls it again before
 * any write).  Returned data is the Store round-trip, including the policy's
 * attribution/failure normalization.  No ActivationProfile or Procedure API
 * is touched by this observation-only harness.
 */
export async function replayDocxPilot(
  store: PracticeStore,
  options: DocxPilotReplayOptions = {},
): Promise<PracticeEvent> {
  const event = createDocxPilotEvent(options.eventId, options.tenantScope);
  const policyResult = validatePracticeEvent(event);
  if (!policyResult.ok) {
    const codes = policyResult.issues.map((issue) => issue.code).join(",");
    throw new Error(`phase2_replay_policy_rejected: ${codes}`);
  }

  await store.append(event);
  const persisted = await store.getEvent(event.tenantScope, event.eventId);
  if (persisted === undefined) {
    throw new Error("phase2_replay_missing_after_append");
  }
  return persisted;
}

/** Keep the hash contract visible to tests without exposing implementation details. */
export function isFullSha256(value: string): boolean {
  return /^(?:sha256:)?[0-9a-f]{64}$/.test(value) && value.replace("sha256:", "").length === HASH_HEX_LENGTH;
}
