/**
 * Phase 4 host 接线——pilot 专用 shadow adapter（project-local；不部署 canary/active）。
 *
 * 职责（ADR-0012 shadow_replay 语义 + 本轮冻结）：
 * - 注册工具 `skill_cortex_pagination_detect`（参数仅 sql/skill_id/skill_revision）；
 * - 工具内部用 validated procedure（buildCanaryValidatedProcedure）+ executor.execute，
 *   executionContext 硬编码 shadow_replay、effects=[]；artifact = 纯 detectPagination +
 *   verifyStructuredFinding（只读、无副作用）；
 * - 注册 tool_call preflight：仅本工具，严格核对父 skill id/revision 后生成以 toolCallId
 *   键控的一次性 authorization receipt；失配 ⇒ {block:true, reason:受控码, terminate:true}
 *   （host 多 handler 首 block 短路语义，runner.js 已核验）；
 * - 工具 execute 必须消费 receipt：无 receipt / 重放 ⇒ executor auth denied，绝不无条件
 *   approved；finally 清 receipt；
 * - details 严格有界（snake_case，observer 可解码）：无原始 SQL/路径/error 原文；
 *   decodeExecutionToolDetails 严格 fail-closed；
 * - fallback 只给调用 load_skill 的受控指示，不冒充已加载（loadParentSkill 返回 loaded=false）。
 *
 * 边界：不写用户环境；不启动 canary/active；不修改 observer/.pi 入口。
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

import type { CompiledProcedure, DependencyFingerprint } from "../../core/contracts/index.ts";
import type { GuardObservation } from "../../runtime/guard.ts";
import {
  buildCanaryValidatedProcedure,
  CANARY_EXECUTION_CONTEXT,
} from "../../evaluation/phase4/canary.ts";
import { detectPagination, type PaginationFinding } from "../../procedures/phase3/detector.ts";
import {
  execute,
  type ExecutionOutcome,
  type ExecutorServices,
} from "../../runtime/executor.ts";
import {
  PAGINATION_OPERATION_CLASS,
  PAGINATION_VERIFIER_ID,
  verifyStructuredFinding,
} from "./practice-pagination-hook.ts";

export const PILOT_TOOL_NAME = "skill_cortex_pagination_detect" as const;
/** 工具参数上限（与 detector.MAX_SQL_LENGTH 一致；独立冻结避免跨模块耦合）。 */
export const PILOT_SQL_MAX_LENGTH = 16_384;
/** 受控 block 码（模型可见，不泄漏内部细节）。 */
export const BLOCK_REASON_SKILL_IDENTITY_MISMATCH = "skill_cortex:skill_identity_mismatch";
export const DETAILS_SCHEMA_VERSION = 1 as const;
/** 授权 gate id（observer/审计可关联）。 */
export const PILOT_AUTH_GATE_ID = "pilot_receipt";

/** 受控 failure 码（无原始 error message）。 */
export type PilotFailureCode =
  | "authorization_missing_or_replayed"
  | "guard_failure"
  | "verifier_failure"
  | "procedure_error"
  | "artifact_result_invalid"
  | "unexpected_side_effect";

// ---------------------------------------------------------------------------
// receipt store（toolCallId 键控，一次性）
// ---------------------------------------------------------------------------

export interface AuthorizationReceipt {
  skillId: string;
  skillRevision: string;
}

export interface ReceiptStore {
  /** 当前持票数（测试/审计）。 */
  readonly size: number;
  put(toolCallId: string, receipt: AuthorizationReceipt): void;
  /** 消费（取出并删除）；不存在返回 undefined。 */
  take(toolCallId: string): AuthorizationReceipt | undefined;
  has(toolCallId: string): boolean;
  clear(toolCallId: string): void;
}

export function createReceiptStore(): ReceiptStore {
  const map = new Map<string, AuthorizationReceipt>();
  return {
    get size() {
      return map.size;
    },
    put(toolCallId, receipt) {
      map.set(toolCallId, receipt);
    },
    take(toolCallId) {
      const receipt = map.get(toolCallId);
      if (receipt !== undefined) map.delete(toolCallId);
      return receipt;
    },
    has(toolCallId) {
      return map.has(toolCallId);
    },
    clear(toolCallId) {
      map.delete(toolCallId);
    },
  };
}

// ---------------------------------------------------------------------------
// preflight（tool_call 事件）
// ---------------------------------------------------------------------------

export interface PreflightInput {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  procedure: CompiledProcedure;
  store: ReceiptStore;
}

export type PreflightResult = undefined | { block: true; reason: string; terminate: true };

/**
 * 仅本工具：严格核对父 skill id/revision。匹配 ⇒ 生成一次性 receipt 并放行；
 * 失配 ⇒ block（受控码 + terminate），无 receipt（blocked 无 execute，host 已核验）。
 */
export function preflightPaginationTool(input: PreflightInput): PreflightResult {
  if (input.toolName !== PILOT_TOOL_NAME) return undefined;
  const skillId = typeof input.input.skill_id === "string" ? input.input.skill_id : undefined;
  const skillRevision =
    typeof input.input.skill_revision === "string" ? input.input.skill_revision : undefined;
  if (
    skillId === input.procedure.parentSkillId &&
    skillRevision === input.procedure.parentSkillRevision
  ) {
    input.store.put(input.toolCallId, { skillId, skillRevision });
    return undefined;
  }
  return { block: true, reason: BLOCK_REASON_SKILL_IDENTITY_MISMATCH, terminate: true };
}

// ---------------------------------------------------------------------------
// details（严格有界，snake_case，observer 可解码）
// ---------------------------------------------------------------------------

export interface PilotGuardResult {
  predicate_id: string;
  phase: string;
  result: "pass" | "fail" | "unknown";
}

export interface PilotVerifierResult {
  verifier_id: string;
  result: "pass" | "fail" | "unknown";
  observed_effect?: string;
}

export interface PilotStepSummary {
  step_id: string;
  actor: string;
  operation_class: string;
  outcome: "ok" | "failed" | "unknown";
}

export type PilotOutcome =
  | "fast_path"
  | "fallback"
  | "abstain"
  | "denied"
  | "safety_stop"
  | "slow_path";

export interface PilotToolDetails {
  schema_version: typeof DETAILS_SCHEMA_VERSION;
  tool: typeof PILOT_TOOL_NAME;
  outcome: PilotOutcome;
  /** 受控 failure 码（无原始 error message/路径）。 */
  failure?: PilotFailureCode;
  skill_id: string;
  skill_revision: string;
  source_hash: string;
  procedure_id: string;
  dependency_fingerprint: {
    source_hash: string;
    tool_schema_hash?: string;
    permission_policy_hash?: string;
  };
  authorization_results: Array<{ gate_id: string; result: "approved" | "denied" }>;
  guard_results: PilotGuardResult[];
  verifier_results: PilotVerifierResult[];
  step_summaries: PilotStepSummary[];
  /** 受控 finding 类别（仅受控枚举；不含 matchText/原始 SQL）。 */
  finding_class?: "uses_offset" | "uses_keyset" | "no_pagination" | "abstain";
  /** 回退指示（load_skill_indicated=true 表示应调用 load_skill 走慢路径；不冒充已加载）。 */
  fallback?: { mode: string; load_skill_indicated: true };
  decision: { mode: string; reason: string; execution_context: string };
}

function fingerprintOf(procedure: CompiledProcedure): PilotToolDetails["dependency_fingerprint"] {
  const fp: PilotToolDetails["dependency_fingerprint"] = {
    source_hash: procedure.dependencyFingerprint.sourceHash,
  };
  if (procedure.dependencyFingerprint.toolSchemaHash !== undefined) {
    fp.tool_schema_hash = procedure.dependencyFingerprint.toolSchemaHash;
  }
  if (procedure.dependencyFingerprint.permissionPolicyHash !== undefined) {
    fp.permission_policy_hash = procedure.dependencyFingerprint.permissionPolicyHash;
  }
  return fp;
}

function guardResultsOf(results: PilotToolDetails["guard_results"]) {
  return results;
}

/** ExecutionOutcome → 受控 details（只映射白名单字段；失败仅受控码）。
 * `executedSteps` 由调用方闭包记录（executor fallback/safety_stop 不透传 artifact steps）。 */
function buildDetails(
  outcome: ExecutionOutcome,
  procedure: CompiledProcedure,
  executedSteps: PilotStepSummary[],
): PilotToolDetails {
  const base = {
    schema_version: DETAILS_SCHEMA_VERSION,
    tool: PILOT_TOOL_NAME,
    skill_id: outcome.decision.skillId,
    skill_revision: outcome.decision.skillRevision,
    source_hash: procedure.dependencyFingerprint.sourceHash,
    procedure_id: procedure.procedureId,
    dependency_fingerprint: fingerprintOf(procedure),
    guard_results: [] as PilotGuardResult[],
    verifier_results: [] as PilotVerifierResult[],
    step_summaries: [] as PilotStepSummary[],
    decision: {
      mode: outcome.decision.mode,
      reason: outcome.decision.reason,
      execution_context: outcome.decision.executionContext,
    },
  };

  switch (outcome.outcome) {
    case "fast_path": {
      const finding = outcome.result as PaginationFinding;
      return {
        ...base,
        outcome: "fast_path",
        finding_class: finding.class,
        authorization_results: [{ gate_id: PILOT_AUTH_GATE_ID, result: "approved" }],
        guard_results: guardResultsOf(
          outcome.guardResults.map((g) => ({
            predicate_id: g.predicateId,
            phase: g.phase,
            result: g.result,
          })),
        ),
        verifier_results: outcome.verifierResults.map((v) => ({
          verifier_id: v.verifierId,
          result: v.result,
          ...(v.observedEffect !== undefined ? { observed_effect: v.observedEffect } : {}),
        })),
        step_summaries: executedSteps,
      };
    }
    case "fallback": {
      const isAbstained = outcome.fallbackReason === "procedure_abstained";
      return {
        ...base,
        outcome: isAbstained ? "abstain" : "fallback",
        ...(isAbstained ? { finding_class: "abstain" as const } : { failure: failureCodeOf(outcome.fallbackReason) }),
        authorization_results: [{ gate_id: PILOT_AUTH_GATE_ID, result: "approved" }],
        guard_results: guardResultsOf(
          outcome.guardResults.map((g) => ({
            predicate_id: g.predicateId,
            phase: g.phase,
            result: g.result,
          })),
        ),
        verifier_results: outcome.verifierResults.map((v) => ({
          verifier_id: v.verifierId,
          result: v.result,
          ...(v.observedEffect !== undefined ? { observed_effect: v.observedEffect } : {}),
        })),
        // 已执行（guard 通过后）的固定 detect step 如实记录；guard 失败时为空。
        step_summaries: executedSteps,
        // 只给调用 load_skill 的受控指示；不冒充已加载（executor slowPath.loaded=false 不落盘）。
        fallback: { mode: outcome.fallback.fallbackMode, load_skill_indicated: true },
      };
    }
    case "denied":
      return {
        ...base,
        outcome: "denied",
        failure: "authorization_missing_or_replayed",
        authorization_results: [{ gate_id: PILOT_AUTH_GATE_ID, result: "denied" }],
      };
    case "safety_stop":
      return {
        ...base,
        outcome: "safety_stop",
        failure: outcome.safetyReason,
        authorization_results: [{ gate_id: PILOT_AUTH_GATE_ID, result: "approved" }],
        guard_results: guardResultsOf(
          outcome.guardResults.map((g) => ({
            predicate_id: g.predicateId,
            phase: g.phase,
            result: g.result,
          })),
        ),
        step_summaries: executedSteps,
        fallback: { mode: "load_parent_skill", load_skill_indicated: true },
      };
    case "slow_path":
      // 防御：shadow_replay + validated + 身份匹配下不应发生；只给慢路径指示。
      return {
        ...base,
        outcome: "slow_path",
        authorization_results: [],
        fallback: { mode: "load_parent_skill", load_skill_indicated: true },
      };
    case "abstain":
      // executor 无顶层 abstain（no_skill_selected 时本工具不会执行）。
      return {
        ...base,
        outcome: "abstain",
        finding_class: "abstain",
        authorization_results: [],
      };
  }
}

function failureCodeOf(reason: string): PilotFailureCode {
  switch (reason) {
    case "guard_failure":
      return "guard_failure";
    case "verifier_failure":
      return "verifier_failure";
    case "procedure_error":
      return "procedure_error";
    case "procedure_abstained":
      return "guard_failure"; // 防御（abstained 已在上面分支处理）
    default:
      return "procedure_error";
  }
}

// ---------------------------------------------------------------------------
// execute（工具主体）
// ---------------------------------------------------------------------------

export interface PilotExecuteParams {
  sql: string;
  skill_id: string;
  skill_revision: string;
}

export interface PilotToolExecuteResult {
  content: Array<{ type: "text"; text: string }>;
  details: PilotToolDetails;
}

function contentOf(details: PilotToolDetails): string {
  const skillRef = `skill_id=${details.skill_id}`;
  switch (details.outcome) {
    case "fast_path":
      return `分页静态检测完成（finding_class=${details.finding_class ?? "unknown"}）。`;
    case "abstain":
      return `无法确定分页方式（abstain）。请调用 load_skill(${skillRef}, skill_revision=${details.skill_revision}) 读取父 Skill 走慢路径。`;
    case "fallback":
      return `快路径安全回退（failure=${details.failure ?? "unknown"}）。请调用 load_skill(${skillRef}, skill_revision=${details.skill_revision}) 读取父 Skill 走慢路径。`;
    case "denied":
      return `授权被拒绝（authorization_missing_or_replayed）。请调用 load_skill(${skillRef}, skill_revision=${details.skill_revision}) 读取父 Skill 走慢路径。`;
    case "safety_stop":
      return `执行安全停止（${details.failure ?? "unknown"}）。请调用 load_skill(${skillRef}, skill_revision=${details.skill_revision}) 读取父 Skill 走慢路径。`;
    case "slow_path":
      return `已路由到慢路径。请调用 load_skill(${skillRef}, skill_revision=${details.skill_revision}) 读取父 Skill。`;
  }
}

export interface ExecutePaginationDetectInput {
  toolCallId: string;
  params: PilotExecuteParams;
  store: ReceiptStore;
  procedure: CompiledProcedure;
  /**
   * 注入点：当次 discovery 快照的当前父 Skill revision（resolver e 分支验证来源，ADR-0012 §3）。
   * 未提供 ⇒ 回退 procedure.parentSkillRevision（保持既有 canary/E2E self-match 行为）。
   * 真实宿主应传 routeSnapshotSource 候选卡 / 宿主环境的当前值（见报告：current 来源设计）。
   */
  currentSkillRevision?: string;
  /**
   * 注入点：当次 discovery 快照的当前依赖指纹（resolver f 分支）。
   * 未提供 ⇒ 回退 procedure.dependencyFingerprint（self-match）。
   */
  currentDependencyFingerprint?: DependencyFingerprint;
  /**
   * 注入点：快路径 runtime guard 观察数组（覆盖默认 self-match 观察）。
   * 未提供 ⇒ 默认 [bounded-supported-sql, source-and-dependency-match=true]。
   * 注意 checkGuards fail-closed：注入数组必须覆盖 procedure 声明的两个 runtime guard，
   * 缺省会合成 unknown ⇒ guard_failure（不乐观通过）。
   */
  guardObservations?: ReadonlyArray<GuardObservation>;
}

/**
 * 工具主体：executor.execute（shadow_replay 硬编码、effects=[]）。
 * receipt 由 checkAuthorization 消费（无 receipt/重放 ⇒ denied）；finally 清 receipt。
 *
 * 注入点（cc HIGH 1 修复）：currentSkillRevision/currentDependencyFingerprint/guardObservations
 * 可选传入；未提供时回退 procedure 自身值（self-match，保持 canary/E2E 行为），提供时
 * 经 resolver e/f 分支与 runtime guard 真实生效（mismatch ⇒ slow_path + load_parent_skill）。
 */
export async function executePaginationDetect(
  input: ExecutePaginationDetectInput,
): Promise<PilotToolExecuteResult> {
  const { toolCallId, params, store, procedure } = input;
  const sqlTypeOk = typeof params.sql === "string";
  const sql = sqlTypeOk ? params.sql : "";
  // precondition 只查类型；runtime guard 查完整有界（非空 + ≤ 上限）——guard 是独立运行期防线。
  const sqlOk = sqlTypeOk && sql.length > 0 && sql.length <= PILOT_SQL_MAX_LENGTH;
  // 注入点默认回退（保持既有 canary/E2E self-match 行为不变）：
  // - currentSkillRevision/currentDependencyFingerprint 未提供 ⇒ procedure 自身值
  //   （resolver e/f 分支与 procedure 比较恒通过）；
  // - guardObservations 未提供 ⇒ 默认 self-match 观察（source-and-dependency-match=true）。
  // 提供注入值时 revision/dependency 校验真实生效（mismatch ⇒ slow_path/load_parent_skill）。
  const currentSkillRevision = input.currentSkillRevision ?? procedure.parentSkillRevision;
  const currentDependencyFingerprint =
    input.currentDependencyFingerprint ?? procedure.dependencyFingerprint;
  const guardObservations = input.guardObservations ?? [
    { predicateId: "bounded-supported-sql", phase: "runtime", result: sqlOk },
    { predicateId: "source-and-dependency-match", phase: "runtime", result: true },
  ];
  // artifact 执行闭包记录：executor 的 fallback/safety_stop outcome 不透传 artifact steps，
  // 由 adapter 以固定 detect step 如实记录（guard 失败时保持空）。
  let executedSteps: PilotStepSummary[] = [];

  const services: ExecutorServices = {
    async executeArtifact() {
      const finding = detectPagination(sql);
      executedSteps = [
        {
          step_id: PAGINATION_OPERATION_CLASS,
          actor: "procedure",
          operation_class: PAGINATION_OPERATION_CLASS,
          outcome: "ok",
        },
      ];
      return {
        result: finding,
        steps: [
          {
            stepId: PAGINATION_OPERATION_CLASS,
            actor: "procedure",
            operationClass: PAGINATION_OPERATION_CLASS,
            outcome: "ok",
          },
        ],
        disposition: finding.class === "abstain" ? "abstained" : "completed",
        sideEffectCount: 0,
      };
    },
    async loadParentSkill() {
      // 不冒充已加载：fallback 只指示调用 load_skill（host 侧由模型/用户执行）。
      return { loaded: false };
    },
    async checkAuthorization(request) {
      // 一次性 receipt：存在即消费；随后完整核对（身份 + procedureId + claims 精确一致），
      // 不能只比 skillId（伪造 receipt / 声明不符 ⇒ denied）。
      const receipt = store.take(toolCallId);
      if (receipt === undefined) return "denied";
      if (receipt.skillId !== procedure.parentSkillId) return "denied";
      if (receipt.skillRevision !== procedure.parentSkillRevision) return "denied";
      if (request.procedureId !== procedure.procedureId) return "denied";
      if (!arraysEqual(request.claims.effects, procedure.declaredEffects)) return "denied";
      if (!arraysEqual(request.claims.permissions, procedure.requiredPermissions)) return "denied";
      return "approved";
    },
    async verifyPostcondition({ result, taskInput }) {
      const taskSql = typeof (taskInput as { sql?: unknown } | undefined)?.sql === "string"
        ? (taskInput as { sql: string }).sql
        : "";
      const pass = verifyStructuredFinding(taskSql, result);
      return {
        pass,
        verifierId: PAGINATION_VERIFIER_ID,
        observedEffect: pass ? "structured-finding-valid" : "structured-finding-invalid",
      };
    },
  };

  try {
    const outcome = await execute({
      selectedSkill: {
        skillId: procedure.parentSkillId,
        skillRevision: procedure.parentSkillRevision,
      },
      procedure,
      environment: {
        executionContext: CANARY_EXECUTION_CONTEXT, // shadow_replay 硬编码
        currentSkillRevision,
        currentDependencyFingerprint,
        preconditions: [
          { predicateId: "bounded-sql-input", result: sqlTypeOk },
          { predicateId: "source-bindings-current", result: true },
        ],
        requestedEffects: [], // pilot effectless
        authorizationRequired: false,
      },
      taskInput: { sql },
      guardObservations,
      services,
    });
    const details = buildDetails(outcome, procedure, executedSteps);
    return { content: [{ type: "text", text: contentOf(details) }], details };
  } finally {
    store.clear(toolCallId);
  }
}

/** 顺序敏感精确比较（claims 为 executor 按声明顺序复制的 exact declarations）。 */
function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// ---------------------------------------------------------------------------
// 严格解码（observer/审计侧；fail-closed）
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_RE =
  /(^|_)(sql|path|locator|content|details|output|raw|secret|token|tenant|task)(_|$)/i;

const TOP_KEYS = [
  "schema_version",
  "tool",
  "outcome",
  "failure",
  "skill_id",
  "skill_revision",
  "source_hash",
  "procedure_id",
  "dependency_fingerprint",
  "authorization_results",
  "guard_results",
  "verifier_results",
  "step_summaries",
  "finding_class",
  "fallback",
  "decision",
] as const;
const FINGERPRINT_KEYS = ["source_hash", "tool_schema_hash", "permission_policy_hash"] as const;
const AUTH_RESULT_KEYS = ["gate_id", "result"] as const;
const GUARD_KEYS = ["predicate_id", "phase", "result"] as const;
const VERIFIER_KEYS = ["verifier_id", "result", "observed_effect"] as const;
const STEP_KEYS = ["step_id", "actor", "operation_class", "outcome"] as const;
const FALLBACK_KEYS = ["mode", "load_skill_indicated"] as const;
const DECISION_KEYS = ["mode", "reason", "execution_context"] as const;

const OUTCOMES: readonly PilotOutcome[] = [
  "fast_path",
  "fallback",
  "abstain",
  "denied",
  "safety_stop",
  "slow_path",
];
const FINDING_CLASSES = ["uses_offset", "uses_keyset", "no_pagination", "abstain"] as const;
const GUARD_RESULTS = ["pass", "fail", "unknown"] as const;
const STEP_OUTCOMES = ["ok", "failed", "unknown"] as const;

export type DecodeResult =
  | { ok: true; details: PilotToolDetails }
  | { ok: false; reasons: readonly string[] };

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  reasons: string[],
): boolean {
  // 严格白名单（允许可选字段缺失）：每个 key 必须 ∈ 白名单且非敏感；
  // 任何 extra / sensitive key ⇒ fail-closed。
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      reasons.push(`${path}_sensitive_key:${key}`);
      return false;
    }
    if (!(allowed as readonly string[]).includes(key)) {
      reasons.push(`${path}_keys_mismatch`);
      return false;
    }
  }
  return true;
}

function checkString(value: unknown, path: string, reasons: string[]): boolean {
  if (typeof value !== "string" || value === "") {
    reasons.push(`${path}_invalid`);
    return false;
  }
  return true;
}

/** 严格解码：key 精确白名单 + 敏感 key 拒绝 + 类型/枚举校验（fail-closed）。 */
export function decodeExecutionToolDetails(value: unknown): DecodeResult {
  const reasons: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { ok: false, reasons: ["not_object"] };
  }
  const d = value as Record<string, unknown>;
  if (!exactKeys(d, TOP_KEYS, "details", reasons)) return { ok: false, reasons };
  if (d.schema_version !== DETAILS_SCHEMA_VERSION) reasons.push("schema_version_invalid");
  if (d.tool !== PILOT_TOOL_NAME) reasons.push("tool_invalid");
  if (!(OUTCOMES as readonly string[]).includes(d.outcome as string)) reasons.push("outcome_invalid");
  if (d.failure !== undefined && typeof d.failure !== "string") reasons.push("failure_invalid");
  if (d.finding_class !== undefined && !(FINDING_CLASSES as readonly string[]).includes(d.finding_class as string)) {
    reasons.push("finding_class_invalid");
  }
  checkString(d.skill_id, "skill_id", reasons);
  checkString(d.skill_revision, "skill_revision", reasons);
  checkString(d.source_hash, "source_hash", reasons);
  checkString(d.procedure_id, "procedure_id", reasons);

  const fp = d.dependency_fingerprint as Record<string, unknown> | undefined;
  if (typeof fp !== "object" || fp === null) reasons.push("dependency_fingerprint_invalid");
  else if (exactKeys(fp, FINGERPRINT_KEYS, "dependency_fingerprint", reasons)) {
    checkString(fp.source_hash, "dependency_fingerprint.source_hash", reasons);
    if (fp.tool_schema_hash !== undefined && typeof fp.tool_schema_hash !== "string") {
      reasons.push("dependency_fingerprint.tool_schema_hash_invalid");
    }
    if (fp.permission_policy_hash !== undefined && typeof fp.permission_policy_hash !== "string") {
      reasons.push("dependency_fingerprint.permission_policy_hash_invalid");
    }
  }

  const authResults = d.authorization_results;
  if (!Array.isArray(authResults) || authResults.length === 0) reasons.push("authorization_results_invalid");
  else {
    authResults.forEach((item, index) => {
      const r = item as Record<string, unknown> | undefined;
      if (typeof r !== "object" || r === null) {
        reasons.push(`authorization_results[${index}]_invalid`);
        return;
      }
      if (!exactKeys(r, AUTH_RESULT_KEYS, `authorization_results[${index}]`, reasons)) return;
      checkString(r.gate_id, `authorization_results[${index}].gate_id`, reasons);
      if (r.result !== "approved" && r.result !== "denied") {
        reasons.push(`authorization_results[${index}].result_invalid`);
      }
    });
  }

  const guardResults = d.guard_results;
  if (!Array.isArray(guardResults)) reasons.push("guard_results_invalid");
  else {
    guardResults.forEach((item, index) => {
      const r = item as Record<string, unknown> | undefined;
      if (typeof r !== "object" || r === null) {
        reasons.push(`guard_results[${index}]_invalid`);
        return;
      }
      if (!exactKeys(r, GUARD_KEYS, `guard_results[${index}]`, reasons)) return;
      checkString(r.predicate_id, `guard_results[${index}].predicate_id`, reasons);
      checkString(r.phase, `guard_results[${index}].phase`, reasons);
      if (!(GUARD_RESULTS as readonly string[]).includes(r.result as string)) {
        reasons.push(`guard_results[${index}].result_invalid`);
      }
    });
  }

  const verifierResults = d.verifier_results;
  if (!Array.isArray(verifierResults)) reasons.push("verifier_results_invalid");
  else {
    verifierResults.forEach((item, index) => {
      const r = item as Record<string, unknown> | undefined;
      if (typeof r !== "object" || r === null) {
        reasons.push(`verifier_results[${index}]_invalid`);
        return;
      }
      if (!exactKeys(r, VERIFIER_KEYS, `verifier_results[${index}]`, reasons)) return;
      checkString(r.verifier_id, `verifier_results[${index}].verifier_id`, reasons);
      if (!(GUARD_RESULTS as readonly string[]).includes(r.result as string)) {
        reasons.push(`verifier_results[${index}].result_invalid`);
      }
      if (r.observed_effect !== undefined && typeof r.observed_effect !== "string") {
        reasons.push(`verifier_results[${index}].observed_effect_invalid`);
      }
    });
  }

  const steps = d.step_summaries;
  if (!Array.isArray(steps)) reasons.push("step_summaries_invalid");
  else {
    steps.forEach((item, index) => {
      const r = item as Record<string, unknown> | undefined;
      if (typeof r !== "object" || r === null) {
        reasons.push(`step_summaries[${index}]_invalid`);
        return;
      }
      if (!exactKeys(r, STEP_KEYS, `step_summaries[${index}]`, reasons)) return;
      checkString(r.step_id, `step_summaries[${index}].step_id`, reasons);
      checkString(r.actor, `step_summaries[${index}].actor`, reasons);
      checkString(r.operation_class, `step_summaries[${index}].operation_class`, reasons);
      if (!(STEP_OUTCOMES as readonly string[]).includes(r.outcome as string)) {
        reasons.push(`step_summaries[${index}].outcome_invalid`);
      }
    });
  }

  if (d.fallback !== undefined) {
    const f = d.fallback as Record<string, unknown> | undefined;
    if (typeof f !== "object" || f === null) reasons.push("fallback_invalid");
    else if (exactKeys(f, FALLBACK_KEYS, "fallback", reasons)) {
      checkString(f.mode, "fallback.mode", reasons);
      if (f.load_skill_indicated !== true) reasons.push("fallback.load_skill_indicated_invalid");
    }
  }

  const decision = d.decision as Record<string, unknown> | undefined;
  if (typeof decision !== "object" || decision === null) reasons.push("decision_invalid");
  else if (exactKeys(decision, DECISION_KEYS, "decision", reasons)) {
    checkString(decision.mode, "decision.mode", reasons);
    checkString(decision.reason, "decision.reason", reasons);
    checkString(decision.execution_context, "decision.execution_context", reasons);
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, details: value as PilotToolDetails };
}

// ---------------------------------------------------------------------------
// 注册（真实 ExtensionAPI）
// ---------------------------------------------------------------------------

export interface ShadowAdapterOptions {
  store?: ReceiptStore;
  procedure?: CompiledProcedure;
  /** 注入点：当前 revision（未提供回退 procedure 自身值，self-match）。 */
  currentSkillRevision?: string;
  /** 注入点：当前依赖指纹（未提供回退 procedure 自身值，self-match）。 */
  currentDependencyFingerprint?: DependencyFingerprint;
  /** 注入点：runtime guard 观察数组（未提供回退默认 self-match 观察）。 */
  guardObservations?: ReadonlyArray<GuardObservation>;
}

/**
 * 注册 pilot 专用 shadow adapter：tool_call preflight（receipt）+ 工具注册。
 * 默认使用冻结构造 validated procedure（buildCanaryValidatedProcedure）。
 * 注入点（cc HIGH 1）：options.currentSkillRevision/currentDependencyFingerprint/
 * guardObservations 透传给 executePaginationDetect（未提供 ⇒ procedure 自身值回退）。
 */
export function registerSkillCortexPaginationShadow(
  pi: ExtensionAPI,
  options: ShadowAdapterOptions = {},
): void {
  const store = options.store ?? createReceiptStore();
  const procedure = options.procedure ?? buildCanaryValidatedProcedure();

  pi.on("tool_call", async (event) =>
    preflightPaginationTool({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      procedure,
      store,
    }),
  );

  pi.registerTool(
    defineTool({
      name: PILOT_TOOL_NAME,
      label: "Pagination Detect (shadow)",
      description:
        "对单个 SQL 做只读分页静态检测（uses_offset/uses_keyset/no_pagination/abstain）。仅用于 shadow_replay 验证，不执行 SQL。",
      promptSnippet: "Run read-only pagination detection on a single SQL statement",
      parameters: Type.Object({
        sql: Type.String({
          minLength: 1,
          maxLength: PILOT_SQL_MAX_LENGTH,
          description: "单个 SQL 语句（只读静态分析，不执行）",
        }),
        skill_id: Type.String({
          pattern: "^skill:[0-9a-f]{64}$",
          description: "父 Skill id（必须与候选卡一致）",
        }),
        skill_revision: Type.String({
          pattern: "^rev:[0-9a-f]{64}$",
          description: "父 Skill revision（必须与候选卡一致）",
        }),
      }),
      async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
        return executePaginationDetect({
          toolCallId,
          params: {
            sql: params.sql,
            skill_id: params.skill_id,
            skill_revision: params.skill_revision,
          },
          store,
          procedure,
          currentSkillRevision: options.currentSkillRevision,
          currentDependencyFingerprint: options.currentDependencyFingerprint,
          guardObservations: options.guardObservations,
        });
      },
    }),
  );
}
