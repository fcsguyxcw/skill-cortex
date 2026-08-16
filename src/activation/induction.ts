/**
 * Phase 6 第一批 —— Activation cue induction（纯函数，project-local，不做 rerank/active）。
 *
 * plan §11 任务 1/2 + 数据合同 §4.3/§4.4：
 * - 只从 attribution=verified_skill_effect 的事件生成 learnedAliases 与 positiveExamples；
 * - 从明确 near-miss/boundary 事件（skill ∈ candidateSkillIds 但未选中；或 boundary
 *   failureClass 且为候选）生成 nearMissExamples——只作降权/解释证据，绝不硬过滤；
 * - environmentCues 从 environmentFingerprint（若可可靠取得）派生 valueClass，缺失省略；
 * - 不保存未经批准的完整用户文本：只落脱敏特征（redactedTaskFeatures）+ evidence 引用；
 * - 作者 metadata（SkillRecord.name/description/declaredAliases）与 learned overlay 分栏：
 *   learned cue 只补充，不覆盖作者原文；learnedAliases 的文本与作者声明 alias 去重；
 * - 每 cue 可追溯（evidenceIds 非空）、按父 revision 绑定（profile.parentSkillRevision）；
 *   cueId 确定性派生（删除级联与 shadow rerank 属后续 batch，本模块只产出 cueId）。
 *
 * 边界：不写 store、不调 LLM、不启动 shadow rerank / active promotion；不改 discovery 索引。
 * evaluation/synthetic 事件禁止混入（fail-closed）；失败类别不得直接复制成 active cue。
 */
import { createHash } from "node:crypto";

import type {
  ActivationProfile,
  PracticeEvent,
  SkillRecord,
} from "../core/contracts/index.ts";
import { validatePracticeEvent } from "../practice/policy/index.ts";

const SKILL_ID_RE = /^skill:[0-9a-f]{64}$/;
const REVISION_RE = /^rev:[0-9a-f]{64}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u;

/** 受控字符集外一律替换为 "_"（与 policy 的受控文本语义一致，防泄漏）。 */
const CONTROLLED_CHARS_RE = /[^\p{L}\p{N} _.:@+\-]/gu;

/** learned alias 文本上限（受控长度，避免无界文本进入 overlay）。 */
export const MAX_CUE_TEXT_LENGTH = 120;

/**
 * 派生特征前缀（observer 生成的受控特征，不含可作 alias 的自然语言语义，提取时排除）。
 */
const DERIVED_FEATURE_PREFIXES = ["prompt-hash:", "candidate-count:", "selected-count:"];

/**
 * boundary failure 类别（skill 相关但条件不满足/环境漂移，可作 near-miss 降权证据）。
 * permission_denied / tool_failure / user_interruption / procedure_error 是 external/执行
 * 失败（不能归因给 Skill，数据合同 §4.4：external failure 不产生 cue），不进入 near-miss。
 */
const BOUNDARY_FAILURE_CLASSES = new Set([
  "precondition_mismatch",
  "runtime_guard_failure",
  "postcondition_failure",
  "environment_drift",
]);

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 受控文本规范化（替换非法字符、trim、限长；空结果返回 ""）。 */
function sanitizeText(value: string, maxLength = MAX_CUE_TEXT_LENGTH): string {
  return value.replace(CONTROLLED_CHARS_RE, "_").trim().slice(0, maxLength);
}

/** 确定性 cueId（parentSkillId + kind + 内容签名）。 */
function cueIdOf(parentSkillId: string, kind: string, signature: string): string {
  return `cue:${sha256Hex(`${parentSkillId}\u0000${kind}\u0000${signature}`).slice(0, 24)}`;
}

/** profileId（确定性：父绑定派生）。 */
function profileIdOf(parentSkillId: string, parentSkillRevision: string): string {
  return `profile:${sha256Hex(`${parentSkillId}\u0000${parentSkillRevision}`).slice(0, 24)}`;
}

/** max(occurredAt)：同刻按字典序小（确定性）。 */
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

/** 去重 + 稳定排序。 */
function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** 从脱敏特征提取候选 alias 文本：排除派生特征与纯 hash，受控规范化。 */
function extractAliasCandidates(features: readonly string[]): string[] {
  const candidates: string[] = [];
  for (const feature of features) {
    if (DERIVED_FEATURE_PREFIXES.some((prefix) => feature.startsWith(prefix))) continue;
    if (HASH_RE.test(feature)) continue;
    const normalized = sanitizeText(feature);
    if (normalized.length === 0) continue;
    candidates.push(normalized);
  }
  return uniqueSorted(candidates);
}

/** 与作者声明 alias/name 去重（大小写不敏感；learned 不覆盖作者原文）。 */
function isAuthorOverlap(text: string, parentSkill: SkillRecord): boolean {
  const lowered = text.toLowerCase();
  if (lowered === parentSkill.name.toLowerCase()) return true;
  if (parentSkill.declaredAliases.some((alias) => alias.toLowerCase() === lowered)) return true;
  return false;
}

/** 事件是否可归因到该 skill（同一父绑定）。 */
function isSameParent(event: PracticeEvent, parentSkill: SkillRecord): boolean {
  return (
    event.parentSkillId === parentSkill.skillId &&
    event.parentSkillRevision === parentSkill.skillRevision
  );
}

/** near-miss 判定：skill 被考虑但未选中；或 boundary failure 且为候选。 */
function isNearMiss(event: PracticeEvent, parentSkillId: string): boolean {
  const isCandidate = event.candidateSkillIds.includes(parentSkillId);
  if (!isCandidate) return false;
  if (!event.selectedSkillIds.includes(parentSkillId)) return true; // 强候选未选中
  if (event.failureClass !== undefined && BOUNDARY_FAILURE_CLASSES.has(event.failureClass)) {
    return true; // 选中但条件不满足/环境漂移（boundary）
  }
  return false;
}

export interface ActivationInductionInput {
  /** 同一父 Skill 版本（parentSkillId/revision/sourceHash 一致）的真实 PracticeEvent 集。 */
  events: readonly PracticeEvent[];
  /** 父 SkillRecord（作者声明的 name/description/declaredAliases，分栏基准）。 */
  parentSkill: SkillRecord;
  /** 可选覆盖 profile createdAt；缺省 = max(occurredAt)。 */
  createdAt?: string;
}

export interface ActivationInductionSummary {
  /** attribution=verified_skill_effect 且选中成功的事件数。 */
  verifiedCount: number;
  /** near-miss/boundary 事件数（降权证据）。 */
  nearMissCount: number;
  /** 被拒绝/跳过的无关事件数（未选中且非 boundary，或 external failure）。 */
  ignoredCount: number;
  learnedAliasCount: number;
  positiveExampleCount: number;
  nearMissExampleCount: number;
  environmentCueCount: number;
}

export type ActivationInductionResult =
  | { ok: true; profile: ActivationProfile; summary: ActivationInductionSummary }
  | { ok: false; reason: string; passed: number };

function fail(reason: string, passed: number): ActivationInductionResult {
  return { ok: false, reason, passed };
}

/**
 * 纯函数：PracticeEvent 集 + 父 SkillRecord → draft ActivationProfile。
 * 确定性可回放：同输入任意顺序 → 同输出。不落盘、不调 LLM。
 */
export function induceActivationProfile(
  input: ActivationInductionInput,
): ActivationInductionResult {
  const { events, parentSkill } = input;
  if (typeof events?.length !== "number" || events.length === 0) {
    return fail("no_events", 0);
  }
  if (!SKILL_ID_RE.test(parentSkill.skillId) || !REVISION_RE.test(parentSkill.skillRevision)) {
    return fail("parent_skill_identity_invalid", 0);
  }
  if (
    input.createdAt !== undefined &&
    (!ISO_TIMESTAMP_RE.test(input.createdAt) || Number.isNaN(Date.parse(input.createdAt)))
  ) {
    return fail("created_at_invalid", 0);
  }

  let passed = 0;
  let sourceHash: string | undefined;
  const verified: PracticeEvent[] = [];
  const nearMisses: PracticeEvent[] = [];

  for (const event of events) {
    const policy = validatePracticeEvent(event);
    if (!policy.ok) return fail("practice_event_policy_invalid", passed);
    if (event.provenance !== "real") {
      return fail("practice_event_not_real", passed); // evaluation/synthetic 禁止混入
    }
    if (!isSameParent(event, parentSkill)) {
      return fail("parent_binding_mismatch", passed); // 不同父 revision 证据不得混入
    }
    if (sourceHash === undefined) {
      sourceHash = event.sourceHash;
    } else if (event.sourceHash !== sourceHash) {
      return fail("source_hash_mismatch", passed);
    }

    if (event.attribution === "verified_skill_effect") {
      verified.push(event);
      passed += 1;
      continue;
    }
    if (isNearMiss(event, parentSkill.skillId)) {
      nearMisses.push(event);
      passed += 1;
      continue;
    }
    // 无关事件：未选中且非 boundary / external failure / unknown 归因 ⇒ 跳过不产 cue。
    passed += 1;
  }

  // 至少一条可归因事件（verified 或 near-miss）才生成 profile；否则 fail-closed。
  if (verified.length === 0 && nearMisses.length === 0) {
    return fail("no_eligible_events", passed);
  }

  // -------------------------------------------------------------------------
  // learnedAliases：跨 verified 事件按文本聚合（作者 alias/name 去重）。
  // -------------------------------------------------------------------------
  const aliasTextToEvents = new Map<string, string[]>();
  for (const event of verified) {
    for (const candidate of extractAliasCandidates(event.redactedTaskFeatures)) {
      if (isAuthorOverlap(candidate, parentSkill)) continue; // 不覆盖作者原文
      aliasTextToEvents.set(candidate, [...(aliasTextToEvents.get(candidate) ?? []), event.eventId]);
    }
  }
  const learnedAliases: ActivationProfile["learnedAliases"] = [];
  for (const [text, eventIds] of [...aliasTextToEvents.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    learnedAliases.push({
      cueId: cueIdOf(parentSkill.skillId, "alias", text),
      text,
      evidenceIds: uniqueSorted(eventIds),
    });
  }

  // -------------------------------------------------------------------------
  // positiveExamples：每个 verified 事件一条（features = 当次脱敏特征，可追溯）。
  // -------------------------------------------------------------------------
  const positiveExamples: ActivationProfile["positiveExamples"] = [];
  for (const event of [...verified].sort((a, b) => (a.eventId < b.eventId ? -1 : 1))) {
    positiveExamples.push({
      cueId: cueIdOf(parentSkill.skillId, "positive", event.eventId),
      features: [...event.redactedTaskFeatures],
      evidenceIds: [event.eventId],
    });
  }

  // -------------------------------------------------------------------------
  // nearMissExamples：每个 near-miss/boundary 事件一条（只作降权/解释，绝不硬过滤）。
  // -------------------------------------------------------------------------
  const nearMissExamples: ActivationProfile["nearMissExamples"] = [];
  for (const event of [...nearMisses].sort((a, b) => (a.eventId < b.eventId ? -1 : 1))) {
    nearMissExamples.push({
      cueId: cueIdOf(parentSkill.skillId, "near_miss", event.eventId),
      features: [...event.redactedTaskFeatures],
      evidenceIds: [event.eventId],
    });
  }

  // -------------------------------------------------------------------------
  // environmentCues：从 environmentFingerprint（若可靠取得）派生 valueClass；缺失省略。
  // MED（tech debt，不扩 scope）：environmentFingerprint 是不透明字符串，valueClass 目前
  // 只是受控规范化副本——key/valueClass 的语义分层（如 os/runtime/model 分类）与可靠来源
  // 未冻结；shadow rerank 暂不消费 environmentCues（仅存储供后续环境敏感评估）。
  // -------------------------------------------------------------------------
  const envFingerprintToEvents = new Map<string, string[]>();
  for (const event of [...verified, ...nearMisses]) {
    if (event.environmentFingerprint === undefined) continue;
    const normalized = sanitizeText(event.environmentFingerprint, 200);
    if (normalized.length === 0) continue;
    envFingerprintToEvents.set(
      normalized,
      [...(envFingerprintToEvents.get(normalized) ?? []), event.eventId],
    );
  }
  const environmentCues: ActivationProfile["environmentCues"] = [];
  for (const [fingerprint, eventIds] of [...envFingerprintToEvents.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    environmentCues.push({
      key: "environment",
      valueClass: fingerprint,
      evidenceIds: uniqueSorted(eventIds),
    });
  }

  // -------------------------------------------------------------------------
  // profile 组装（status=draft，父 revision 绑定，确定性时间戳）。
  // -------------------------------------------------------------------------
  const createdAt = input.createdAt ?? deriveMaxOccurredAt(events);
  const profile: ActivationProfile = {
    schemaVersion: 1,
    profileId: profileIdOf(parentSkill.skillId, parentSkill.skillRevision),
    parentSkillId: parentSkill.skillId,
    parentSkillRevision: parentSkill.skillRevision,
    status: "draft",
    learnedAliases,
    positiveExamples,
    nearMissExamples,
    environmentCues,
    createdAt,
    updatedAt: createdAt,
  };

  return {
    ok: true,
    profile,
    summary: {
      verifiedCount: verified.length,
      nearMissCount: nearMisses.length,
      ignoredCount: events.length - verified.length - nearMisses.length,
      learnedAliasCount: learnedAliases.length,
      positiveExampleCount: positiveExamples.length,
      nearMissExampleCount: nearMissExamples.length,
      environmentCueCount: environmentCues.length,
    },
  };
}
