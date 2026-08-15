/**
 * B4 — 最小 PracticeEvent → draft procedure induction seam（纯函数、确定性、可回放）。
 *
 * 输入：≥2 条满足冻结契约的 PracticeEvent（与 phase3 observer 的真实事件共用）：
 * - provenance="real"；
 * - 同一 parentSkillId / parentSkillRevision / sourceHash（绑定同一父 Skill 版本）；
 * - stepSummaries 含 operationClass="detect-offset-pagination" 且 outcome="ok"；
 * - verifierResults 含 verifierId="phase3-pagination-structured-finding" 且 result="pass"；
 * - attribution="verified_skill_effect"。
 *
 * 对齐与输出：
 * - 逐事件 policy 校验（validatePracticeEvent）+ 契约字段校验，任一失败 fail-closed；
 * - 对齐稳定片段：父绑定（skillId/revision/sourceHash）+ operationClass + verifierId +
 *   去重且稳定排序的 evidenceIds（保留来源证据，不丢失不添加）；
 * - 复用 buildPhase3ProcedureDraft 生成 draft procedure：evidenceIds=事件 ID 列表、
 *   coveredSteps 引用 detect-offset-pagination、createdAt=max(occurredAt)（确定性，
 *   同输入任意顺序 → 同输出；可覆盖）。
 *
 * 约束：不写用户环境、不启动 Phase 4、不修改 detector.ts/draft.ts 现有契约（只复用）。
 * 环境/依赖绑定哈希（selectedReferenceHash、permissionPolicyHash）不在 PracticeEvent 契约内，
 * 由调用方按冻结环境提供；对齐后的 fragment.parentSkillId 可供 promotion pipeline 与
 * 冻结的 supabase-postgres-best-practices 绑定做最终核对。
 */
import type { PracticeEvent } from "../../core/contracts/index.ts";
import { validatePracticeEvent } from "../../practice/policy/index.ts";
import {
  buildPhase3ProcedureDraft,
  type Phase3ProcedureDraft,
} from "../../procedures/phase3/draft.ts";

/** 冻结的 pilot covered operation（与 detector.ts / draft.ts coveredSteps 对齐）。 */
export const INDUCED_OPERATION_CLASS = "detect-offset-pagination";
/** 冻结的独立 verifier（与 verifier.ts / draft.ts postconditions 对齐）。 */
export const INDUCED_VERIFIER_ID = "phase3-pagination-structured-finding";
/** 最小证据事件数（ADR-0008：多次真实使用；审计 B4 冻结 ≥2）。 */
export const MIN_EVIDENCE_EVENTS = 2;

const EVENT_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const SKILL_ID_RE = /^skill:[0-9a-f]{64}$/;
const REVISION_RE = /^rev:[0-9a-f]{64}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u;

export interface InductionOptions {
  /** 环境/依赖事实（PracticeEvent 不携带）：draft sourceBindings.selectedReferenceHash。 */
  selectedReferenceHash: string;
  /** 环境/依赖事实：draft sourceBindings.permissionPolicyHash。 */
  permissionPolicyHash: string;
  /** 可选覆盖 draft.createdAt；缺省 = max(events.occurredAt)（确定性派生）。 */
  createdAt?: string;
  detectorSchemaVersion?: string;
  detectorVersion?: string;
}

/** 对齐出的稳定片段：父绑定 + 同一 covered operation + 同一 verifier + 来源证据 ID。 */
export interface InducedFragment {
  parentSkillId: string;
  parentSkillRevision: string;
  sourceHash: string;
  operationClass: string;
  verifierId: string;
  /** 去重、稳定排序的当次证据事件 ID（来源可追溯，不丢失不添加）。 */
  evidenceIds: readonly string[];
  distinctEventCount: number;
  /** 用于 draft.createdAt 的时间戳（max occurredAt，确定性）。 */
  createdAt: string;
}

export type InductionResult =
  | { ok: true; fragment: InducedFragment; procedure: Phase3ProcedureDraft }
  | { ok: false; reason: string; passed: number };

function fail(reason: string, passed: number): InductionResult {
  return { ok: false, reason, passed };
}

/** max(occurredAt)：按实际时间取最大；同刻按字符串字典序取小（同输入同输出）。 */
function deriveMaxOccurredAt(events: readonly PracticeEvent[]): string {
  let best: { value: number; text: string } | undefined;
  for (const event of events) {
    const value = Date.parse(event.occurredAt);
    if (
      best === undefined ||
      value > best.value ||
      (value === best.value && event.occurredAt < best.text)
    ) {
      best = { value, text: event.occurredAt };
    }
  }
  return best!.text;
}

/**
 * induction seam：≥2 条契约事件 → 对齐稳定片段 → draft procedure。
 * 纯函数、不落盘、不调 LLM、不启动 Phase 4；同输入任意顺序 → 同输出。
 */
export function inducePhase3ProcedureDraft(
  events: readonly PracticeEvent[],
  options: InductionOptions,
): InductionResult {
  // 运行时防呆：非数组/长度不足一律 fail-closed（不用 Array.isArray，避免把 readonly
  // PracticeEvent[] 收窄成 any[] 导致后续回调参数失去上下文类型）。
  if (typeof events?.length !== "number" || events.length < MIN_EVIDENCE_EVENTS) {
    return fail("not_enough_events", 0);
  }

  let passed = 0;
  let parentSkillId: string | undefined;
  let parentSkillRevision: string | undefined;
  let sourceHash: string | undefined;
  const eventIds: string[] = [];

  for (const event of events) {
    const policy = validatePracticeEvent(event);
    if (!policy.ok) return fail("practice_event_policy_invalid", passed);
    if (event.provenance !== "real") return fail("practice_event_not_real", passed);
    if (!SKILL_ID_RE.test(event.parentSkillId)) return fail("parent_skill_id_invalid", passed);
    if (!REVISION_RE.test(event.parentSkillRevision)) {
      return fail("parent_skill_revision_invalid", passed);
    }
    if (!HASH_RE.test(event.sourceHash)) return fail("source_hash_invalid", passed);
    if (!EVENT_ID_RE.test(event.eventId)) return fail("event_id_invalid", passed);
    if (!ISO_TIMESTAMP_RE.test(event.occurredAt) || Number.isNaN(Date.parse(event.occurredAt))) {
      return fail("occurred_at_invalid", passed);
    }

    const coveredStepPassed = event.stepSummaries.some(
      (step) => step.operationClass === INDUCED_OPERATION_CLASS && step.outcome === "ok",
    );
    const verifierPassed = event.verifierResults.some(
      (result) => result.verifierId === INDUCED_VERIFIER_ID && result.result === "pass",
    );
    if (!coveredStepPassed || !verifierPassed || event.attribution !== "verified_skill_effect") {
      return fail("practice_event_covered_step_unverified", passed);
    }

    // 对齐：全部事件必须指向同一父 Skill revision + 同一内容指纹。
    if (parentSkillId === undefined) {
      parentSkillId = event.parentSkillId;
      parentSkillRevision = event.parentSkillRevision;
      sourceHash = event.sourceHash;
    } else if (
      event.parentSkillId !== parentSkillId ||
      event.parentSkillRevision !== parentSkillRevision ||
      event.sourceHash !== sourceHash
    ) {
      return fail("parent_binding_mismatch", passed);
    }

    eventIds.push(event.eventId);
    passed += 1;
  }

  // 去重且稳定排序；distinct 需 ≥ MIN_EVIDENCE_EVENTS（重复事件不能凑数）。
  const uniqueEventIds = [...new Set(eventIds)].sort();
  if (uniqueEventIds.length < MIN_EVIDENCE_EVENTS) {
    return fail("not_enough_distinct_events", passed);
  }

  // 环境/依赖绑定哈希：PracticeEvent 不携带，必须由调用方按冻结环境提供（fail-closed）。
  if (!HASH_RE.test(options.selectedReferenceHash)) {
    return fail("selected_reference_hash_invalid", passed);
  }
  if (!HASH_RE.test(options.permissionPolicyHash)) {
    return fail("permission_policy_hash_invalid", passed);
  }
  if (
    options.createdAt !== undefined &&
    (!ISO_TIMESTAMP_RE.test(options.createdAt) || Number.isNaN(Date.parse(options.createdAt)))
  ) {
    return fail("created_at_invalid", passed);
  }

  const createdAt = options.createdAt ?? deriveMaxOccurredAt(events);
  const fragment: InducedFragment = {
    parentSkillId: parentSkillId!,
    parentSkillRevision: parentSkillRevision!,
    sourceHash: sourceHash!,
    operationClass: INDUCED_OPERATION_CLASS,
    verifierId: INDUCED_VERIFIER_ID,
    evidenceIds: uniqueEventIds,
    distinctEventCount: uniqueEventIds.length,
    createdAt,
  };

  const procedure = buildPhase3ProcedureDraft({
    parentSkillId: fragment.parentSkillId,
    parentSkillRevision: fragment.parentSkillRevision,
    skillMdHash: fragment.sourceHash,
    selectedReferenceHash: options.selectedReferenceHash,
    permissionPolicyHash: options.permissionPolicyHash,
    createdAt: fragment.createdAt,
    evidenceIds: [...fragment.evidenceIds],
    detectorSchemaVersion: options.detectorSchemaVersion,
    detectorVersion: options.detectorVersion,
  });

  return { ok: true, fragment, procedure };
}
