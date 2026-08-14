import { createHash } from "node:crypto";

import type { CompiledProcedure } from "../../core/contracts/index.ts";
import {
  MAX_SQL_LENGTH,
  PAGINATION_DETECTOR_SCHEMA_VERSION,
  PAGINATION_DETECTOR_VERSION,
} from "./detector.ts";

const HASH_PATTERN = /^(?:sha256:)?([0-9a-f]{64})$/u;
const SKILL_ID_PATTERN = /^skill:[0-9a-f]{64}$/u;
const SKILL_REVISION_PATTERN = /^rev:[0-9a-f]{64}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const VALIDATION_REPORT_ID_PATTERN = /^validation:[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;

export interface ProcedureSourceBindings {
  skillMdHash: string;
  selectedReferenceHash: string;
  detectorSchemaVersion: string;
  detectorVersion: string;
  permissionPolicyHash: string;
}

export interface Phase3ProcedureDraft extends Omit<CompiledProcedure, "status"> {
  status: "draft";
  sourceBindings: ProcedureSourceBindings;
}

export interface Phase3ValidatedProcedure extends Omit<CompiledProcedure, "status"> {
  status: "validated";
  sourceBindings: ProcedureSourceBindings;
}

export interface BuildPhase3ProcedureInput {
  parentSkillId: string;
  parentSkillRevision: string;
  skillMdHash: string;
  selectedReferenceHash: string;
  permissionPolicyHash: string;
  createdAt: string;
  evidenceIds?: string[];
  detectorSchemaVersion?: string;
  detectorVersion?: string;
}

function normalizeHash(value: string, field: string): string {
  const match = HASH_PATTERN.exec(value);
  if (match === null) throw new TypeError(`${field}_must_be_full_sha256`);
  return `sha256:${match[1]}`;
}

function requireText(value: string, field: string): string {
  if (value.trim().length === 0) throw new TypeError(`${field}_must_not_be_empty`);
  return value;
}

function requirePattern(value: string, pattern: RegExp, error: string): string {
  if (!pattern.test(value)) throw new TypeError(error);
  return value;
}

function requireIsoTimestamp(value: string): string {
  if (!ISO_TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError("created_at_must_be_iso_timestamp");
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function toolSchemaHash(bindings: ProcedureSourceBindings): string {
  return hash({
    selectedReferenceHash: bindings.selectedReferenceHash,
    detectorSchemaVersion: bindings.detectorSchemaVersion,
    detectorVersion: bindings.detectorVersion,
  });
}

export function buildPhase3ProcedureDraft(
  input: BuildPhase3ProcedureInput,
): Phase3ProcedureDraft {
  const parentSkillId = requirePattern(
    input.parentSkillId,
    SKILL_ID_PATTERN,
    "parent_skill_id_must_be_skill_sha256",
  );
  const parentSkillRevision = requirePattern(
    input.parentSkillRevision,
    SKILL_REVISION_PATTERN,
    "parent_skill_revision_must_be_rev_sha256",
  );
  const createdAt = requireIsoTimestamp(input.createdAt);
  const bindings: ProcedureSourceBindings = {
    skillMdHash: normalizeHash(input.skillMdHash, "skill_md_hash"),
    selectedReferenceHash: normalizeHash(
      input.selectedReferenceHash,
      "selected_reference_hash",
    ),
    detectorSchemaVersion: requireText(
      input.detectorSchemaVersion ?? PAGINATION_DETECTOR_SCHEMA_VERSION,
      "detector_schema_version",
    ),
    detectorVersion: requireText(
      input.detectorVersion ?? PAGINATION_DETECTOR_VERSION,
      "detector_version",
    ),
    permissionPolicyHash: normalizeHash(
      input.permissionPolicyHash,
      "permission_policy_hash",
    ),
  };
  const artifactSpec = {
    kind: "bounded-offset-pagination-detector",
    bindings,
    maximumSqlLength: MAX_SQL_LENGTH,
    operation: "static_in_memory_classification",
  };
  const artifactHash = hash(artifactSpec);
  const procedureId = `procedure:phase3-pagination:${hash({ parentSkillId, parentSkillRevision }).slice(7, 23)}`;
  const procedureRevision = `rev:${hash({ procedureId, artifactHash }).slice(7)}`;

  return {
    schemaVersion: 1,
    procedureId,
    parentSkillId,
    parentSkillRevision,
    procedureRevision,
    status: "draft",
    dependencyFingerprint: {
      sourceHash: bindings.skillMdHash,
      toolSchemaHash: toolSchemaHash(bindings),
      permissionPolicyHash: bindings.permissionPolicyHash,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sql"],
      properties: { sql: { type: "string", minLength: 1, maxLength: MAX_SQL_LENGTH } },
    },
    preconditions: [
      {
        predicateId: "bounded-sql-input",
        description: `sql is a string between 1 and ${MAX_SQL_LENGTH} characters`,
      },
      {
        predicateId: "source-bindings-current",
        description: "parent source and detector dependency bindings match current values",
      },
    ],
    coveredSteps: [
      {
        stepId: "detect-offset-pagination",
        sourceClauseRefs: [
          "SKILL.md#how-to-use",
          "references/data-pagination.md#offset-pagination",
        ],
      },
    ],
    forbiddenAutomationSteps: [
      "execute-sql",
      "connect-database",
      "network-access",
      "rewrite-query",
      "modify-installed-skill",
      "read-installed-skill-at-runtime",
    ],
    runtimeGuards: [
      {
        predicateId: "bounded-supported-sql",
        description: "unsupported, malformed, or uncertain input abstains before classification",
        beforeStepIds: ["detect-offset-pagination"],
      },
      {
        predicateId: "source-and-dependency-match",
        description: "any source or dependency mismatch stops the fast path",
        beforeStepIds: ["detect-offset-pagination"],
      },
    ],
    llmHoles: [],
    declaredEffects: [],
    requiredPermissions: [],
    postconditions: [
      {
        verifierId: "phase3-pagination-structured-finding",
        description: "returns one controlled class and evidence copied from the input",
      },
    ],
    artifactLocator: `builtin:procedures/phase3/pagination-detector@${bindings.detectorVersion}`,
    artifactHash,
    evidenceIds: [...(input.evidenceIds ?? [])],
    validationReportId: "pending:phase3-pagination-validation",
    createdAt,
    sourceBindings: bindings,
  };
}

export interface CurrentProcedureBindings {
  parentSkillId: string;
  parentSkillRevision: string;
  skillMdHash: string;
  selectedReferenceHash: string;
  detectorSchemaVersion: string;
  detectorVersion: string;
  permissionPolicyHash: string;
}

export type BindingCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "source_mismatch" | "dependency_mismatch";
      mismatches: string[];
    };

/** Fail closed: malformed current hashes are mismatches, never an exception or implicit match. */
export function checkPhase3ProcedureBindings(
  procedure: Phase3ProcedureDraft,
  current: CurrentProcedureBindings,
): BindingCheck {
  const sourceMismatches: string[] = [];
  const dependencyMismatches: string[] = [];
  const safeHash = (value: string): string | undefined => {
    const match = HASH_PATTERN.exec(value);
    return match === null ? undefined : `sha256:${match[1]}`;
  };

  if (procedure.parentSkillId !== current.parentSkillId) sourceMismatches.push("parentSkillId");
  if (procedure.parentSkillRevision !== current.parentSkillRevision) {
    sourceMismatches.push("parentSkillRevision");
  }
  const skillHash = safeHash(current.skillMdHash);
  if (
    skillHash === undefined ||
    procedure.sourceBindings.skillMdHash !== skillHash ||
    procedure.dependencyFingerprint.sourceHash !== skillHash
  ) {
    sourceMismatches.push("skillMdHash");
  }
  const referenceHash = safeHash(current.selectedReferenceHash);
  if (
    referenceHash === undefined ||
    procedure.sourceBindings.selectedReferenceHash !== referenceHash
  ) {
    sourceMismatches.push("selectedReferenceHash");
  }

  const policyHash = safeHash(current.permissionPolicyHash);
  if (
    policyHash === undefined ||
    procedure.sourceBindings.permissionPolicyHash !== policyHash ||
    procedure.dependencyFingerprint.permissionPolicyHash !== policyHash
  ) {
    dependencyMismatches.push("permissionPolicyHash");
  }
  if (procedure.sourceBindings.detectorSchemaVersion !== current.detectorSchemaVersion) {
    dependencyMismatches.push("detectorSchemaVersion");
  }
  if (procedure.sourceBindings.detectorVersion !== current.detectorVersion) {
    dependencyMismatches.push("detectorVersion");
  }
  const expectedToolSchemaHash = toolSchemaHash({
    skillMdHash: skillHash ?? "sha256:" + "0".repeat(64),
    selectedReferenceHash: referenceHash ?? "sha256:" + "0".repeat(64),
    detectorSchemaVersion: current.detectorSchemaVersion,
    detectorVersion: current.detectorVersion,
    permissionPolicyHash: policyHash ?? "sha256:" + "0".repeat(64),
  });
  if (procedure.dependencyFingerprint.toolSchemaHash !== expectedToolSchemaHash) {
    dependencyMismatches.push("toolSchemaHash");
  }

  if (sourceMismatches.length > 0) {
    return { ok: false, reason: "source_mismatch", mismatches: sourceMismatches };
  }
  if (dependencyMismatches.length > 0) {
    return { ok: false, reason: "dependency_mismatch", mismatches: dependencyMismatches };
  }
  return { ok: true };
}

export interface ValidationTransition {
  decision: CompiledProcedure["status"];
  validationReportId: string;
}

/** Pure transition: only an explicit validated decision may advance a draft. */
export function transitionPhase3ProcedureValidation(
  draft: Phase3ProcedureDraft,
  transition: ValidationTransition,
): Phase3ValidatedProcedure {
  if (transition.decision !== "validated") {
    throw new Error("phase3_validation_transition_requires_validated_decision");
  }
  if (!VALIDATION_REPORT_ID_PATTERN.test(transition.validationReportId)) {
    throw new TypeError("validation_report_id_invalid");
  }
  return {
    ...draft,
    status: "validated",
    validationReportId: transition.validationReportId,
  };
}
