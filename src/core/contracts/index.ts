export type SkillScope = "project" | "user" | "temporary";

export interface DependencyFingerprint {
  sourceHash: string;
  toolSchemaHash?: string;
  permissionPolicyHash?: string;
  environmentClass?: string;
  modelId?: string;
  promptHash?: string;
}

export interface SkillRecord {
  schemaVersion: 1;
  skillId: string;
  skillRevision: string;
  name: string;
  description: string;
  scope: SkillScope;
  sourceLocator: string;
  sourceHash: string;
  disableModelInvocation: boolean;
  declaredAliases: string[];
  declaredEffects: string[];
  declaredPermissions: string[];
  dependencyManifest: Array<{
    locator: string;
    contentHash: string;
    role: "instruction" | "script" | "reference" | "asset";
  }>;
  discoveredAt: string;
}

export interface SkillCandidate {
  skillId: string;
  skillRevision: string;
  name: string;
  description: string;
  scope: SkillScope;
  retrievalScore: number;
  evidence: Array<
    | { kind: "declared_text"; field: "name" | "description" | "alias" }
    | { kind: "learned_cue"; cueId: string }
  >;
}

export interface ActivationProfile {
  schemaVersion: 1;
  profileId: string;
  parentSkillId: string;
  parentSkillRevision: string;
  status: "draft" | "shadow" | "active" | "suspended" | "retired";
  learnedAliases: Array<{ cueId: string; text: string; evidenceIds: string[] }>;
  positiveExamples: Array<{ cueId: string; features: string[]; evidenceIds: string[] }>;
  nearMissExamples: Array<{ cueId: string; features: string[]; evidenceIds: string[] }>;
  environmentCues: Array<{ key: string; valueClass: string; evidenceIds: string[] }>;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeEvent {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  tenantScope: string;
  provenance: "real" | "shadow" | "evaluation" | "synthetic";
  parentSkillId: string;
  parentSkillRevision: string;
  sourceHash: string;
  routeDecisionId?: string;
  candidateSkillIds: string[];
  selectedSkillIds: string[];
  executionMode: "skill_md" | "compiled_procedure";
  procedureId?: string;
  redactedTaskFeatures: string[];
  environmentFingerprint?: string;
  dependencyFingerprint?: DependencyFingerprint;
  stepSummaries: Array<{
    stepId: string;
    actor: "agent" | "procedure" | "tool" | "user";
    operationClass: string;
    outcome: "ok" | "failed" | "unknown";
  }>;
  authorizationResults: Array<{
    gateId: string;
    result: "approved" | "denied" | "not_required" | "unknown";
  }>;
  guardResults: Array<{
    predicateId: string;
    phase: "precondition" | "runtime" | "postcondition";
    result: "pass" | "fail" | "unknown";
  }>;
  verifierResults: Array<{
    verifierId: string;
    result: "pass" | "fail" | "unknown";
    observedEffect?: string;
  }>;
  attribution: "verified_skill_effect" | "mixed" | "unknown";
  failureClass?:
    | "precondition_mismatch"
    | "runtime_guard_failure"
    | "procedure_error"
    | "tool_failure"
    | "environment_drift"
    | "permission_denied"
    | "postcondition_failure"
    | "user_interruption"
    | "unknown";
  firstAttributableFailureStepId?: string;
  sensitivity: "none" | "internal" | "confidential";
  retentionClass: string;
}

export interface CompiledProcedure {
  schemaVersion: 1;
  procedureId: string;
  parentSkillId: string;
  parentSkillRevision: string;
  procedureRevision: string;
  status: "draft" | "validated" | "canary" | "active" | "suspended" | "retired";
  dependencyFingerprint: DependencyFingerprint;
  inputSchema: Record<string, unknown>;
  preconditions: Array<{ predicateId: string; description: string }>;
  coveredSteps: Array<{ stepId: string; sourceClauseRefs: string[] }>;
  forbiddenAutomationSteps: string[];
  runtimeGuards: Array<{
    predicateId: string;
    description: string;
    beforeStepIds: string[];
  }>;
  llmHoles: Array<{
    holeId: string;
    purpose: string;
    inputBoundary: string[];
    outputSchema: Record<string, unknown>;
  }>;
  declaredEffects: string[];
  requiredPermissions: string[];
  postconditions: Array<{ verifierId: string; description: string }>;
  artifactLocator: string;
  artifactHash: string;
  evidenceIds: string[];
  validationReportId: string;
  previousStableRevision?: string;
  createdAt: string;
}

export interface ExecutionDecision {
  decisionId: string;
  skillId: string;
  skillRevision: string;
  mode: "compiled_procedure" | "skill_md" | "abstain";
  procedureId?: string;
  checkedPreconditions: Array<{ predicateId: string; result: boolean | "unknown" }>;
  authorizationRequired: boolean;
  reason:
    | "eligible_procedure"
    | "no_procedure"
    | "revision_mismatch"
    | "dependency_mismatch"
    | "precondition_failed"
    | "authorization_required"
    | "unsupported_effect"
    | "insufficient_evidence"
    | "no_skill_selected";
  fallbackMode: "load_parent_skill" | "bounded_reasoning" | "abstain";
}
