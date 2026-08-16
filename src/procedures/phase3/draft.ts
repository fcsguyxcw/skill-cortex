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
/** canary 晋升报告 ID："canary:" + 受控字符（与 validation report 同风格，独立前缀防串用）。 */
const CANARY_REPORT_ID_PATTERN = /^canary:[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;

/** 已知旧占位 `sha256:4f…`（ADR-0011 §2/§4：格式合法但不是真实 policy 指纹，必须拒绝）。 */
export const LEGACY_PLACEHOLDER_POLICY_HASH = `sha256:${"4f".repeat(32)}`;

export interface ProcedureSourceBindings {
  skillMdHash: string;
  selectedReferenceHash: string;
  detectorSchemaVersion: string;
  detectorVersion: string;
  /** ADR-0011：effectless/permissionless 时必须省略；声明非空权限时必填真实指纹。 */
  permissionPolicyHash?: string;
}

export interface Phase3ProcedureDraft extends Omit<CompiledProcedure, "status"> {
  status: "draft";
  sourceBindings: ProcedureSourceBindings;
}

export interface Phase3ValidatedProcedure extends Omit<CompiledProcedure, "status"> {
  status: "validated";
  sourceBindings: ProcedureSourceBindings;
}

export interface Phase3CanaryProcedure extends Omit<CompiledProcedure, "status"> {
  status: "canary";
  sourceBindings: ProcedureSourceBindings;
}

export interface BuildPhase3ProcedureInput {
  parentSkillId: string;
  parentSkillRevision: string;
  skillMdHash: string;
  selectedReferenceHash: string;
  /** ADR-0011：effectless/permissionless procedure 必须省略；提供任何值（含旧 4f 占位）一律拒绝。 */
  permissionPolicyHash?: string;
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
  // ADR-0011 §1/§4：本 builder 恒构造 effectless/permissionless procedure
  // （declaredEffects=[] 且 requiredPermissions=[]）。此类 procedure 必须显式省略
  // permissionPolicyHash；提供任何值（尤其旧 `sha256:4f…` 占位）一律构建拒绝，
  // 确保旧占位 artifact 不能继续 valid。
  if (input.permissionPolicyHash !== undefined) {
    throw new TypeError("permission_policy_hash_forbidden_for_effectless");
  }
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
      // ADR-0011：effectless/permissionless ⇒ 显式省略 permissionPolicyHash（不构成约束）。
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
  /** ADR-0011：effectless 时省略；procedure 声明非空权限时必填真实指纹。 */
  permissionPolicyHash?: string;
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
  const safeHash = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
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

  // permission 维度（ADR-0011 §1/§2/§4）：
  // - procedure 声明了 effects/permissions ⇒ sourceBindings、dependencyFingerprint 与
  //   runtime current 三方必须都存在合法 hash 且相等（缺一/占位/格式坏 ⇒ fail-closed）；
  // - effectless/permissionless ⇒ procedure 侧必须显式省略（携带任何 hash，含旧 4f 占位，
  //   ⇒ binding fail，旧占位 artifact 不能继续 valid）；runtime current 未绑定字段
  //   不构成约束（resolver 语义）。
  const hasDeclaredPermissions =
    procedure.declaredEffects.length > 0 || procedure.requiredPermissions.length > 0;
  if (hasDeclaredPermissions) {
    const boundPolicy = safeHash(procedure.sourceBindings.permissionPolicyHash);
    const fingerprintPolicy = safeHash(procedure.dependencyFingerprint.permissionPolicyHash);
    const currentPolicy = safeHash(current.permissionPolicyHash);
    if (
      boundPolicy === undefined ||
      fingerprintPolicy === undefined ||
      currentPolicy === undefined ||
      boundPolicy !== fingerprintPolicy ||
      boundPolicy !== currentPolicy ||
      // ADR-0011 §2/§4：三方一致且格式合法仍不足——已知旧占位
      // `sha256:4f…` 不是真实 policy 指纹，必须拒绝（safeHash 规范化后直接可比）。
      boundPolicy === LEGACY_PLACEHOLDER_POLICY_HASH
    ) {
      dependencyMismatches.push("permissionPolicyHash");
    }
  } else if (
    procedure.sourceBindings.permissionPolicyHash !== undefined ||
    procedure.dependencyFingerprint.permissionPolicyHash !== undefined
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
  });
  // toolSchemaHash 不依赖 permissionPolicyHash（ADR-0011 §5）：任何权限绑定变化
  // 都由上面的 permission 维度单独判定。
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
  // 运行期防御（状态机完整性）：draft 是唯一合法输入；validated/canary/active/suspended/
  // retired 输入（如 retired 复活、active 降回 validated）一律拒绝。
  if (draft.status !== "draft") {
    throw new Error("validation_transition_requires_draft_procedure");
  }
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

export interface CanaryTransition {
  decision: "canary";
  /** shadow replay 通过报告 ID（must 绑定，审计可追溯）。 */
  canaryReportId: string;
  /** 晋升时补强的 replay 证据 ID（可选；validated.evidenceIds 必须已非空）。 */
  replayEvidenceIds?: string[];
}

/**
 * Pure transition: validated → canary（Gate P4 显式发布动作，ADR-0012 §2：转换必须先发生）。
 *
 * 硬约束（ADR-0008/ADR-0012）：
 * - 输入必须已 validated；draft/canary/active 输入一律拒绝（含运行期防御，不靠类型擦除）；
 * - 必须绑定 shadow replay 通过的证据：validated.evidenceIds 非空（真实验证事件）+ canaryReportId
 *   （shadow replay 报告）；无证据 ⇒ 拒绝，canary 不能跳过独立验证；
 * - 不接收 executionContext：shadow_replay 是执行上下文（验证方法），不是 procedure 状态，
 *   不得在此混入；canary 晋升是发布动作，与本次调用在哪个上下文执行无关；
 * - 只改 status/canaryReportId，其余字段（procedureRevision/artifactHash/evidenceIds/
 *   validationReportId）原样保留，不做任何自我修改或回滚语义（rollback 属 Phase 5）。
 */
export function transitionPhase3ProcedureCanary(
  validated: Phase3ValidatedProcedure,
  transition: CanaryTransition,
): Phase3CanaryProcedure {
  // 运行期防御：类型层已约束 Phase3ValidatedProcedure，但防直接构造非法对象/cast。
  if (validated.status !== "validated") {
    throw new Error("canary_transition_requires_validated_procedure");
  }
  if (transition.decision !== "canary") {
    throw new Error("canary_transition_requires_canary_decision");
  }
  if (!CANARY_REPORT_ID_PATTERN.test(transition.canaryReportId)) {
    throw new TypeError("canary_report_id_invalid");
  }
  if (validated.evidenceIds.length === 0) {
    throw new Error("canary_transition_requires_evidence");
  }
  return {
    ...validated,
    status: "canary",
    canaryReportId: transition.canaryReportId,
    ...(transition.replayEvidenceIds !== undefined
      ? { evidenceIds: [...validated.evidenceIds, ...transition.replayEvidenceIds] }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Phase 5 状态机（slice 1）：canary→active / active↔suspended / active|suspended→retired
// 合法边：draft→validated→canary→active⇄suspended；active/suspended→retired（终态）。
// 其余一切转换（draft 直接 active、canary 直接 retired、retired 复活等）全部 fail-closed。
// 状态转换是纯函数不可变；shadow_replay 是执行上下文（验证方法），不进入状态机。
// ---------------------------------------------------------------------------

export interface Phase3ActiveProcedure extends Omit<CompiledProcedure, "status"> {
  status: "active";
  sourceBindings: ProcedureSourceBindings;
}

export interface Phase3SuspendedProcedure extends Omit<CompiledProcedure, "status"> {
  status: "suspended";
  sourceBindings: ProcedureSourceBindings;
}

export interface Phase3RetiredProcedure extends Omit<CompiledProcedure, "status"> {
  status: "retired";
  sourceBindings: ProcedureSourceBindings;
}

/** active 晋升报告 ID："active:" + 受控字符（与 validation/canary 同风格，独立前缀防串用）。 */
const ACTIVE_REPORT_ID_PATTERN = /^active:[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;

/** lifecycle reason（suspended/retired）校验：trim 后非空且 ≤ 200 字符。 */
function requireLifecycleReason(value: string): string {
  if (value.trim().length === 0) throw new TypeError("lifecycle_reason_must_not_be_empty");
  if (value.length > 200) throw new TypeError("lifecycle_reason_too_long");
  return value;
}

/**
 * 失效暂停受控 reason（lifecycleReason 人类可读审计文本；**不作恢复判定**）。
 * dependency-diff 用 "dependency drift: <dims>"（前缀）；evidence cascade 用精确值。
 * 恢复资格由显式字段 suspendedFrom/suspendKind 判定，不依赖此文本。
 */
export const SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX = "dependency drift: " as const;
export const SUSPEND_REASON_EVIDENCE_CASCADE = "evidence_cascade_deletion" as const;

/** 受控暂停类别（suspended 时显式保存；resume/rollback 恢复资格判定依据）。 */
export type SuspendKind = "manual" | "dependency_drift" | "evidence_cascade";

/** 受控暂停类别全集（运行期防御）。 */
const SUSPEND_KINDS: readonly SuspendKind[] = ["manual", "dependency_drift", "evidence_cascade"];

export interface ActiveTransition {
  decision: "active";
  /** canary→active 发布报告 ID（must 绑定，审计可追溯）。 */
  activeReportId: string;
  /**
   * 上一稳定版本 revision 引用（数据合同 §6.2：rollback 指向 previousStableRevision，非快照）。
   * 首次发布/无稳定版本时省略 ⇒ 回滚返回 no_stable_version，调用方走父 Skill 慢路径。
   */
  previousStableRevision?: string;
}

/**
 * Pure transition: canary → active（正式发布；ADR-0012 §2：转换必须先发生，不可跳过）。
 * 硬约束：输入必须已 canary（含 canary 晋升的 shadow replay 证据绑定），activeReportId 格式
 * 合法；缺 canary 报告/证据 ⇒ 拒绝（不信任无 shadow 验证链的“直接 active”）。
 */
export function transitionPhase3ProcedureActive(
  canary: Phase3CanaryProcedure,
  transition: ActiveTransition,
): Phase3ActiveProcedure {
  // 运行期防御：类型层已约束 Phase3CanaryProcedure，防直接构造非法对象/cast。
  if (canary.status !== "canary") {
    throw new Error("active_transition_requires_canary_procedure");
  }
  if (transition.decision !== "active") {
    throw new Error("active_transition_requires_active_decision");
  }
  if (!ACTIVE_REPORT_ID_PATTERN.test(transition.activeReportId)) {
    throw new TypeError("active_report_id_invalid");
  }
  if (canary.canaryReportId === undefined) {
    throw new Error("active_transition_requires_canary_evidence");
  }
  if (canary.evidenceIds.length === 0) {
    throw new Error("active_transition_requires_evidence");
  }
  if (
    transition.previousStableRevision !== undefined &&
    !STABLE_REVISION_PATTERN.test(transition.previousStableRevision)
  ) {
    throw new TypeError("previous_stable_revision_invalid");
  }
  return {
    ...canary,
    status: "active",
    activeReportId: transition.activeReportId,
    ...(transition.previousStableRevision !== undefined
      ? { previousStableRevision: transition.previousStableRevision }
      : {}),
  };
}

/** 非终态 procedure（validated/canary/active）：可被 dependency drift 失效 suspend。 */
export type Phase3InvalidatableProcedure =
  | Phase3ValidatedProcedure
  | Phase3CanaryProcedure
  | Phase3ActiveProcedure;

export interface SuspendTransition {
  decision: "suspended";
  /** 失效/降级原因（必填，仅人类可读审计；不作恢复判定）。 */
  reason: string;
  /**
   * 受控暂停类别（恢复资格判定依据）。
   * 缺失（undefined，旧调用方/未同步 store）⇒ suspended 仍可写，但 resume 判定
   * suspendKind !== "manual" ⇒ 无法直接恢复（fail-closed，须重验）；由 leader 同步
   * store 持久化后所有 suspend 调用应显式传值。
   */
  suspendKind?: SuspendKind;
}

/**
 * Pure transition: validated | canary | active → suspended（失效/降级）。不可变。
 *
 * HIGH（显式恢复资格元数据）：suspended 时显式保存
 * - suspendedFrom = 输入 procedure.status（自动派生，不可伪造）；
 * - suspendKind = transition.suspendKind（受控枚举，不靠 reason 文本推断）；
 * - lifecycleReason 仅人类可读审计，不参与恢复判定。
 *
 * draft 不经状态机路径（必须先 validated）；终态 suspended/retired 不重复 suspend
 * （fail-closed）。审计字段（validation/canary/active 报告与证据链）随 spread 保留。
 */
export function transitionPhase3ProcedureSuspend(
  procedure: Phase3InvalidatableProcedure,
  transition: SuspendTransition,
): Phase3SuspendedProcedure {
  if (
    procedure.status !== "validated" &&
    procedure.status !== "canary" &&
    procedure.status !== "active"
  ) {
    throw new Error("suspend_transition_requires_non_terminal_procedure");
  }
  if (transition.decision !== "suspended") {
    throw new Error("suspend_transition_requires_suspended_decision");
  }
  requireLifecycleReason(transition.reason);
  if (transition.suspendKind !== undefined && !SUSPEND_KINDS.includes(transition.suspendKind)) {
    throw new Error("suspend_transition_requires_controlled_suspend_kind");
  }
  return {
    ...procedure,
    status: "suspended",
    // 显式保存恢复资格元数据（suspendedFrom 自动派生自输入 status）。
    suspendedFrom: procedure.status,
    suspendKind: transition.suspendKind,
    lifecycleReason: transition.reason,
  };
}

export interface ResumeTransition {
  decision: "active";
}

/** Pure transition: suspended → active（resume；仅原 suspended 允许；恢复发布级，非重新晋升）。 */
export function transitionPhase3ProcedureResume(
  suspended: Phase3SuspendedProcedure,
  transition: ResumeTransition,
): Phase3ActiveProcedure {
  if (suspended.status !== "suspended") {
    throw new Error("resume_transition_requires_suspended_procedure");
  }
  if (transition.decision !== "active") {
    throw new Error("resume_transition_requires_active_decision");
  }
  // HIGH：恢复资格由显式字段判定，不靠自由文本 reason。
  // - suspendedFrom=active（曾发布为 active）且 suspendKind=manual（可逆暂停）⇒ 允许直接 resume；
  // - suspendedFrom=validated/canary ⇒ 必须回对应重验/晋升路径（不得绕过 promotion gate）；
  // - suspendKind=drift/evidence ⇒ 必须重新验证；
  // - 任一字段缺失（旧数据）⇒ fail-closed 拒绝（不乐观放行）。
  if (suspended.suspendedFrom !== "active" || suspended.suspendKind !== "manual") {
    throw new Error("resume_blocked_requires_revalidation");
  }
  // resume 恢复原发布状态：清除 suspended 元数据（lifecycleReason/suspendedFrom/suspendKind）；
  // 不产生新报告（resume 不是晋升）。
  const { lifecycleReason: _reason, suspendedFrom: _from, suspendKind: _kind, ...rest } = suspended;
  void _reason;
  void _from;
  void _kind;
  return { ...rest, status: "active" };
}

export interface RetireTransition {
  decision: "retired";
  /** 卸载/废弃原因（必填，可审计）。 */
  reason: string;
}

/**
 * Pure transition: active | suspended → retired（卸载/废弃；reason 必填；终态）。
 * draft/validated/canary/retired 输入一律拒绝（canary 不能直接废弃——必须经 active/suspended
 * 的受控路径；retired 是终态，不得复活）。
 */
export function transitionPhase3ProcedureRetire(
  procedure: Phase3ActiveProcedure | Phase3SuspendedProcedure,
  transition: RetireTransition,
): Phase3RetiredProcedure {
  if (procedure.status !== "active" && procedure.status !== "suspended") {
    throw new Error("retire_transition_requires_active_or_suspended_procedure");
  }
  if (transition.decision !== "retired") {
    throw new Error("retire_transition_requires_retired_decision");
  }
  requireLifecycleReason(transition.reason);
  return {
    ...procedure,
    status: "retired",
    lifecycleReason: transition.reason,
  };
}

// ---------------------------------------------------------------------------
// Phase 5 slice 3：rollback + previous stable revision（纯函数，project-local）
//
// 数据合同 §6.2：rollback 指向 previousStableRevision（procedureRevision 字符串引用，
// 不是快照）；不存在稳定版本时走父 Skill 慢路径（不猜测、不伪造回滚）。
// 本模块不持有版本 registry：stableLookup 由调用方（发布管道）注入；纯函数只做判定。
// ---------------------------------------------------------------------------

/** procedureRevision 引用格式（"rev:" + 64 hex；与 buildPhase3ProcedureDraft 生成一致）。 */
const STABLE_REVISION_PATTERN = /^rev:[0-9a-f]{64}$/u;

export type RollbackFailureReason =
  | "no_stable_version"
  | "invalid_stable_version"
  | "identity_mismatch"
  | "requires_revalidation";

export type RollbackResult =
  | { ok: true; rollbackTo: CompiledProcedure & { status: "active" } }
  | { ok: false; reason: RollbackFailureReason };

export interface RollbackInput {
  /** 待回滚的失效版本（active 晋升时记录了 previousStableRevision 的发布版本）。 */
  current: CompiledProcedure;
  /** 按 procedureRevision 查找稳定版本的注入查找（纯函数不持有 registry）。 */
  stableLookup: (procedureRevision: string) => CompiledProcedure | undefined;
  /**
   * 显式声明 current dependency revalidation（HIGH 2）：suspended 失效 target
   * （dependency drift / evidence cascade）恢复 active 必须已重验；缺省 ⇒ fail-closed
   * requires_revalidation（不复活 drift/evidence 失效版本）。manual suspended / active
   * target 不受此门约束。
   */
  dependencyRevalidated?: boolean;
}

/**
 * 一键回滚（纯函数不可变）：
 * - current.previousStableRevision 缺失 ⇒ no_stable_version（调用方走父 Skill 慢路径）；
 * - stableLookup 找不到该 revision ⇒ no_stable_version（不猜测、不伪造）；
 * - HIGH 2 identity（lineage）fail-closed：target.procedureRevision 必须精确等于引用、
 *   procedureId/parentSkillId 必须与 current 同源（防注入任意稳定状态对象冒充）；
 * - target 非稳定状态（draft/validated/canary/retired）⇒ invalid_stable_version；
 * - suspended 失效 target（drift/cascade）未经 dependencyRevalidated ⇒ requires_revalidation；
 * - 命中 ⇒ 返回该稳定版本以 active 状态恢复的副本（rollbackTo），不改 current/stable 原对象。
 */
export function rollbackProcedure(input: RollbackInput): RollbackResult {
  const previous = input.current.previousStableRevision;
  if (previous === undefined) {
    return { ok: false, reason: "no_stable_version" };
  }
  if (!STABLE_REVISION_PATTERN.test(previous)) {
    // 防御：格式非法的引用视为“无可用稳定版本”（fail-closed，不当作有效引用）。
    return { ok: false, reason: "invalid_stable_version" };
  }
  const stable = input.stableLookup(previous);
  if (stable === undefined) {
    return { ok: false, reason: "no_stable_version" };
  }
  // HIGH 2：identity/lineage 精确校验（先于状态判定）。
  if (stable.procedureRevision !== previous) {
    return { ok: false, reason: "identity_mismatch" };
  }
  if (stable.procedureId !== input.current.procedureId) {
    return { ok: false, reason: "identity_mismatch" };
  }
  if (stable.parentSkillId !== input.current.parentSkillId) {
    return { ok: false, reason: "identity_mismatch" };
  }
  if (
    stable.status === "draft" ||
    stable.status === "validated" ||
    stable.status === "canary" ||
    stable.status === "retired"
  ) {
    return { ok: false, reason: "invalid_stable_version" };
  }
  // HIGH：suspended target 的恢复资格由显式字段判定（不靠 reason 文本）：
  // - suspendedFrom=active（曾发布为 active）才是稳定版本；validated/canary 来源的
  //   suspended（从未 active）不是稳定版本 ⇒ invalid_stable_version；
  // - suspendKind 非 manual（drift/cascade，或字段缺失的旧数据）⇒ 必须已重验，
  //   否则 requires_revalidation（不复活失效版本）。
  if (stable.status === "suspended") {
    if (stable.suspendedFrom !== "active") {
      return { ok: false, reason: "invalid_stable_version" };
    }
    if (stable.suspendKind !== "manual" && input.dependencyRevalidated !== true) {
      return { ok: false, reason: "requires_revalidation" };
    }
  }
  // 恢复为 active 发布状态（不可变：不改 stable 原对象，返回新副本）；
  // 清除 suspended 元数据（lifecycleReason/suspendedFrom/suspendKind）。
  const { lifecycleReason: _reason, suspendedFrom: _from, suspendKind: _kind, ...rest } = stable;
  void _reason;
  void _from;
  void _kind;
  return {
    ok: true,
    rollbackTo: { ...rest, status: "active" },
  };
}
