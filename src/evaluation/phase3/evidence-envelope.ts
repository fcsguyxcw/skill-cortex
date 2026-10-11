/**
 * Phase 3 redacted validation evidence envelope（ADR-0011 §6/§7）。
 *
 * 用途：fresh-clone 一致性复验的脱敏摘要资产——只抽 identity/hash/controlled enum/count/
 * reference；绝不携带 tenant/task/SQL/路径/工具输出/完整事件/details。
 *
 * 边界（ADR-0011 §6/§7）：
 * - `createEvidenceEnvelope` 只接受 `sourceMode="formal_real_store"` 且 `decision=validated`、
 *   `validatedProcedure` 存在的 P3GateResult；`evaluation_fixture` 一律拒绝。
 * - 顶层固定 `kind=phase3_validation_evidence_envelope`、
 *   `replaySource=evaluation/envelope_replay`、`provesRealProvenance=false`、
 *   `promotionEligible=false`：envelope 是摘要不是证据，重放永远不重新证明 real provenance、
 *   永远不进入 promotion 判定。
 * - 纯函数：create / verifyEnvelopeShape / replayEnvelopeConsistency 均无副作用、不落盘、
 *   不 import 或调用 PracticeStore / transition / judgePromotion。
 * - 严格运行时 shape 校验：顶层与嵌套 key 必须精确匹配白名单；extra key / sensitive key
 *   （tenant/task/sql/prompt/path/locator/content/details/output 等）→ fail-closed。
 * - 篡改（任意字段、integrity、shape）→ verify fail 或 replay mismatch。
 */
import { createHash } from "node:crypto";

import type { P3GateResult } from "./p3-gate-runner.ts";

export const ENVELOPE_SCHEMA_VERSION = 1 as const;
export const ENVELOPE_KIND = "phase3_validation_evidence_envelope" as const;
export const ENVELOPE_REPLAY_SOURCE = "evaluation/envelope_replay" as const;
export const ENVELOPE_SOURCE_MODE = "formal_real_store" as const;

/** ADR-0011 §7：来源模式由入口决定，不得由事件内自报字段升级。 */
/** ADR-0011 §5：validation evidence 分类（envelope 只引用枚举，不重新判定）。 */
export type EnvelopeEvidenceClass = "automated" | "static_review" | "owner_attested";

export type EnvelopeMetricValue = number | "N/A";
export type EnvelopeGateStatus = "pass" | "fail";

export interface EvidenceEnvelopeGate {
  gateId: string;
  status: EnvelopeGateStatus;
  evidenceClasses: readonly EnvelopeEvidenceClass[];
}

export interface EvidenceEnvelopeParent {
  skillId: string;
  skillRevision: string;
  sourceHash: string;
  selectedReferenceHash: string;
  procedureRevision: string;
  artifactHash: string;
}

export interface EvidenceEnvelopeOperation {
  /** 冻结 covered operation class（受控枚举，如 detect-offset-pagination）。 */
  class: string;
  /** 冻结独立 verifier id（受控枚举）。 */
  verifierId: string;
}

export interface EvidenceEnvelopeMetrics {
  accuracy: EnvelopeMetricValue;
  offsetRecall: EnvelopeMetricValue;
  offsetFpr: EnvelopeMetricValue;
  expectedAbstainRecall: EnvelopeMetricValue;
  abstainRate: EnvelopeMetricValue;
  unexpectedAbstainRate: EnvelopeMetricValue;
  counts: {
    total: number;
    offsetExpected: number;
    nonOffsetExpected: number;
    abstainExpected: number;
    nonAbstainExpected: number;
    offsetPredicted: number;
    abstainPredicted: number;
    passed: number;
  };
}

export interface EvidenceEnvelopeCostSummary {
  unit: "latency_ms" | "tokens";
  compileAndValidationCost: number;
  meanSlowPathCost: number;
  meanFastPathCost: number;
  meanFallbackCost: number;
  nBreakEven: number;
  sampleSize: number;
}

export interface Phase3ValidationEvidenceEnvelope {
  kind: typeof ENVELOPE_KIND;
  schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  /** 派生自 core 字段的稳定 id（"envelope:" + sha256 前 32 hex）。 */
  envelopeId: string;
  sourceMode: typeof ENVELOPE_SOURCE_MODE;
  replaySource: typeof ENVELOPE_REPLAY_SOURCE;
  /** 固定 false：envelope 不得声称重新证明 real provenance。 */
  provesRealProvenance: false;
  /** 固定 false：envelope 不得进入 production proposal / promotion 判定。 */
  promotionEligible: false;
  parent: EvidenceEnvelopeParent;
  evidenceIds: readonly string[];
  operation: EvidenceEnvelopeOperation;
  metrics: EvidenceEnvelopeMetrics;
  costSummary: EvidenceEnvelopeCostSummary;
  gates: readonly EvidenceEnvelopeGate[];
  integrity: { canonicalBytesHash: string };
}

const SKILL_ID_RE = /^skill:[0-9a-f]{64}$/;
const REVISION_RE = /^rev:[0-9a-f]{64}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const ENVELOPE_ID_RE = /^envelope:[0-9a-f]{32}$/;
const EVENT_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const ABSOLUTE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|\/[^/])/;

/** sensitive key 黑名单：envelope 任何层级不得出现（fail-closed）。 */
const SENSITIVE_KEY_RE =
  /(^|_)(tenant|task|sql|prompt|path|locator|content|details|output|raw|secret|token|session)(_|$)/i;

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

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** canonical core：envelope 去掉 integrity 后的稳定序列化（envelopeId 参与校验）。 */
function canonicalEnvelopeJson(value: unknown): string {
  return stableJson(value);
}

// ---------------------------------------------------------------------------
// create（纯函数，fail-closed）
// ---------------------------------------------------------------------------

export type EnvelopeCreateResult =
  | { ok: true; envelope: Phase3ValidationEvidenceEnvelope }
  | { ok: false; reasons: readonly string[] };

function requireHash(value: unknown, field: string, re: RegExp, reasons: string[]): string | undefined {
  if (typeof value !== "string" || !re.test(value)) {
    reasons.push(`${field}_invalid`);
    return undefined;
  }
  return value;
}

/**
 * 只接受 sourceMode=formal_real_store、decision=validated、validatedProcedure 存在的
 * P3GateResult。只抽取白名单字段（identity/hash/controlled enum/count/reference）；
 * 任何缺失/形状错 ⇒ fail-closed。
 */
export function createEvidenceEnvelope(
  result: P3GateResult,
): EnvelopeCreateResult {
  const reasons: string[] = [];
  if (result.sourceMode !== ENVELOPE_SOURCE_MODE) {
    // evaluation_fixture / 其它来源一律拒绝（ADR-0011 §7：来源由入口决定）。
    reasons.push("source_mode_not_formal_real_store");
  }
  if (result.decision !== "validated") reasons.push("decision_not_validated");
  const procedure = result.validatedProcedure;
  if (procedure === undefined) reasons.push("validated_procedure_missing");
  if (result.gates === undefined || result.gates.length === 0) reasons.push("gates_missing");
  const metrics = result.heldoutMetrics;
  if (metrics === undefined) reasons.push("heldout_metrics_missing");
  const cost = result.realCostEvidence;
  if (cost === undefined) reasons.push("real_cost_evidence_missing");

  // 白名单抽取 + 形状校验（fail-closed）。
  const parent: EvidenceEnvelopeParent = {
    skillId: requireHash(procedure?.parentSkillId, "parent.skillId", SKILL_ID_RE, reasons) ?? "",
    skillRevision: requireHash(
      procedure?.parentSkillRevision,
      "parent.skillRevision",
      REVISION_RE,
      reasons,
    ) ?? "",
    sourceHash: requireHash(
      procedure?.sourceBindings?.skillMdHash,
      "parent.sourceHash",
      SHA256_RE,
      reasons,
    ) ?? "",
    selectedReferenceHash: requireHash(
      procedure?.sourceBindings?.selectedReferenceHash,
      "parent.selectedReferenceHash",
      SHA256_RE,
      reasons,
    ) ?? "",
    procedureRevision: requireHash(
      procedure?.procedureRevision,
      "parent.procedureRevision",
      REVISION_RE,
      reasons,
    ) ?? "",
    artifactHash: requireHash(procedure?.artifactHash, "parent.artifactHash", SHA256_RE, reasons) ?? "",
  };
  const evidenceIds = Array.isArray(procedure?.evidenceIds)
    ? procedure!.evidenceIds
    : [];
  if (
    evidenceIds.length === 0 ||
    evidenceIds.some((id) => typeof id !== "string" || !EVENT_ID_RE.test(id))
  ) {
    reasons.push("evidenceIds_invalid");
  }
  const operationClass = procedure?.coveredSteps?.[0]?.stepId;
  const verifierId = procedure?.postconditions?.[0]?.verifierId;
  if (typeof operationClass !== "string" || operationClass === "") reasons.push("operation.class_invalid");
  if (typeof verifierId !== "string" || verifierId === "") reasons.push("operation.verifierId_invalid");

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  const metricsSummary: EvidenceEnvelopeMetrics = {
    accuracy: metrics!.accuracy,
    offsetRecall: metrics!.offsetRecall,
    offsetFpr: metrics!.offsetFpr,
    expectedAbstainRecall: metrics!.expectedAbstainRecall,
    abstainRate: metrics!.abstainRate,
    unexpectedAbstainRate: metrics!.unexpectedAbstainRate,
    counts: { ...metrics!.counts },
  };
  const costSummary: EvidenceEnvelopeCostSummary = {
    unit: cost!.unit,
    compileAndValidationCost: cost!.compileAndValidationCost,
    meanSlowPathCost: cost!.meanSlowPathCost,
    meanFastPathCost: cost!.meanFastPathCost,
    meanFallbackCost: cost!.meanFallbackCost,
    nBreakEven: cost!.nBreakEven,
    sampleSize: cost!.sampleSize,
  };
  const gates: readonly EvidenceEnvelopeGate[] = result.gates!.map((g) => ({
    gateId: g.gateId,
    status: g.status,
    evidenceClasses: [...g.evidenceClasses],
  }));

  const core = {
    kind: ENVELOPE_KIND,
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    sourceMode: ENVELOPE_SOURCE_MODE,
    replaySource: ENVELOPE_REPLAY_SOURCE,
    provesRealProvenance: false,
    promotionEligible: false,
    parent,
    evidenceIds: [...evidenceIds],
    operation: { class: operationClass!, verifierId: verifierId! },
    metrics: metricsSummary,
    costSummary,
    gates,
  } as const;
  const envelopeId = `envelope:${sha256Hex(canonicalEnvelopeJson(core)).slice(0, 32)}`;
  const withId = { ...core, envelopeId };
  const canonicalBytesHash = sha256Hex(canonicalEnvelopeJson(withId));
  const envelope: Phase3ValidationEvidenceEnvelope = {
    ...withId,
    integrity: { canonicalBytesHash },
  };
  return { ok: true, envelope };
}

// ---------------------------------------------------------------------------
// verify shape（严格运行时校验，fail-closed）
// ---------------------------------------------------------------------------

export type EnvelopeShapeResult =
  | { ok: true; envelope: Phase3ValidationEvidenceEnvelope }
  | { ok: false; reasons: readonly string[] };

const TOP_LEVEL_KEYS = [
  "kind",
  "schemaVersion",
  "envelopeId",
  "sourceMode",
  "replaySource",
  "provesRealProvenance",
  "promotionEligible",
  "parent",
  "evidenceIds",
  "operation",
  "metrics",
  "costSummary",
  "gates",
  "integrity",
] as const;
const PARENT_KEYS = [
  "skillId",
  "skillRevision",
  "sourceHash",
  "selectedReferenceHash",
  "procedureRevision",
  "artifactHash",
] as const;
const OPERATION_KEYS = ["class", "verifierId"] as const;
const METRICS_KEYS = [
  "accuracy",
  "offsetRecall",
  "offsetFpr",
  "expectedAbstainRecall",
  "abstainRate",
  "unexpectedAbstainRate",
  "counts",
] as const;
const COUNTS_KEYS = [
  "total",
  "offsetExpected",
  "nonOffsetExpected",
  "abstainExpected",
  "nonAbstainExpected",
  "offsetPredicted",
  "abstainPredicted",
  "passed",
] as const;
const COST_KEYS = [
  "unit",
  "compileAndValidationCost",
  "meanSlowPathCost",
  "meanFastPathCost",
  "meanFallbackCost",
  "nBreakEven",
  "sampleSize",
] as const;
const GATE_KEYS = ["gateId", "status", "evidenceClasses"] as const;
const INTEGRITY_KEYS = ["canonicalBytesHash"] as const;

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  reasons: string[],
): boolean {
  const keys = Object.keys(value);
  // sensitive key 优先判定（fail-closed）：任何层级出现敏感词即拒绝。
  for (const key of keys) {
    if (SENSITIVE_KEY_RE.test(key)) {
      reasons.push(`${path}_sensitive_key:${key}`);
      return false;
    }
  }
  const sorted = [...allowed].sort();
  if (keys.length !== sorted.length || [...keys].sort().some((k, i) => k !== sorted[i])) {
    reasons.push(`${path}_keys_mismatch`);
    return false;
  }
  return true;
}

function checkMetricValue(value: unknown, path: string, reasons: string[]): boolean {
  if (value === "N/A") return true;
  return typeof value === "number" && Number.isFinite(value)
    ? true
    : (reasons.push(`${path}_invalid`), false);
}

function checkNonNegativeNumber(value: unknown, path: string, reasons: string[]): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? true
    : (reasons.push(`${path}_invalid`), false);
}

function checkStringValue(value: unknown, path: string, reasons: string[]): boolean {
  if (typeof value !== "string" || value === "") {
    reasons.push(`${path}_invalid`);
    return false;
  }
  // 值级防泄漏：任何字符串不得是绝对路径形态。
  if (ABSOLUTE_PATH_RE.test(value)) {
    reasons.push(`${path}_absolute_path`);
    return false;
  }
  return true;
}

/** 严格 shape / extra key / sensitive key 校验（fail-closed）。 */
export function verifyEnvelopeShape(value: unknown): EnvelopeShapeResult {
  const reasons: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { ok: false, reasons: ["not_object"] };
  }
  const e = value as Record<string, unknown>;
  if (!exactKeys(e, TOP_LEVEL_KEYS, "envelope", reasons)) return { ok: false, reasons };
  if (e.kind !== ENVELOPE_KIND) reasons.push("kind_invalid");
  if (e.schemaVersion !== ENVELOPE_SCHEMA_VERSION) reasons.push("schema_version_invalid");
  if (typeof e.envelopeId !== "string" || !ENVELOPE_ID_RE.test(e.envelopeId)) {
    reasons.push("envelope_id_invalid");
  }
  if (e.sourceMode !== ENVELOPE_SOURCE_MODE) reasons.push("source_mode_invalid");
  if (e.replaySource !== ENVELOPE_REPLAY_SOURCE) reasons.push("replay_source_invalid");
  if (e.provesRealProvenance !== false) reasons.push("proves_real_provenance_not_false");
  if (e.promotionEligible !== false) reasons.push("promotion_eligible_not_false");

  const parent = e.parent as Record<string, unknown> | undefined;
  if (typeof parent !== "object" || parent === null) reasons.push("parent_invalid");
  else if (exactKeys(parent, PARENT_KEYS, "parent", reasons)) {
    const re = { skillId: SKILL_ID_RE, skillRevision: REVISION_RE, sourceHash: SHA256_RE, selectedReferenceHash: SHA256_RE, procedureRevision: REVISION_RE, artifactHash: SHA256_RE } as const;
    for (const key of PARENT_KEYS) {
      const v = parent[key];
      if (typeof v !== "string" || !re[key].test(v)) reasons.push(`parent.${key}_invalid`);
    }
  }

  const evidenceIds = e.evidenceIds;
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) reasons.push("evidence_ids_invalid");
  else if (evidenceIds.some((id) => typeof id !== "string" || !EVENT_ID_RE.test(id))) {
    reasons.push("evidence_ids_invalid");
  }

  const operation = e.operation as Record<string, unknown> | undefined;
  if (typeof operation !== "object" || operation === null) reasons.push("operation_invalid");
  else if (exactKeys(operation, OPERATION_KEYS, "operation", reasons)) {
    checkStringValue(operation.class, "operation.class", reasons);
    checkStringValue(operation.verifierId, "operation.verifierId", reasons);
  }

  const metrics = e.metrics as Record<string, unknown> | undefined;
  if (typeof metrics !== "object" || metrics === null) reasons.push("metrics_invalid");
  else if (exactKeys(metrics, METRICS_KEYS, "metrics", reasons)) {
    for (const key of METRICS_KEYS) {
      if (key === "counts") continue;
      checkMetricValue(metrics[key], `metrics.${key}`, reasons);
    }
    const counts = metrics.counts as Record<string, unknown> | undefined;
    if (typeof counts !== "object" || counts === null) reasons.push("metrics.counts_invalid");
    else if (exactKeys(counts, COUNTS_KEYS, "metrics.counts", reasons)) {
      for (const key of COUNTS_KEYS) checkNonNegativeNumber(counts[key], `metrics.counts.${key}`, reasons);
    }
  }

  const costSummary = e.costSummary as Record<string, unknown> | undefined;
  if (typeof costSummary !== "object" || costSummary === null) reasons.push("cost_summary_invalid");
  else if (exactKeys(costSummary, COST_KEYS, "costSummary", reasons)) {
    if (costSummary.unit !== "latency_ms" && costSummary.unit !== "tokens") {
      reasons.push("cost_summary.unit_invalid");
    }
    for (const key of COST_KEYS) {
      if (key === "unit") continue;
      checkNonNegativeNumber(costSummary[key], `cost_summary.${key}`, reasons);
    }
  }

  const gates = e.gates;
  if (!Array.isArray(gates) || gates.length === 0) reasons.push("gates_invalid");
  else {
    gates.forEach((gateValue, index) => {
      const g = gateValue as Record<string, unknown> | undefined;
      if (typeof g !== "object" || g === null) {
        reasons.push(`gates[${index}].invalid`);
        return;
      }
      if (!exactKeys(g, GATE_KEYS, `gates[${index}]`, reasons)) return;
      checkStringValue(g.gateId, `gates[${index}].gateId`, reasons);
      if (g.status !== "pass" && g.status !== "fail") reasons.push(`gates[${index}].status_invalid`);
      const classes = g.evidenceClasses;
      if (!Array.isArray(classes) || classes.length === 0) {
        reasons.push(`gates[${index}].evidenceClasses_invalid`);
      } else if (
        classes.some(
          (c) => c !== "automated" && c !== "static_review" && c !== "owner_attested",
        )
      ) {
        reasons.push(`gates[${index}].evidenceClasses_invalid`);
      }
    });
  }

  const integrity = e.integrity as Record<string, unknown> | undefined;
  if (typeof integrity !== "object" || integrity === null) reasons.push("integrity_invalid");
  else if (exactKeys(integrity, INTEGRITY_KEYS, "integrity", reasons)) {
    if (typeof integrity.canonicalBytesHash !== "string" || !/^[0-9a-f]{64}$/.test(integrity.canonicalBytesHash)) {
      reasons.push("integrity.canonical_bytes_hash_invalid");
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, envelope: value as Phase3ValidationEvidenceEnvelope };
}

// ---------------------------------------------------------------------------
// replay consistency（纯函数；永远 provenance=false / promotion=false）
// ---------------------------------------------------------------------------

export interface EnvelopeReplayInput {
  parentSkillId?: string;
  parentSkillRevision?: string;
  sourceHash?: string;
  selectedReferenceHash?: string;
  procedureRevision?: string;
  artifactHash?: string;
  evidenceIds?: readonly string[];
  operationClass?: string;
  verifierId?: string;
  gateIds?: readonly string[];
  nBreakEven?: number;
  sampleSize?: number;
}

export type EnvelopeReplayResult =
  | { consistent: true; provesRealProvenance: false; promotionEligible: false }
  | {
      consistent: false;
      mismatches: readonly string[];
      provesRealProvenance: false;
      promotionEligible: false;
    };

/**
 * 一致性重放：1) shape 校验；2) integrity 重算（篡改任何字段即 mismatch）；
 * 3) 与调用方提供的期望事实逐项比对。输出永远携带
 * provesRealProvenance=false、promotionEligible=false（ADR-0011 §6）。
 */
export function replayEnvelopeConsistency(
  envelope: Phase3ValidationEvidenceEnvelope,
  expected: EnvelopeReplayInput,
): EnvelopeReplayResult {
  const mismatches: string[] = [];
  const shape = verifyEnvelopeShape(envelope);
  if (!shape.ok) {
    mismatches.push(`shape_invalid:${(shape as { reasons: readonly string[] }).reasons.join(",")}`);
  }

  const { integrity: _integrity, ...withoutIntegrity } = envelope;
  const actualHash = sha256Hex(canonicalEnvelopeJson(withoutIntegrity));
  if (actualHash !== envelope.integrity.canonicalBytesHash) {
    mismatches.push("integrity");
  }

  const expectPairs: Array<[string, string | undefined, string]> = [
    ["parent.skillId", expected.parentSkillId, envelope.parent.skillId],
    ["parent.skillRevision", expected.parentSkillRevision, envelope.parent.skillRevision],
    ["parent.sourceHash", expected.sourceHash, envelope.parent.sourceHash],
    ["parent.selectedReferenceHash", expected.selectedReferenceHash, envelope.parent.selectedReferenceHash],
    ["parent.procedureRevision", expected.procedureRevision, envelope.parent.procedureRevision],
    ["parent.artifactHash", expected.artifactHash, envelope.parent.artifactHash],
    ["operation.class", expected.operationClass, envelope.operation.class],
    ["operation.verifierId", expected.verifierId, envelope.operation.verifierId],
  ];
  for (const [path, expectedValue, actualValue] of expectPairs) {
    if (expectedValue !== undefined && expectedValue !== actualValue) mismatches.push(path);
  }
  if (expected.evidenceIds !== undefined) {
    const expectedIds = [...expected.evidenceIds].sort();
    const actualIds = [...envelope.evidenceIds].sort();
    if (expectedIds.length !== actualIds.length || expectedIds.some((id, i) => id !== actualIds[i])) {
      mismatches.push("evidenceIds");
    }
  }
  if (expected.gateIds !== undefined) {
    const expectedGateIds = [...expected.gateIds].sort();
    const actualGateIds = envelope.gates.map((g) => g.gateId).sort();
    if (
      expectedGateIds.length !== actualGateIds.length ||
      expectedGateIds.some((id, i) => id !== actualGateIds[i])
    ) {
      mismatches.push("gates");
    }
  }
  if (expected.nBreakEven !== undefined && expected.nBreakEven !== envelope.costSummary.nBreakEven) {
    mismatches.push("cost_summary.nBreakEven");
  }
  if (expected.sampleSize !== undefined && expected.sampleSize !== envelope.costSummary.sampleSize) {
    mismatches.push("cost_summary.sampleSize");
  }

  if (mismatches.length > 0) {
    return { consistent: false, mismatches, provesRealProvenance: false, promotionEligible: false };
  }
  return { consistent: true, provesRealProvenance: false, promotionEligible: false };
}
