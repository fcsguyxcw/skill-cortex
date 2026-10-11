/**
 * Phase 3 redacted validation evidence envelope 单测（ADR-0011 §6/§7）。
 *
 * 覆盖：
 * - formal 创建：sourceMode=formal_real_store + decision=validated + validatedProcedure 存在
 *   ⇒ ok；只抽白名单字段；固定 kind/replaySource/provesRealProvenance/promotionEligible；
 * - evaluation_fixture 拒绝；decision=draft 拒绝；
 * - 确定性：同输入两次 create ⇒ 深度相等；
 * - 篡改：任意字段 ⇒ replay mismatch（integrity + 路径）；kind/extra key/sensitive key/
 *   integrity 篡改 ⇒ verify fail 或 replay mismatch；
 * - 无敏感字段：序列化结果不含 tenant/task/sql/路径/工具输出/details 等；
 * - 永不 promotion：create 与 replay（consistent / inconsistent 两分支）恒
 *   provesRealProvenance=false、promotionEligible=false。
 *
 * 不生成 JSON 文件；纯内存构造。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { GATE_EVIDENCE_CLASSES } from "./metrics.ts";
import { P3_GATE_EVIDENCE_RECORDS, P3_GATE_FROZEN } from "./p3-gate-runner.ts";
import type { P3GateResult } from "./p3-gate-runner.ts";
import { buildPhase3ProcedureDraft, transitionPhase3ProcedureValidation } from "../../procedures/phase3/index.ts";
import {
  ENVELOPE_KIND,
  ENVELOPE_REPLAY_SOURCE,
  ENVELOPE_SCHEMA_VERSION,
  ENVELOPE_SOURCE_MODE,
  createEvidenceEnvelope,
  replayEnvelopeConsistency,
  verifyEnvelopeShape,
  type EnvelopeReplayInput,
  type Phase3ValidationEvidenceEnvelope,
} from "./evidence-envelope.ts";

const VALIDATION_REPORT_ID = "validation:envelope-test-001";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

/** 构造 validated procedure（effectless pilot 省略 permissionPolicyHash，ADR-0011）。 */
function buildValidatedProcedure() {
  const draft = buildPhase3ProcedureDraft({
    parentSkillId: P3_GATE_FROZEN.parentSkillId,
    parentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
    skillMdHash: P3_GATE_FROZEN.sourceHash,
    selectedReferenceHash: P3_GATE_FROZEN.selectedReferenceHash,
    createdAt: "2026-08-15T00:00:00.000Z",
    evidenceIds: [...P3_GATE_FROZEN.eventIds],
  });
  return transitionPhase3ProcedureValidation(draft, {
    decision: "validated",
    validationReportId: VALIDATION_REPORT_ID,
  });
}

/** 完整 P3GateResult（白名单字段齐全；draft/evidenceAssessment 可选省略）。 */
function makeP3GateResult(): P3GateResult {
  return {
    frozen: P3_GATE_FROZEN,
    measuredAt: "2026-08-15T23:56:58.994Z",
    steps: {
      readRealEvents: { ok: true, detail: "ok" },
      inductionBinding: { ok: true, detail: "ok" },
      resolvePracticeEvidence: { ok: true, detail: "ok" },
      costEvidence: { ok: true, detail: "ok" },
      heldoutReplay: { ok: true, detail: "ok" },
      sourceBindingCheck: { ok: true, detail: "ok" },
    },
    allPreconditionsOk: true,
    sourceMode: "formal_real_store",
    gateEvidenceRecords: P3_GATE_EVIDENCE_RECORDS,
    heldoutMetrics: {
      accuracy: 1,
      offsetRecall: 1,
      offsetFpr: 0,
      expectedAbstainRecall: 1,
      abstainRate: 3 / 15,
      unexpectedAbstainRate: 0,
      counts: {
        total: 15,
        offsetExpected: 5,
        nonOffsetExpected: 10,
        abstainExpected: 3,
        nonAbstainExpected: 12,
        offsetPredicted: 5,
        abstainPredicted: 3,
        passed: 15,
      },
    },
    realCostEvidence: {
      unit: "latency_ms",
      compileAndValidationCost: 300,
      meanSlowPathCost: 50,
      meanFastPathCost: 10,
      meanFallbackCost: 5,
      nBreakEven: 300 / 35,
      sampleSize: 20,
    },
    gates: Object.entries(GATE_EVIDENCE_CLASSES).map(([gateId, evidenceClasses]) => ({
      gateId,
      name: gateId,
      status: "pass" as const,
      detail: "test",
      evidenceClasses,
    })),
    assessmentDecision: "validated",
    decision: "validated",
    validatedProcedure: buildValidatedProcedure(),
    validationReportId: VALIDATION_REPORT_ID,
  };
}

function createdEnvelope(): { ok: true; envelope: Phase3ValidationEvidenceEnvelope } {
  const created = createEvidenceEnvelope(makeP3GateResult());
  assert.equal(created.ok, true, JSON.stringify((created as { reasons?: readonly string[] }).reasons));
  return created as { ok: true; envelope: Phase3ValidationEvidenceEnvelope };
}

/** 与 makeP3GateResult 一致的期望事实（fresh-clone 上由已提交报告锚点提供）。 */
function expectedInput(): EnvelopeReplayInput {
  return {
    parentSkillId: P3_GATE_FROZEN.parentSkillId,
    parentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
    sourceHash: P3_GATE_FROZEN.sourceHash,
    selectedReferenceHash: P3_GATE_FROZEN.selectedReferenceHash,
    procedureRevision: undefined,
    artifactHash: undefined,
    evidenceIds: [...P3_GATE_FROZEN.eventIds],
    operationClass: P3_GATE_FROZEN.requiredOperationClass,
    verifierId: P3_GATE_FROZEN.requiredVerifierId,
    gateIds: Object.keys(GATE_EVIDENCE_CLASSES),
    nBreakEven: 300 / 35,
    sampleSize: 20,
  };
}

describe("Phase 3 redacted validation evidence envelope（ADR-0011 §6/§7）", () => {
  it("committed envelope 与 formal validation report 锚点一致（fresh-clone 可复验）", () => {
    const report = JSON.parse(
      readFileSync(
        path.join(PROJECT_ROOT, "docs/reports/2026-08-14-phase3-p3-validation-report.json"),
        "utf8",
      ),
    ) as P3GateResult;
    const committed = JSON.parse(
      readFileSync(
        path.join(PROJECT_ROOT, "docs/reports/2026-08-16-phase3-validation-evidence-envelope.json"),
        "utf8",
      ),
    ) as Phase3ValidationEvidenceEnvelope;
    const created = createEvidenceEnvelope(report);
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) return;
    assert.deepEqual(committed, created.envelope);
    assert.deepEqual(replayEnvelopeConsistency(committed, {
      parentSkillId: report.validatedProcedure!.parentSkillId,
      parentSkillRevision: report.validatedProcedure!.parentSkillRevision,
      sourceHash: report.validatedProcedure!.sourceBindings.skillMdHash,
      selectedReferenceHash: report.validatedProcedure!.sourceBindings.selectedReferenceHash,
      procedureRevision: report.validatedProcedure!.procedureRevision,
      artifactHash: report.validatedProcedure!.artifactHash,
      evidenceIds: report.validatedProcedure!.evidenceIds,
      operationClass: report.frozen.requiredOperationClass,
      verifierId: report.frozen.requiredVerifierId,
      gateIds: report.gates!.map((gate) => gate.gateId),
      nBreakEven: report.realCostEvidence!.nBreakEven,
      sampleSize: report.realCostEvidence!.sampleSize,
    }), {
      consistent: true,
      provesRealProvenance: false,
      promotionEligible: false,
    });
  });

  it("formal 创建：sourceMode=formal_real_store + validated ⇒ ok；固定字面量与白名单字段", () => {
    const { envelope } = createdEnvelope();
    assert.equal(envelope.kind, ENVELOPE_KIND);
    assert.equal(envelope.kind, "phase3_validation_evidence_envelope");
    assert.equal(envelope.schemaVersion, ENVELOPE_SCHEMA_VERSION);
    assert.equal(envelope.sourceMode, "formal_real_store");
    assert.equal(envelope.replaySource, "evaluation/envelope_replay");
    assert.equal(envelope.provesRealProvenance, false);
    assert.equal(envelope.promotionEligible, false);
    assert.match(envelope.envelopeId, /^envelope:[0-9a-f]{32}$/);
    assert.match(envelope.integrity.canonicalBytesHash, /^[0-9a-f]{64}$/);

    // 白名单抽取：identity/hash/controlled enum/count/reference。
    assert.equal(envelope.parent.skillId, P3_GATE_FROZEN.parentSkillId);
    assert.equal(envelope.parent.skillRevision, P3_GATE_FROZEN.parentSkillRevision);
    assert.equal(envelope.parent.sourceHash, P3_GATE_FROZEN.sourceHash);
    assert.equal(envelope.parent.selectedReferenceHash, P3_GATE_FROZEN.selectedReferenceHash);
    assert.deepEqual(envelope.evidenceIds, [...P3_GATE_FROZEN.eventIds]);
    assert.equal(envelope.operation.class, P3_GATE_FROZEN.requiredOperationClass);
    assert.equal(envelope.operation.verifierId, P3_GATE_FROZEN.requiredVerifierId);
    assert.equal(envelope.metrics.accuracy, 1);
    assert.equal(envelope.costSummary.sampleSize, 20);
    assert.equal(envelope.gates.length, 11);
  });

  it("确定性：同输入两次 create ⇒ 深度相等", () => {
    const first = createEvidenceEnvelope(makeP3GateResult());
    const second = createEvidenceEnvelope(makeP3GateResult());
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(second.envelope, first.envelope);
  });

  it("evaluation_fixture 拒绝；decision=draft 拒绝（ADR-0011 §7 来源隔离）", () => {
    const rejected = createEvidenceEnvelope({
      ...makeP3GateResult(),
      sourceMode: "evaluation_fixture",
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.ok(rejected.reasons.includes("source_mode_not_formal_real_store"));

    const draftResult = { ...makeP3GateResult(), decision: "draft" as const, validatedProcedure: undefined };
    const draftRejected = createEvidenceEnvelope(draftResult);
    assert.equal(draftRejected.ok, false);
    if (draftRejected.ok) return;
    assert.ok(draftRejected.reasons.includes("decision_not_validated"));
    assert.ok(draftRejected.reasons.includes("validated_procedure_missing"));
  });

  it("无敏感字段：序列化不含 tenant/task/sql/路径/工具输出/details 等", () => {
    const { envelope } = createdEnvelope();
    const serialized = JSON.stringify(envelope);
    for (const forbidden of [
      "tenant",
      "task",
      "sql",
      "prompt",
      "details",
      "content",
      "locator",
      "output",
      ".skill-cortex",
      "SKILL.md",
    ]) {
      assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `不得包含 ${forbidden}`);
    }
    // 值级：无绝对路径形态（Windows 盘符 / POSIX 根路径）。
    assert.ok(!/^[a-zA-Z]:[\\/]/.test(serialized));
    assert.ok(!/(^|[^a-zA-Z0-9_])\/[^/]/.test(serialized));
  });

  it("篡改任意字段 ⇒ replay mismatch（integrity + 具体路径）", () => {
    const { envelope } = createdEnvelope();
    const tampered: Phase3ValidationEvidenceEnvelope = {
      ...envelope,
      costSummary: { ...envelope.costSummary, nBreakEven: 999 },
    };
    const replay = replayEnvelopeConsistency(tampered, expectedInput());
    assert.equal(replay.consistent, false);
    if (!replay.consistent) {
      assert.ok(replay.mismatches.includes("integrity"));
      assert.ok(replay.mismatches.includes("cost_summary.nBreakEven"));
    }
    // 期望事实不符 ⇒ mismatch（envelope 本身未被篡改）。
    const wrongExpectation = replayEnvelopeConsistency(envelope, {
      ...expectedInput(),
      nBreakEven: 1,
    });
    assert.equal(wrongExpectation.consistent, false);
    if (!wrongExpectation.consistent) {
      assert.ok(wrongExpectation.mismatches.includes("cost_summary.nBreakEven"));
    }
  });

  it("shape 篡改 fail-closed：kind / extra key / sensitive key / integrity", () => {
    const { envelope } = createdEnvelope();

    const wrongKind = verifyEnvelopeShape({ ...envelope, kind: "other_kind" });
    assert.equal(wrongKind.ok, false);
    if (!wrongKind.ok) assert.ok(wrongKind.reasons.includes("kind_invalid"));

    const extraKey = verifyEnvelopeShape({ ...envelope, extra: 1 });
    assert.equal(extraKey.ok, false);
    if (!extraKey.ok) assert.ok(extraKey.reasons.some((r) => r.includes("keys_mismatch")));

    const sensitiveKey = verifyEnvelopeShape({ ...envelope, tenant: "leak" });
    assert.equal(sensitiveKey.ok, false);
    if (!sensitiveKey.ok) {
      assert.ok(sensitiveKey.reasons.some((r) => r.includes("sensitive_key")));
    }

    const tamperedIntegrity = {
      ...envelope,
      integrity: { canonicalBytesHash: "0".repeat(64) },
    };
    const integrityReplay = replayEnvelopeConsistency(tamperedIntegrity, expectedInput());
    assert.equal(integrityReplay.consistent, false);
    if (!integrityReplay.consistent) assert.ok(integrityReplay.mismatches.includes("integrity"));
  });

  it("永不 promotion：create 与 replay（consistent / inconsistent）恒 provenance=false、promotion=false", () => {
    const { envelope } = createdEnvelope();
    assert.equal(envelope.provesRealProvenance, false);
    assert.equal(envelope.promotionEligible, false);

    const ok = replayEnvelopeConsistency(envelope, expectedInput());
    assert.equal(ok.consistent, true);
    if (ok.consistent) {
      assert.equal(ok.provesRealProvenance, false);
      assert.equal(ok.promotionEligible, false);
    }

    const bad = replayEnvelopeConsistency(envelope, { ...expectedInput(), sampleSize: 7 });
    assert.equal(bad.consistent, false);
    if (!bad.consistent) {
      assert.equal(bad.provesRealProvenance, false);
      assert.equal(bad.promotionEligible, false);
      assert.ok(bad.mismatches.includes("cost_summary.sampleSize"));
    }
  });

  it("原生 envelope 通过 shape 校验（自身一致性）", () => {
    const { envelope } = createdEnvelope();
    const shape = verifyEnvelopeShape(envelope);
    assert.equal(shape.ok, true);
  });
});
