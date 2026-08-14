/**
 * PracticeEvent 写入前的纯函数 policy gate（Phase 2 证据治理）。
 *
 * 以 src/core/contracts/index.ts 的 `PracticeEvent` 为唯一类型合同。运行时输入为
 * `unknown`：对 object/数组/嵌套项/枚举做防崩溃校验，任何 malformed 输入只产出
 * ok=false + 稳定 code（不抛 TypeError、不回显原始值）。不写文件、不调 LLM、不发明
 * 宿主 hook、不生成 Activation cue 或 procedure。
 */
import type { PracticeEvent } from "../../core/contracts/index.ts";

export type FailureClass = NonNullable<PracticeEvent["failureClass"]>;
export type Attribution = PracticeEvent["attribution"];

export interface PolicyIssue {
  code: string;
  message: string;
}

export interface PolicyResult {
  ok: boolean;
  issues: PolicyIssue[];
  attribution: Attribution;
  failureClass: FailureClass;
  firstAttributableFailureStepId?: string;
}

/** classifyFailure 的最小结构化输入（取 event 的对应子字段）。 */
export interface FailureSignals {
  authorizationResults?: PracticeEvent["authorizationResults"];
  guardResults?: PracticeEvent["guardResults"];
  verifierResults?: PracticeEvent["verifierResults"];
  stepSummaries?: PracticeEvent["stepSummaries"];
}

export const MAX_FEATURE_LENGTH = 120;
export const REQUIRED_RETENTION_CLASS = "project_manual";

const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const SAFE_EVENT_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const SHA256_RE = /^(?:sha256:)?[0-9a-fA-F]{64}$/;
const TENANT_SCOPE_RE = /^(?:project|user):[A-Za-z0-9._-]{1,128}$/;
const MAX_ID_ARRAY = 50;
const MAX_STEP_ARRAY = 200;
const MAX_RESULT_ARRAY = 200;
const MAX_FEATURE_ARRAY = 50;

const ENUM = {
  provenance: ["real", "shadow", "evaluation", "synthetic"],
  executionMode: ["skill_md", "compiled_procedure"],
  attribution: ["verified_skill_effect", "mixed", "unknown"],
  failureClass: [
    "precondition_mismatch", "runtime_guard_failure", "procedure_error",
    "tool_failure", "environment_drift", "permission_denied", "user_interruption",
    "postcondition_failure", "unknown",
  ],
  actor: ["agent", "procedure", "tool", "user"],
  outcome: ["ok", "failed", "unknown"],
  authResult: ["approved", "denied", "not_required", "unknown"],
  guardPhase: ["precondition", "runtime", "postcondition"],
  guardResult: ["pass", "fail", "unknown"],
  verifierResult: ["pass", "fail", "unknown"],
};

function isEnumValue(values: readonly string[], value: unknown): value is string {
  return typeof value === "string" && values.includes(value);
}

const EXTERNAL_FAILURE_CLASSES: readonly FailureClass[] = [
  "tool_failure", "environment_drift", "permission_denied", "user_interruption",
];

const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token)\b[^\n]{0,32}[:=]\s*\S+/i,
  /\bBearer\s+\S+/i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bgh[pousr]_[0-9A-Za-z]{20,}\b/,
  /\bgithub_pat_[0-9A-Za-z_]{20,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /\b[0-9a-fA-F]{40,}\b/,
];

const PRIVATE_KEY_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bssh-(?:rsa|ed25519|dss|ecdsa)\b\s+[A-Za-z0-9+/=]+/,
];

const WINDOWS_ABSOLUTE_PATH_RE = /(?:^|\s|\()(?:[A-Za-z]:\\|\\\\)/;
const POSIX_ABSOLUTE_PATH_RE = /(?:^|\s|\()\/(?!\/)[^\s]+/;
const RELATIVE_PATH_RE = /(?:^|\s|\()\.\.?[\\/][^\s]+/;

const RAW_TOOL_OUTPUT_PATTERNS: readonly RegExp[] = [
  /\b(?:stdout|stderr|traceback|stack\s+trace|exception|command\s+not\s+found|exit\s+code|response\s+body)\b/i,
  /(?:^|\s)(?:PS [^>]+>|[$#>]\s+)/,
  /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+/i,
  /\bHTTP\/\d(?:\.\d)?\b/i,
  /(?:^|\s)[[{][^\n]*[}\]](?:$|\s)/,
];

const CONTROLLED_TEXT_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.:@+\-]*$/u;

const MULTI_SENTENCE_RE = /[.!?。！？]\s+\S/;
const TRAILING_PUNCT_RE = /[.!?。！？]$/;
const LONG_CJK_RE = /[一-鿿]{20,}/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isIsoTimestamp(x: unknown): x is string {
  if (typeof x !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(x);
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  return !Number.isNaN(Date.parse(x));
}

function hasSecret(x: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(x));
}

function hasPrivateKey(x: string): boolean {
  return PRIVATE_KEY_PATTERNS.some((re) => re.test(x));
}

function hasAbsolutePath(x: string): boolean {
  return WINDOWS_ABSOLUTE_PATH_RE.test(x) || POSIX_ABSOLUTE_PATH_RE.test(x);
}

function hasRelativePath(x: string): boolean {
  return RELATIVE_PATH_RE.test(x);
}

function hasRawToolOutput(x: string): boolean {
  return RAW_TOOL_OUTPUT_PATTERNS.some((re) => re.test(x));
}

/** feature 级最小化扫描（安全检测优先于句段启发式）。 */
function inspectFeature(feature: string): string | undefined {
  if (feature.trim() === "") return "feature_empty";
  if (feature.includes("\n") || feature.includes("\r")) return "feature_multiline";
  if (hasSecret(feature)) return "feature_secret";
  if (hasPrivateKey(feature)) return "feature_private_key";
  if (hasAbsolutePath(feature)) return "feature_absolute_path";
  if (hasRelativePath(feature)) return "feature_relative_path";
  if (hasRawToolOutput(feature)) return "feature_raw_tool_output";
  if (feature.length > MAX_FEATURE_LENGTH) return "feature_too_long";
  if (MULTI_SENTENCE_RE.test(feature)) return "feature_full_sentence";
  if (TRAILING_PUNCT_RE.test(feature)) return "feature_full_sentence";
  if (feature.trim().split(/\s+/).length > 8) return "feature_full_sentence";
  if (LONG_CJK_RE.test(feature)) return "feature_full_sentence";
  return undefined;
}

/** 可落盘自由文本（observedEffect/environmentFingerprint/operationClass）扫描。 */
function inspectFreeText(value: string, maxLength: number): string | undefined {
  if (value.includes("\n") || value.includes("\r")) return "multiline";
  if (/\p{C}/u.test(value)) return "control_character";
  if (hasSecret(value)) return "secret";
  if (hasPrivateKey(value)) return "private_key";
  if (hasAbsolutePath(value)) return "absolute_path";
  if (hasRelativePath(value)) return "relative_path";
  if (hasRawToolOutput(value)) return "raw_tool_output";
  if (value.length > maxLength) return "too_long";
  if (value.trim() === "") return "empty";
  if (!CONTROLLED_TEXT_RE.test(value)) return "uncontrolled_value";
  return undefined;
}

/** 拒绝换行/空串/超长/疑似完整句段/secret/私钥/绝对路径；错误不回显 feature 内容。 */
export function scanRedactedTaskFeatures(features: unknown): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  if (!Array.isArray(features)) {
    return [{ code: "redacted_task_features_invalid", message: "redactedTaskFeatures must be a string array" }];
  }
  if (features.length > MAX_FEATURE_ARRAY) {
    issues.push({ code: "redacted_task_features_too_many", message: "redactedTaskFeatures exceeds the bounded array size" });
  }
  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    if (typeof feature !== "string") {
      issues.push({ code: "feature_invalid", message: `redactedTaskFeatures[${index}] must be a string` });
      continue;
    }
    const code = inspectFeature(feature);
    if (code !== undefined) {
      issues.push({ code, message: `redactedTaskFeatures[${index}] rejected: ${code}` });
    }
  }
  return issues;
}

function attributionRule(
  verifierResults: PracticeEvent["verifierResults"],
  guardResults: PracticeEvent["guardResults"],
  stepSummaries: PracticeEvent["stepSummaries"],
): Attribution {
  if (verifierResults.length === 0) return "unknown";
  const hasPass = verifierResults.some((v) => v.result === "pass");
  const hasBad = verifierResults.some((v) => v.result === "fail" || v.result === "unknown");
  const postconditionBad = guardResults.some(
    (g) => g.phase === "postcondition" && g.result !== "pass",
  );
  const stepBad = stepSummaries.some((s) => s.outcome !== "ok");
  if (hasPass && !hasBad && !postconditionBad && !stepBad) return "verified_skill_effect";
  return "mixed";
}

/** verified_skill_effect 门槛（供单测直接调用；gate 内部走同一条 attributionRule）。 */
export function resolveAttribution(event: unknown): Attribution {
  if (!isRecord(event)) return "unknown";
  const verifiers = narrowVerifiers(event.verifierResults);
  const guards = narrowGuards(event.guardResults);
  const steps = narrowSteps(event.stepSummaries);
  if (verifiers === undefined || guards === undefined || steps === undefined) return "unknown";
  return attributionRule(verifiers, guards, steps);
}

const ENVIRONMENT_CLASS_RE = /(?:environ|network|timeout|dns|connect|drift|unavailable|offline|latency)/i;
const PERMISSION_CLASS_RE = /(?:permission|denied|auth|forbidden|unauthor)/i;
const USER_INTERRUPT_CLASS_RE = /(?:user|cancel|interrupt|abort)/i;
const TOOL_CLASS_RE = /(?:tool|command|exec|shell|process)/i;

function classifyByOperationClass(operationClass: string): FailureClass | undefined {
  if (ENVIRONMENT_CLASS_RE.test(operationClass)) return "environment_drift";
  if (PERMISSION_CLASS_RE.test(operationClass)) return "permission_denied";
  if (USER_INTERRUPT_CLASS_RE.test(operationClass)) return "user_interruption";
  if (TOOL_CLASS_RE.test(operationClass)) return "tool_failure";
  return undefined;
}

function classifyFailedStep(step: PracticeEvent["stepSummaries"][number]): FailureClass {
  const byClass = classifyByOperationClass(step.operationClass);
  if (byClass !== undefined) return byClass;
  switch (step.actor) {
    case "user":
      return "user_interruption";
    case "tool":
      return "tool_failure";
    case "procedure":
      return "procedure_error";
    default:
      return "unknown";
  }
}

/** 确定性失败分类（证据不足为 unknown，不猜首失败点）。 */
export function classifyFailure(signals: unknown): FailureClass {
  if (!isRecord(signals)) return "unknown";
  const authorizationResults = narrowAuths(signals.authorizationResults) ?? [];
  const guardResults = narrowGuards(signals.guardResults) ?? [];
  const verifierResults = narrowVerifiers(signals.verifierResults) ?? [];
  const stepSummaries = narrowSteps(signals.stepSummaries) ?? [];

  if (authorizationResults.some((a) => a.result === "denied")) return "permission_denied";
  if (guardResults.some((g) => g.phase === "precondition" && g.result === "fail")) return "precondition_mismatch";
  if (guardResults.some((g) => g.phase === "runtime" && g.result === "fail")) return "runtime_guard_failure";
  if (guardResults.some((g) => g.phase === "postcondition" && g.result === "fail")) return "postcondition_failure";
  if (verifierResults.some((v) => v.result === "fail")) return "postcondition_failure";

  for (const step of stepSummaries) {
    if (step.outcome !== "failed") continue;
    const cls = classifyFailedStep(step);
    if (cls !== "unknown") return cls;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// 防崩溃窄化（把 unknown 窄化为已校验的 typed 数组，失败返回 undefined）
// ---------------------------------------------------------------------------

function narrowSteps(value: unknown): PracticeEvent["stepSummaries"] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_STEP_ARRAY) return undefined;
  const out: PracticeEvent["stepSummaries"] = [];
  for (const s of value) {
    if (!isRecord(s) || typeof s.stepId !== "string" || typeof s.operationClass !== "string") return undefined;
    if (!SAFE_ID_RE.test(s.stepId) || !isEnumValue(ENUM.actor, s.actor) || !isEnumValue(ENUM.outcome, s.outcome)) return undefined;
    out.push({
      stepId: s.stepId,
      actor: s.actor as PracticeEvent["stepSummaries"][number]["actor"],
      operationClass: s.operationClass,
      outcome: s.outcome as PracticeEvent["stepSummaries"][number]["outcome"],
    });
  }
  return out;
}

function narrowAuths(value: unknown): PracticeEvent["authorizationResults"] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_RESULT_ARRAY) return undefined;
  const out: PracticeEvent["authorizationResults"] = [];
  for (const a of value) {
    if (!isRecord(a) || typeof a.gateId !== "string" || !SAFE_ID_RE.test(a.gateId) || !isEnumValue(ENUM.authResult, a.result)) return undefined;
    out.push({ gateId: a.gateId, result: a.result as PracticeEvent["authorizationResults"][number]["result"] });
  }
  return out;
}

function narrowGuards(value: unknown): PracticeEvent["guardResults"] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_RESULT_ARRAY) return undefined;
  const out: PracticeEvent["guardResults"] = [];
  for (const g of value) {
    if (!isRecord(g) || typeof g.predicateId !== "string" || !SAFE_ID_RE.test(g.predicateId)) return undefined;
    if (!isEnumValue(ENUM.guardPhase, g.phase) || !isEnumValue(ENUM.guardResult, g.result)) return undefined;
    out.push({
      predicateId: g.predicateId,
      phase: g.phase as PracticeEvent["guardResults"][number]["phase"],
      result: g.result as PracticeEvent["guardResults"][number]["result"],
    });
  }
  return out;
}

function narrowVerifiers(value: unknown): PracticeEvent["verifierResults"] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_RESULT_ARRAY) return undefined;
  const out: PracticeEvent["verifierResults"] = [];
  for (const v of value) {
    if (!isRecord(v) || typeof v.verifierId !== "string" || !SAFE_ID_RE.test(v.verifierId) || !isEnumValue(ENUM.verifierResult, v.result)) return undefined;
    if (v.observedEffect !== undefined && typeof v.observedEffect !== "string") return undefined;
    const item: PracticeEvent["verifierResults"][number] = {
      verifierId: v.verifierId,
      result: v.result as PracticeEvent["verifierResults"][number]["result"],
    };
    if (typeof v.observedEffect === "string") item.observedEffect = v.observedEffect;
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主 gate
// ---------------------------------------------------------------------------

export function isProductionEligible(event: unknown): boolean {
  return isRecord(event) && event.provenance === "real" && validatePracticeEvent(event).ok;
}

export function validatePracticeEvent(event: unknown): PolicyResult {
  const issues: PolicyIssue[] = [];

  if (!isRecord(event)) {
    return {
      ok: false,
      issues: [{ code: "event_not_object", message: "event must be an object" }],
      attribution: "unknown",
      failureClass: "unknown",
    };
  }

  if (event.schemaVersion !== 1) issues.push({ code: "schema_version", message: "only schemaVersion=1 is allowed" });
  if (event.sensitivity !== "none") issues.push({ code: "sensitivity", message: "only sensitivity=none is allowed" });
  if (event.retentionClass !== REQUIRED_RETENTION_CLASS) {
    issues.push({ code: "retention_class", message: "only retentionClass=project_manual is allowed" });
  }

  if (!ENUM.provenance.includes(event.provenance as string)) {
    issues.push({ code: "provenance_invalid", message: "provenance enum invalid" });
  }
  if (!ENUM.executionMode.includes(event.executionMode as string)) {
    issues.push({ code: "execution_mode_invalid", message: "executionMode enum invalid" });
  }
  if (!ENUM.attribution.includes(event.attribution as string)) {
    issues.push({ code: "attribution_invalid", message: "attribution enum invalid" });
  }
  if (event.failureClass !== undefined && !ENUM.failureClass.includes(event.failureClass as string)) {
    issues.push({ code: "failure_class_invalid", message: "failureClass enum invalid" });
  }

  if (!isIsoTimestamp(event.occurredAt)) {
    issues.push({ code: "occurred_at_invalid", message: "occurredAt must be an ISO timestamp" });
  }
  if (typeof event.tenantScope !== "string" || !TENANT_SCOPE_RE.test(event.tenantScope)) {
    issues.push({ code: "tenant_scope_invalid", message: "tenantScope must be project:/user: bounded identifier" });
  }
  if (typeof event.eventId !== "string" || !SAFE_EVENT_ID_RE.test(event.eventId)) {
    issues.push({ code: "event_id_invalid", message: "eventId must be a bounded safe ID" });
  }
  if (typeof event.parentSkillId !== "string" || !SAFE_ID_RE.test(event.parentSkillId)) {
    issues.push({ code: "parent_skill_id_invalid", message: "parentSkillId must be a bounded safe ID" });
  }
  if (typeof event.parentSkillRevision !== "string" || !SAFE_ID_RE.test(event.parentSkillRevision)) {
    issues.push({ code: "parent_skill_revision_invalid", message: "parentSkillRevision must be a bounded safe ID" });
  }
  if (typeof event.sourceHash !== "string" || !SHA256_RE.test(event.sourceHash)) {
    issues.push({ code: "source_hash_invalid", message: "sourceHash must be a full sha256" });
  }
  if (event.routeDecisionId !== undefined && (typeof event.routeDecisionId !== "string" || !SAFE_ID_RE.test(event.routeDecisionId))) {
    issues.push({ code: "route_decision_id_invalid", message: "routeDecisionId must be a bounded safe ID" });
  }

  // procedureId 与 executionMode 一致性
  if (ENUM.executionMode.includes(event.executionMode as string)) {
    if (event.executionMode === "compiled_procedure") {
      if (typeof event.procedureId !== "string" || !SAFE_ID_RE.test(event.procedureId)) {
        issues.push({ code: "procedure_id_required", message: "compiled_procedure requires a bounded safe procedureId" });
      }
    } else if (event.procedureId !== undefined) {
      issues.push({ code: "procedure_id_mismatch", message: "skill_md must not carry procedureId" });
    }
  }

  // candidate/selected：有界安全 ID 数组
  const candidateIds = event.candidateSkillIds;
  if (!Array.isArray(candidateIds) || candidateIds.length > MAX_ID_ARRAY || !candidateIds.every((x) => typeof x === "string" && SAFE_ID_RE.test(x))) {
    issues.push({ code: "candidate_skill_ids_invalid", message: "candidateSkillIds must be a bounded safe-ID array" });
  } else if (new Set(candidateIds).size !== candidateIds.length) {
    issues.push({ code: "candidate_skill_ids_duplicate", message: "candidateSkillIds must not contain duplicates" });
  }
  const selectedIds = event.selectedSkillIds;
  if (!Array.isArray(selectedIds) || selectedIds.length > MAX_ID_ARRAY || !selectedIds.every((x) => typeof x === "string" && SAFE_ID_RE.test(x))) {
    issues.push({ code: "selected_skill_ids_invalid", message: "selectedSkillIds must be a bounded safe-ID array" });
  } else if (new Set(selectedIds).size !== selectedIds.length) {
    issues.push({ code: "selected_skill_ids_duplicate", message: "selectedSkillIds must not contain duplicates" });
  }

  // redactedTaskFeatures
  if (!Array.isArray(event.redactedTaskFeatures) || !event.redactedTaskFeatures.every((x) => typeof x === "string")) {
    issues.push({ code: "redacted_task_features_invalid", message: "redactedTaskFeatures must be a string array" });
  } else {
    issues.push(...scanRedactedTaskFeatures(event.redactedTaskFeatures));
  }

  // stepSummaries
  if (!Array.isArray(event.stepSummaries) || event.stepSummaries.length > MAX_STEP_ARRAY) {
    issues.push({ code: "step_summaries_invalid", message: "stepSummaries must be a bounded array" });
  } else {
    event.stepSummaries.forEach((s, i) => {
      if (!isRecord(s)) { issues.push({ code: "step_malformed", message: `stepSummaries[${i}] must be an object` }); return; }
      if (typeof s.stepId !== "string" || !SAFE_ID_RE.test(s.stepId)) issues.push({ code: "step_id_invalid", message: `stepSummaries[${i}].stepId invalid` });
      if (!ENUM.actor.includes(s.actor as string)) issues.push({ code: "step_actor_invalid", message: `stepSummaries[${i}].actor invalid` });
      if (!ENUM.outcome.includes(s.outcome as string)) issues.push({ code: "step_outcome_invalid", message: `stepSummaries[${i}].outcome invalid` });
      if (typeof s.operationClass !== "string") {
        issues.push({ code: "step_operation_class_invalid", message: `stepSummaries[${i}].operationClass must be a string` });
      } else {
        const t = inspectFreeText(s.operationClass, 128);
        if (t !== undefined) issues.push({ code: `step_operation_class_${t}`, message: `stepSummaries[${i}].operationClass ${t}` });
      }
    });
    const stepIds = event.stepSummaries
      .filter(isRecord)
      .map((step) => step.stepId)
      .filter((stepId): stepId is string => typeof stepId === "string");
    if (new Set(stepIds).size !== stepIds.length) {
      issues.push({ code: "step_id_duplicate", message: "stepSummaries.stepId must be unique" });
    }
  }

  // authorizationResults
  if (!Array.isArray(event.authorizationResults) || event.authorizationResults.length > MAX_RESULT_ARRAY) {
    issues.push({ code: "authorization_results_invalid", message: "authorizationResults must be an array" });
  } else {
    event.authorizationResults.forEach((a, i) => {
      if (!isRecord(a)) { issues.push({ code: "gate_malformed", message: `authorizationResults[${i}] must be an object` }); return; }
      if (typeof a.gateId !== "string" || !SAFE_ID_RE.test(a.gateId)) issues.push({ code: "gate_id_invalid", message: `authorizationResults[${i}].gateId invalid` });
      if (!ENUM.authResult.includes(a.result as string)) issues.push({ code: "gate_result_invalid", message: `authorizationResults[${i}].result invalid` });
    });
  }

  // guardResults
  if (!Array.isArray(event.guardResults) || event.guardResults.length > MAX_RESULT_ARRAY) {
    issues.push({ code: "guard_results_invalid", message: "guardResults must be an array" });
  } else {
    event.guardResults.forEach((g, i) => {
      if (!isRecord(g)) { issues.push({ code: "guard_malformed", message: `guardResults[${i}] must be an object` }); return; }
      if (typeof g.predicateId !== "string" || !SAFE_ID_RE.test(g.predicateId)) issues.push({ code: "guard_id_invalid", message: `guardResults[${i}].predicateId invalid` });
      if (!ENUM.guardPhase.includes(g.phase as string)) issues.push({ code: "guard_phase_invalid", message: `guardResults[${i}].phase invalid` });
      if (!ENUM.guardResult.includes(g.result as string)) issues.push({ code: "guard_result_invalid", message: `guardResults[${i}].result invalid` });
    });
  }

  // verifierResults（含 observedEffect 自由文本）
  if (!Array.isArray(event.verifierResults) || event.verifierResults.length > MAX_RESULT_ARRAY) {
    issues.push({ code: "verifier_results_invalid", message: "verifierResults must be an array" });
  } else {
    event.verifierResults.forEach((v, i) => {
      if (!isRecord(v)) { issues.push({ code: "verifier_malformed", message: `verifierResults[${i}] must be an object` }); return; }
      if (typeof v.verifierId !== "string" || !SAFE_ID_RE.test(v.verifierId)) issues.push({ code: "verifier_id_invalid", message: `verifierResults[${i}].verifierId invalid` });
      if (!ENUM.verifierResult.includes(v.result as string)) issues.push({ code: "verifier_result_invalid", message: `verifierResults[${i}].result invalid` });
      if (v.observedEffect !== undefined) {
        if (typeof v.observedEffect !== "string") {
          issues.push({ code: "observed_effect_invalid", message: `verifierResults[${i}].observedEffect must be a string` });
        } else {
          const t = inspectFreeText(v.observedEffect, 200);
          if (t !== undefined) issues.push({ code: `observed_effect_${t}`, message: `verifierResults[${i}].observedEffect ${t}` });
        }
      }
    });
  }

  // dependencyFingerprint（可选）
  if (event.dependencyFingerprint !== undefined) {
    if (!isRecord(event.dependencyFingerprint)) {
      issues.push({ code: "dependency_fingerprint_invalid", message: "dependencyFingerprint must be an object" });
    } else {
      const df = event.dependencyFingerprint;
      if (typeof df.sourceHash !== "string" || !SHA256_RE.test(df.sourceHash)) {
        issues.push({ code: "dependency_source_hash_invalid", message: "dependencyFingerprint.sourceHash must be a full sha256" });
      }
      for (const field of ["toolSchemaHash", "permissionPolicyHash", "promptHash"] as const) {
        const val = df[field];
        if (val !== undefined && (typeof val !== "string" || !SHA256_RE.test(val))) {
          issues.push({ code: `dependency_${field}_invalid`, message: `dependencyFingerprint.${field} must be a full sha256` });
        }
      }
      for (const field of ["environmentClass", "modelId"] as const) {
        const val = df[field];
        if (val !== undefined && (typeof val !== "string" || !SAFE_ID_RE.test(val))) {
          issues.push({ code: `dependency_${field}_invalid`, message: `dependencyFingerprint.${field} must be a bounded safe identifier` });
        }
      }
    }
  }

  // environmentFingerprint（可选自由文本）
  if (event.environmentFingerprint !== undefined) {
    if (typeof event.environmentFingerprint !== "string") {
      issues.push({ code: "environment_fingerprint_invalid", message: "environmentFingerprint must be a string" });
    } else {
      const t = inspectFreeText(event.environmentFingerprint, 200);
      if (t !== undefined) issues.push({ code: `environment_fingerprint_${t}`, message: `environmentFingerprint ${t}` });
    }
  }

  // 归因 / 失败分类 / 首失败点（对窄化后的数据计算；畸形归一为 unknown）
  const verifiers = narrowVerifiers(event.verifierResults);
  const guards = narrowGuards(event.guardResults);
  const steps = narrowSteps(event.stepSummaries);
  const auths = narrowAuths(event.authorizationResults);

  const attribution =
    verifiers !== undefined && guards !== undefined && steps !== undefined
      ? attributionRule(verifiers, guards, steps)
      : "unknown";

  const failureClass =
    verifiers !== undefined && guards !== undefined && steps !== undefined && auths !== undefined
      ? classifyFailure({ authorizationResults: auths, guardResults: guards, verifierResults: verifiers, stepSummaries: steps })
      : "unknown";

  if (event.attribution === "verified_skill_effect" && attribution !== "verified_skill_effect") {
    issues.push({
      code: "unverified_attribution",
      message: "verified_skill_effect requires a clean verifier pass and no failed/unknown step",
    });
  }
  if (event.attribution === "verified_skill_effect" && EXTERNAL_FAILURE_CLASSES.includes(failureClass)) {
    issues.push({ code: "external_failure_verified", message: "external failure cannot be verified_skill_effect" });
  }

  if (event.firstAttributableFailureStepId !== undefined) {
    const id = event.firstAttributableFailureStepId;
    const refOk =
      steps !== undefined && steps.some((s) => s.stepId === id && s.outcome === "failed");
    if (typeof id !== "string" || !refOk) {
      issues.push({ code: "first_attributable_step_invalid", message: "firstAttributableFailureStepId must reference a failed step" });
    }
  }

  const firstAttributableFailureStepId =
    steps !== undefined && !EXTERNAL_FAILURE_CLASSES.includes(failureClass)
      ? steps.find((s) => s.outcome === "failed")?.stepId
      : undefined;

  return {
    ok: issues.length === 0,
    issues,
    attribution,
    failureClass,
    firstAttributableFailureStepId,
  };
}
