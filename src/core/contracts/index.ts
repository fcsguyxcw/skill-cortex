export type SkillScope = "project" | "user" | "temporary";

/** 释放门控上下文（ADR-0012 §1）：合法请求上下文三态。 */
export type ExecutionContext = "shadow_replay" | "canary" | "active";
/** 决策可观察上下文：合法三态 + unknown（resolver 对缺失/非法输入规范化，绝不伪造合法值）。 */
export type DecisionExecutionContext = ExecutionContext | "unknown";

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
  /** canary 晋升绑定的 shadow replay 报告 ID（仅 canary 及以上状态写入；validated 无此字段）。 */
  canaryReportId?: string;
  /** active 晋升绑定的 canary→active 发布报告 ID（仅 active 及以上状态写入）。 */
  activeReportId?: string;
  /**
   * suspended 的来源发布状态（suspended 时必填，显式保存，不靠自由文本推断）：
   * validated/canary/active 之一（suspend 输入 status 自动派生，不可伪造）。
   * 恢复资格判定依据：resume 仅允许 suspendedFrom="active"（曾发布为 active）。
   */
  suspendedFrom?: "validated" | "canary" | "active";
  /**
   * 受控暂停类别（suspended 时必填）：manual（可逆）/ dependency_drift / evidence_cascade。
   * 恢复资格判定依据：drift/evidence 暂停必须重新验证，不得直接 resume。
   */
  suspendKind?: "manual" | "dependency_drift" | "evidence_cascade";
  /** suspended/retired 的失效/废弃原因（仅人类可读审计，不作恢复判定）。 */
  lifecycleReason?: string;
  previousStableRevision?: string;
  createdAt: string;
}

export interface ExecutionDecision {
  decisionId: string;
  skillId: string;
  skillRevision: string;
  /** 本次执行所处的释放门控上下文（ADR-0012）；unknown = 缺失/非法输入规范化的 fail-closed 值。 */
  executionContext: DecisionExecutionContext;
  mode: "compiled_procedure" | "skill_md" | "abstain";
  procedureId?: string;
  checkedPreconditions: Array<{ predicateId: string; result: boolean | "unknown" }>;
  authorizationRequired: boolean;
  reason:
    | "eligible_procedure"
    | "no_procedure"
    | "parent_skill_mismatch"
    | "revision_mismatch"
    | "dependency_mismatch"
    | "precondition_failed"
    | "authorization_required"
    | "unsupported_effect"
    | "insufficient_evidence"
    | "no_skill_selected";
  fallbackMode: "load_parent_skill" | "bounded_reasoning" | "abstain";
}
