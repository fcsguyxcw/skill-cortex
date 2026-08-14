import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import { HELDOUT_CASES } from "./cases.ts";
import type { PaginationCase, PaginationClass } from "./cases.ts";
import {
  THRESHOLDS,
  computeCost,
  evaluate,
  judgePromotion,
  validateRealCostEvidence,
  type CostReport,
  type Metrics,
  type PromotionInput,
  type RealCostEvidence,
} from "./metrics.ts";
import {
  resolvePracticeEvidence,
  type PracticeEvidenceAssessment,
} from "./practice-evidence.ts";

function mk(id: string, expected: PaginationClass, sql = "SELECT 1;"): PaginationCase {
  return { id, partition: "heldout", sql, expected };
}

function mapOf(entries: Array<[string, unknown]>): Map<string, unknown> {
  return new Map(entries);
}

/** held-out 全部正确 finding（无 evidence → 合同直接 pass）。 */
function perfectHeldoutFindings(): Map<string, unknown> {
  return mapOf(HELDOUT_CASES.map((c) => [c.id, { class: c.expected }]));
}

/** 自洽的合法真实成本证据（nBreakEven = 300/35 ≈ 8.57 < 10）。 */
function validRealCostEvidence(overrides: Partial<RealCostEvidence> = {}): RealCostEvidence {
  const compileAndValidationCost = 300;
  const meanSlowPathCost = 50;
  const meanFastPathCost = 10;
  const meanFallbackCost = 5;
  const nBreakEven =
    compileAndValidationCost / (meanSlowPathCost - meanFastPathCost - meanFallbackCost);
  return {
    unit: "latency_ms",
    compileAndValidationCost,
    meanSlowPathCost,
    meanFastPathCost,
    meanFallbackCost,
    nBreakEven,
    sampleSize: 20,
    ...overrides,
  };
}

/** 构造 nBreakEven 恰为指定值的自洽证据（denominator = compile / nbe）。 */
function evidenceWithNbe(nbe: number): RealCostEvidence {
  const compileAndValidationCost = 300;
  const meanFastPathCost = 10;
  const meanFallbackCost = 0;
  const meanSlowPathCost = compileAndValidationCost / nbe + meanFastPathCost + meanFallbackCost;
  return {
    unit: "latency_ms",
    compileAndValidationCost,
    meanSlowPathCost,
    meanFastPathCost,
    meanFallbackCost,
    nBreakEven: nbe,
    sampleSize: 20,
  };
}

const PARENT_SKILL_ID = `skill:${"a".repeat(64)}`;
const WRONG_PARENT_SKILL_ID = `skill:${"d".repeat(64)}`;
const PARENT_REVISION = `rev:${"b".repeat(64)}`;
const SOURCE_HASH = `sha256:${"c".repeat(64)}`;
const REQUIRED_OPERATION = "sql-static-inspection";
const REQUIRED_VERIFIER = "pagination-oracle";
const TENANT = "project:phase3-metrics";
const TEST_ROOT = path.join(process.cwd(), `.tmp-phase3-evidence-${randomUUID()}`);
const TEST_STORE = new PracticeStore({ projectRoot: process.cwd(), rootDir: TEST_ROOT });

function practiceEvent(
  eventId: string,
  provenance: PracticeEvent["provenance"] = "real",
  parentSkillId = PARENT_SKILL_ID,
  operationClass = REQUIRED_OPERATION,
  verifierId = REQUIRED_VERIFIER,
): PracticeEvent {
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: "2026-08-14T00:00:00.000Z",
    tenantScope: TENANT,
    provenance,
    parentSkillId,
    parentSkillRevision: PARENT_REVISION,
    sourceHash: SOURCE_HASH,
    candidateSkillIds: [parentSkillId],
    selectedSkillIds: [parentSkillId],
    executionMode: "skill_md",
    redactedTaskFeatures: ["pagination", "offset"],
    stepSummaries: [
      { stepId: "inspect", actor: "tool", operationClass, outcome: "ok" },
    ],
    authorizationResults: [{ gateId: "read-only", result: "not_required" }],
    guardResults: [{ predicateId: "bounded-sql", phase: "precondition", result: "pass" }],
    verifierResults: [{ verifierId, result: "pass" }],
    attribution: "verified_skill_effect",
    sensitivity: "none",
    retentionClass: "project_manual",
  };
}

for (const event of [
  practiceEvent("evt-real-1"),
  practiceEvent("evt-real-2"),
  practiceEvent("evt-evaluation", "evaluation"),
  practiceEvent("evt-synthetic", "synthetic"),
  practiceEvent("evt-wrong-parent", "real", WRONG_PARENT_SKILL_ID),
  practiceEvent("evt-other-rule", "real", PARENT_SKILL_ID, "connection-pool-inspection", "connection-pool-verifier"),
]) {
  await TEST_STORE.append(event);
}
const TWO_REAL = await resolvePracticeEvidence({
  store: TEST_STORE,
  tenantScope: TENANT,
  eventIds: ["evt-real-1", "evt-real-2"],
  expectedParentSkillId: PARENT_SKILL_ID,
  expectedParentSkillRevision: PARENT_REVISION,
  expectedSourceHash: SOURCE_HASH,
  requiredOperationClass: REQUIRED_OPERATION,
  requiredVerifierId: REQUIRED_VERIFIER,
});
const NO_REAL = await resolvePracticeEvidence({
  store: TEST_STORE,
  tenantScope: TENANT,
  eventIds: [],
  expectedParentSkillId: PARENT_SKILL_ID,
  expectedParentSkillRevision: PARENT_REVISION,
  expectedSourceHash: SOURCE_HASH,
  requiredOperationClass: REQUIRED_OPERATION,
  requiredVerifierId: REQUIRED_VERIFIER,
});

after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function promotionOk(metrics: Metrics, byteCost?: CostReport): PromotionInput {
  return {
    metrics,
    practiceEvidence: TWO_REAL,
    practiceEvidenceBinding: {
      parentSkillId: PARENT_SKILL_ID,
      parentSkillRevision: PARENT_REVISION,
      sourceHash: SOURCE_HASH,
      requiredOperationClass: REQUIRED_OPERATION,
      requiredVerifierId: REQUIRED_VERIFIER,
    },
    realCostEvidence: validRealCostEvidence(),
    byteCostReference: byteCost,
    artifactSafetyOk: true,
    sourceBindingOk: true,
    evidenceIndependenceOk: true,
    verifierIndependenceOk: true,
    scopeConformanceOk: true,
  };
}

describe("Phase 3 指标汇总", () => {
  it("理想 held-out（全正确）→ accuracy=1.0、offset recall=1.0、FPR=0、unexpected-abstain=0；abstainRate=3/15=0.20（正确 abstain 计入回退率，边界值）", () => {
    const { metrics } = evaluate(HELDOUT_CASES, perfectHeldoutFindings());
    assert.equal(metrics.accuracy, 1);
    assert.equal(metrics.offsetRecall, 1);
    assert.equal(metrics.offsetFpr, 0);
    assert.equal(metrics.expectedAbstainRecall, 1);
    assert.equal(metrics.abstainRate, 0.2);
    assert.equal(metrics.unexpectedAbstainRate, 0);
    assert.deepEqual(metrics.counts, {
      total: 15, offsetExpected: 5, nonOffsetExpected: 10,
      abstainExpected: 3, nonAbstainExpected: 12,
      offsetPredicted: 5, abstainPredicted: 3, passed: 15,
    });
  });

  it("全 abstain 防逃逸：accuracy=3/15≈0.20、unexpected-abstain=12/12=1.0 → draft", () => {
    const findings = mapOf(HELDOUT_CASES.map((c) => [c.id, { class: "abstain" }]));
    const { metrics } = evaluate(HELDOUT_CASES, findings);
    assert.equal(metrics.accuracy, 3 / 15);
    assert.equal(metrics.unexpectedAbstainRate, 1);
    assert.equal(metrics.abstainRate, 1);
    assert.equal(metrics.offsetRecall, 0);
    const { decision } = judgePromotion(promotionOk(metrics));
    assert.equal(decision, "draft");
  });

  it("offset 漏检一例（H01 判 keyset）→ offsetRecall=4/5 → 硬门 draft", () => {
    const findings = perfectHeldoutFindings();
    findings.set("H01", { class: "uses_keyset" });
    const { metrics } = evaluate(HELDOUT_CASES, findings);
    assert.equal(metrics.offsetRecall, 4 / 5);
    const { gates, decision } = judgePromotion(promotionOk(metrics));
    assert.equal(decision, "draft");
    assert.equal(gates.find((g) => g.gateId === "offset_recall")!.status, "fail");
  });

  it("对抗性误判（H06 判 uses_offset）→ FPR=1/10=0.10 > 0.05 → correctness fail", () => {
    const findings = perfectHeldoutFindings();
    findings.set("H06", { class: "uses_offset", evidence: { matchText: "OFFSET 20" } });
    const { metrics } = evaluate(HELDOUT_CASES, findings);
    assert.equal(metrics.offsetFpr, 0.1);
    const { decision } = judgePromotion(promotionOk(metrics));
    assert.equal(decision, "draft");
  });

  it("缺 finding 的 case 计 fail(missing_finding)，accuracy 降为 14/15", () => {
    const findings = perfectHeldoutFindings();
    findings.delete("H01");
    const { perCase, metrics } = evaluate(HELDOUT_CASES, findings);
    const h01 = perCase.find((r) => r.caseId === "H01")!;
    assert.deepEqual(h01.outcome, { pass: false, code: "missing_finding", findingClass: null });
    assert.equal(metrics.accuracy, 14 / 15);
  });

  it("空案例集 → 全指标 N/A；promotion 必需指标 N/A = insufficient_evidence → 必 draft", () => {
    const { metrics } = evaluate([], new Map());
    assert.equal(metrics.accuracy, "N/A");
    assert.equal(metrics.offsetRecall, "N/A");
    assert.equal(metrics.offsetFpr, "N/A");
    assert.equal(metrics.expectedAbstainRecall, "N/A");
    assert.equal(metrics.abstainRate, "N/A");
    assert.equal(metrics.unexpectedAbstainRate, "N/A");
    // 即使提供合法真实成本证据，指标证据不足仍必须 fail（不得因“非 fail”进入 validated）
    const { gates, decision } = judgePromotion(promotionOk(metrics));
    assert.equal(decision, "draft");
    for (const id of ["offset_recall", "correctness", "fallback", "cost"]) {
      const g = gates.find((x) => x.gateId === id)!;
      assert.equal(g.status, "fail", `${id} 必须 insufficient_evidence fail`);
      assert.match(g.detail, /insufficient_evidence/);
    }
  });
});

describe("Phase 3 阈值边界（含等号）", () => {
  it("accuracy：=0.95 pass、<0.95 fail", () => {
    const cases20 = Array.from({ length: 20 }, (_, i) => mk(`A${i}`, "no_pagination"));
    const pass19 = mapOf(cases20.map((c, i) => [c.id, { class: i === 19 ? "uses_offset" : "no_pagination" }]));
    const pass18 = mapOf(cases20.map((c, i) => [c.id, { class: i >= 18 ? "uses_offset" : "no_pagination" }]));
    const m19 = evaluate(cases20, pass19).metrics;
    const m18 = evaluate(cases20, pass18).metrics;
    assert.equal(m19.accuracy, 19 / 20); // 0.95 恰好达标
    assert.equal(m18.accuracy, 18 / 20); // 0.9 不达标
    assert.equal(m19.accuracy >= THRESHOLDS.accuracy, true);
    assert.equal(m18.accuracy >= THRESHOLDS.accuracy, false);
  });

  it("offset FPR：=0.05 pass、>0.05 fail", () => {
    const cases20 = Array.from({ length: 20 }, (_, i) => mk(`F${i}`, "no_pagination"));
    const fpr1 = mapOf(cases20.map((c, i) => [c.id, { class: i === 0 ? "uses_offset" : "no_pagination" }]));
    const fpr2 = mapOf(cases20.map((c, i) => [c.id, { class: i < 2 ? "uses_offset" : "no_pagination" }]));
    const m1 = evaluate(cases20, fpr1).metrics;
    const m2 = evaluate(cases20, fpr2).metrics;
    assert.equal(m1.offsetFpr, 0.05);
    assert.equal(m2.offsetFpr, 0.1);
    assert.equal(m1.offsetFpr <= THRESHOLDS.offsetFpr, true);
    assert.equal(m2.offsetFpr <= THRESHOLDS.offsetFpr, false);
  });

  it("abstain rate：=0.20 pass、>0.20 fail；unexpected-abstain：=0.10 pass、>0.10 fail", () => {
    const cases20 = Array.from({ length: 20 }, (_, i) =>
      mk(`R${i}`, i < 4 ? "abstain" : "no_pagination"),
    );
    const m4 = evaluate(cases20, mapOf(cases20.map((c) => [c.id, { class: c.expected }]))).metrics;
    assert.equal(m4.abstainRate, 0.2); // 4/20 正确 abstain
    const cases20b = Array.from({ length: 20 }, (_, i) => mk(`U${i}`, "no_pagination"));
    const u2 = evaluate(
      cases20b,
      mapOf(cases20b.map((c, i) => [c.id, { class: i < 2 ? "abstain" : "no_pagination" }])),
    ).metrics;
    assert.equal(u2.unexpectedAbstainRate, 0.1); // 2/20
    const u3 = evaluate(
      cases20b,
      mapOf(cases20b.map((c, i) => [c.id, { class: i < 3 ? "abstain" : "no_pagination" }])),
    ).metrics;
    assert.equal(u3.unexpectedAbstainRate, 0.15); // 3/20
    assert.equal(m4.abstainRate <= THRESHOLDS.abstainRate, true);
    assert.equal(u2.unexpectedAbstainRate <= THRESHOLDS.unexpectedAbstainRate, true);
    assert.equal(u3.unexpectedAbstainRate <= THRESHOLDS.unexpectedAbstainRate, false);
  });
});

describe("Phase 3 成本模型（字节口径，可复现）", () => {
  const cases3 = [mk("C1", "uses_offset", "SELECT 1;"), mk("C2", "no_pagination", "SELECT 2;"), mk("C3", "no_pagination", "SELECT 3;")];

  it("非 abstain 案例：denominator=referenceBytes，N_break-even=(ref+Σsql)/ref", () => {
    const findings = mapOf(cases3.map((c) => [c.id, { class: c.expected }]));
    const cost = computeCost({ referenceBytes: 300, cases: cases3, findings });
    assert.equal(cost.compileAndValidationCost, 300 + 9 * 3); // "SELECT n;" 各 9 字节
    assert.equal(cost.meanSlowPathCost, 309);
    assert.equal(cost.meanFastPathCost, 9);
    assert.equal(cost.meanFallbackCost, 0);
    assert.equal(cost.nBreakEven, 327 / 300);
  });

  it("全 abstain：fallback=slow → denominator<0 → N/A", () => {
    const findings = mapOf(cases3.map((c) => [c.id, { class: "abstain" }]));
    const cost = computeCost({ referenceBytes: 300, cases: cases3, findings });
    assert.equal(cost.meanFallbackCost, 309);
    assert.equal(cost.nBreakEven, "N/A");
  });

  it("空案例集：denominator=0 → N/A", () => {
    const cost = computeCost({ referenceBytes: 100, cases: [], findings: new Map() });
    assert.equal(cost.compileAndValidationCost, 100);
    assert.equal(cost.nBreakEven, "N/A");
  });
});

describe("Phase 3 promotion 硬门", () => {
  const ideal = evaluate(HELDOUT_CASES, perfectHeldoutFindings()).metrics;

  it("全声明 + 理想指标 + 合法真实成本证据（nbe<10）→ validated；字节 comparator 仅参考不参与", () => {
    const byteCost = computeCost({ referenceBytes: 1000, cases: HELDOUT_CASES, findings: perfectHeldoutFindings() });
    const { gates, decision, byteCostReference } = judgePromotion(promotionOk(ideal, byteCost));
    assert.equal(decision, "validated");
    assert.ok(gates.every((g) => g.status !== "fail"));
    assert.equal(byteCostReference, byteCost); // 独立参考输出
  });

  it("任一声明门失败 → draft", () => {
    for (const patch of [
      { artifactSafetyOk: false },
      { sourceBindingOk: false },
      { evidenceIndependenceOk: false },
      { verifierIndependenceOk: false },
      { scopeConformanceOk: false },
    ] as const) {
      const { decision } = judgePromotion({ ...promotionOk(ideal), ...patch });
      assert.equal(decision, "draft", `必须 draft: ${JSON.stringify(patch)}`);
    }
  });

  it("缺真实成本证据（未提供 realCostEvidence）→ blocker fail → draft，即使指标全达标且给了字节 comparator", () => {
    const byteCost = computeCost({ referenceBytes: 1000, cases: HELDOUT_CASES, findings: perfectHeldoutFindings() });
    const { gates, decision } = judgePromotion({ ...promotionOk(ideal), realCostEvidence: undefined, byteCostReference: byteCost });
    assert.equal(decision, "draft");
    assert.equal(gates.find((g) => g.gateId === "real_cost_evidence")!.status, "fail");
    // 字节 comparator 不得冒充真实证据：cost gate 只在不使用真实 evidence 时注明未参与
    assert.equal(gates.find((g) => g.gateId === "cost")!.detail.includes("独立参考"), true);
  });

  it("伪造真实成本证据（NaN/负数/sampleSize 0/非整数/分母≤0/nbe 不自洽）→ 各 draft", () => {
    const forged: Array<[string, Partial<RealCostEvidence> | RealCostEvidence]> = [
      ["NaN", { compileAndValidationCost: NaN }],
      ["负数 meanFastPathCost", { meanFastPathCost: -1 }],
      ["sampleSize=0", { sampleSize: 0 }],
      ["sampleSize 非整数", { sampleSize: 0.5 }],
      ["负数 nBreakEven", { nBreakEven: -5 }],
      ["分母≤0（slow < fast）", { meanSlowPathCost: 5, meanFastPathCost: 10 }],
      ["nBreakEven 不自洽（与公式不符）", { nBreakEven: 1 }],
    ];
    for (const [name, patch] of forged) {
      const forgedEvidence = validRealCostEvidence(patch);
      const validation = validateRealCostEvidence(forgedEvidence);
      assert.equal(validation.ok, false, `${name} 必须验证失败`);
      const { decision } = judgePromotion({ ...promotionOk(ideal), realCostEvidence: forgedEvidence });
      assert.equal(decision, "draft", `${name} 必须 draft`);
    }
  });

  it("真实 evidence 的 N_break-even 边界：=10 validated、>10 draft", () => {
    const at10 = judgePromotion({ ...promotionOk(ideal), realCostEvidence: evidenceWithNbe(10) });
    assert.equal(at10.decision, "validated");
    assert.equal(at10.gates.find((g) => g.gateId === "cost")!.status, "pass");
    const over10 = judgePromotion({ ...promotionOk(ideal), realCostEvidence: evidenceWithNbe(10.1) });
    assert.equal(over10.decision, "draft");
    assert.equal(over10.gates.find((g) => g.gateId === "cost")!.status, "fail");
  });

  it("字节 comparator 的 nBreakEven 永不参与判定（即使 >10 也不影响，仍由 blocker 门裁决）", () => {
    // byte comparator nbe 巨大；无真实证据 → draft 只因 blocker，cost gate 不因 byte 值 fail
    const byteCost: CostReport = {
      compileAndValidationCost: 1,
      meanSlowPathCost: 10,
      meanFastPathCost: 1,
      meanFallbackCost: 0,
      nBreakEven: 999, // 参考值故意巨大
    };
    const { gates, decision } = judgePromotion({
      ...promotionOk(ideal),
      realCostEvidence: undefined,
      byteCostReference: byteCost,
    });
    assert.equal(decision, "draft");
    const costGate = gates.find((g) => g.gateId === "cost")!;
    assert.match(costGate.detail, /独立参考，永不参与判定/);
    assert.equal(costGate.status, "pass"); // 仅 abstainRate 达标时 byte 值不触发 fail
  });

  it("offset recall 硬门：指标 N/A → insufficient_evidence fail（不再‘不参与’）", () => {
    const empty = evaluate([], new Map()).metrics;
    const { gates, decision } = judgePromotion(promotionOk(empty));
    assert.equal(decision, "draft");
    assert.equal(gates.find((g) => g.gateId === "offset_recall")!.status, "fail");
    assert.match(gates.find((g) => g.gateId === "offset_recall")!.detail, /insufficient_evidence/);
  });
});

describe("Phase 3 ADR-0008 practice_evidence 硬门", () => {
  const ideal = evaluate(HELDOUT_CASES, perfectHeldoutFindings()).metrics;

  it("Store 中 0 个匹配 real event → draft", () => {
    const { gates, decision } = judgePromotion({ ...promotionOk(ideal), practiceEvidence: NO_REAL });
    assert.equal(decision, "draft");
    const g = gates.find((x) => x.gateId === "practice_evidence")!;
    assert.equal(g.status, "fail");
    assert.match(g.detail, /distinct_store_verified_real_events=0/);
  });

  it("重复同一 Store event 只计一次", async () => {
    const one = await resolvePracticeEvidence({
      store: TEST_STORE,
      tenantScope: TENANT,
      eventIds: ["evt-real-1", "evt-real-1"],
      expectedParentSkillId: PARENT_SKILL_ID,
      expectedParentSkillRevision: PARENT_REVISION,
      expectedSourceHash: SOURCE_HASH,
      requiredOperationClass: REQUIRED_OPERATION,
      requiredVerifierId: REQUIRED_VERIFIER,
    });
    assert.equal(judgePromotion({ ...promotionOk(ideal), practiceEvidence: one }).decision, "draft");
  });

  it("普通对象不能伪造 store-verified assessment", () => {
    const forged = {
      ok: true,
      distinctRealCount: 2,
      reason: "ok",
      eventIds: ["fake-1", "fake-2"],
    } as unknown as PracticeEvidenceAssessment;
    assert.equal(judgePromotion({ ...promotionOk(ideal), practiceEvidence: forged }).decision, "draft");
  });

  it("missing、非 real、父绑定错误均不能形成可晋升 assessment", async () => {
    const eventSets = [
      ["missing-1", "missing-2"],
      ["evt-evaluation", "evt-synthetic"],
      ["evt-real-1", "evt-wrong-parent"],
      ["evt-real-1", "evt-other-rule"],
    ];
    for (const eventIds of eventSets) {
      const resolved = await resolvePracticeEvidence({
        store: TEST_STORE,
        tenantScope: TENANT,
        eventIds,
        expectedParentSkillId: PARENT_SKILL_ID,
        expectedParentSkillRevision: PARENT_REVISION,
        expectedSourceHash: SOURCE_HASH,
        requiredOperationClass: REQUIRED_OPERATION,
        requiredVerifierId: REQUIRED_VERIFIER,
      });
      assert.equal(resolved.ok, false);
      assert.equal(
        judgePromotion({ ...promotionOk(ideal), practiceEvidence: resolved }).decision,
        "draft",
      );
    }
  });

  it("同一 assessment 不能跨父 procedure binding 复用", () => {
    const result = judgePromotion({
      ...promotionOk(ideal),
      practiceEvidenceBinding: {
        parentSkillId: WRONG_PARENT_SKILL_ID,
        parentSkillRevision: PARENT_REVISION,
        sourceHash: SOURCE_HASH,
        requiredOperationClass: REQUIRED_OPERATION,
        requiredVerifierId: REQUIRED_VERIFIER,
      },
    });
    assert.equal(result.decision, "draft");
    assert.match(
      result.gates.find((x) => x.gateId === "practice_evidence")!.detail,
      /binding_mismatch/,
    );
  });

  it("两个 Store-verified matching real events 才不阻塞", () => {
    const { gates, decision } = judgePromotion(promotionOk(ideal));
    assert.equal(decision, "validated");
    assert.equal(gates.find((x) => x.gateId === "practice_evidence")!.status, "pass");
    const noIndependence = judgePromotion({ ...promotionOk(ideal), evidenceIndependenceOk: false });
    assert.equal(noIndependence.decision, "draft");
    assert.equal(noIndependence.gates.find((x) => x.gateId === "practice_evidence")!.status, "pass");
    assert.equal(noIndependence.gates.find((x) => x.gateId === "evidence_independence")!.status, "fail");
  });
});
