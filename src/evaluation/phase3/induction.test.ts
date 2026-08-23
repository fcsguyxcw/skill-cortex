/**
 * B4 induction seam 单测（离线构造事件，不依赖真实事件到位）。
 *
 * 覆盖：
 * - 成功：≥2 条契约事件 ⇒ ok；draft 绑定全部 evidenceIds、coveredSteps 引用
 *   detect-offset-pagination、status=draft、父绑定与 sourceHash 一致；
 * - 确定性可回放：同一输入任意顺序 / 重复调用 ⇒ 深度相等输出；evidenceIds 稳定排序；
 * - createdAt = max(occurredAt)（可覆盖）；
 * - fail-closed：数量不足 / 非 real / 同父绑定失配（id/revision/sourceHash）/
 *   covered step 缺失或失败 / verifier 未 pass / attribution 未验证 / 事件 ID 重复 /
 *   绑定哈希格式坏 / createdAt 格式坏 / policy 非法事件。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import {
  inducePhase3ProcedureDraft,
  INDUCED_OPERATION_CLASS,
  INDUCED_VERIFIER_ID,
  MIN_EVIDENCE_EVENTS,
} from "./induction.ts";

const PARENT_SKILL_ID = `skill:${"a".repeat(64)}`;
const PARENT_SKILL_REVISION = `rev:${"b".repeat(64)}`;
const SOURCE_HASH = `sha256:${"c".repeat(64)}`;
const REFERENCE_HASH = `sha256:${"d".repeat(64)}`;
const POLICY_HASH = `sha256:${"e".repeat(64)}`;
/** 构造 policy-valid 且满足 induction 契约的 PracticeEvent。 */
function makeEvent(id: number, overrides: Partial<PracticeEvent> = {}): PracticeEvent {
  return {
    schemaVersion: 1,
    eventId: `obs-${id}`,
    occurredAt: `2026-08-15T${String(id % 24).padStart(2, "0")}:30:00.000Z`,
    tenantScope: "project:abcdef0123456789abcdef0123456789",
    provenance: "real",
    parentSkillId: PARENT_SKILL_ID,
    parentSkillRevision: PARENT_SKILL_REVISION,
    sourceHash: SOURCE_HASH,
    routeDecisionId: "route:00000000000000000000000000000000",
    candidateSkillIds: [PARENT_SKILL_ID],
    selectedSkillIds: [PARENT_SKILL_ID],
    executionMode: "skill_md",
    redactedTaskFeatures: ["prompt-hash:00000000000000000000000000000000"],
    environmentFingerprint: "pi:0.84.1",
    dependencyFingerprint: { sourceHash: SOURCE_HASH, environmentClass: "pi-0.84.1" },
    stepSummaries: [
      { stepId: `step-${id}`, actor: "tool", operationClass: "detect-offset-pagination", outcome: "ok" },
    ],
    authorizationResults: [],
    guardResults: [],
    verifierResults: [{ verifierId: "phase3-pagination-structured-finding", result: "pass" }],
    attribution: "verified_skill_effect",
    sensitivity: "none",
    retentionClass: "project_manual",
    ...overrides,
  };
}

const DEFAULT_OPTIONS = {
  selectedReferenceHash: REFERENCE_HASH,
};

describe("inducePhase3ProcedureDraft（B4 induction seam）", () => {
  it("成功：≥2 条契约事件 ⇒ draft 绑定全部 evidenceIds、coveredSteps 引用 detect-offset-pagination", () => {
    const events = [makeEvent(1), makeEvent(2)];
    const result = inducePhase3ProcedureDraft(events, DEFAULT_OPTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // 稳定片段：父绑定 + operation + verifier + 来源证据。
    assert.equal(result.fragment.parentSkillId, PARENT_SKILL_ID);
    assert.equal(result.fragment.parentSkillRevision, PARENT_SKILL_REVISION);
    assert.equal(result.fragment.sourceHash, SOURCE_HASH);
    assert.equal(result.fragment.operationClass, INDUCED_OPERATION_CLASS);
    assert.equal(result.fragment.verifierId, INDUCED_VERIFIER_ID);
    assert.deepEqual(result.fragment.evidenceIds, ["obs-1", "obs-2"]);

    // draft：状态 draft、父绑定、source 指纹、coveredSteps、evidenceIds。
    const procedure = result.procedure;
    assert.equal(procedure.status, "draft");
    assert.equal(procedure.parentSkillId, PARENT_SKILL_ID);
    assert.equal(procedure.parentSkillRevision, PARENT_SKILL_REVISION);
    assert.equal(procedure.sourceBindings.skillMdHash, SOURCE_HASH);
    assert.equal(procedure.dependencyFingerprint.sourceHash, SOURCE_HASH);
    assert.deepEqual(procedure.coveredSteps.map((s) => s.stepId), [INDUCED_OPERATION_CLASS]);
    assert.deepEqual(procedure.evidenceIds, ["obs-1", "obs-2"]);
    assert.equal(procedure.validationReportId, "pending:phase3-pagination-validation");
    // ADR-0011：effectless pilot 的 permissionPolicyHash 必须显式省略。
    assert.equal(procedure.sourceBindings.permissionPolicyHash, undefined);
    assert.equal(procedure.dependencyFingerprint.permissionPolicyHash, undefined);
    // 冻结步骤 1 的防呆：coveredStep 引用必须指向当次对齐的 operation。
    assert.equal(procedure.coveredSteps[0]!.stepId, "detect-offset-pagination");
  });

  it("确定性可回放：同一输入任意顺序 / 重复调用 ⇒ 深度相等输出", () => {
    const events = [makeEvent(3), makeEvent(4), makeEvent(5)];
    const forward = inducePhase3ProcedureDraft(events, DEFAULT_OPTIONS);
    const reversed = inducePhase3ProcedureDraft([...events].reverse(), DEFAULT_OPTIONS);
    const again = inducePhase3ProcedureDraft(events, DEFAULT_OPTIONS);
    assert.equal(forward.ok, true);
    assert.equal(reversed.ok, true);
    assert.equal(again.ok, true);
    if (!forward.ok || !reversed.ok || !again.ok) return;
    assert.deepEqual(reversed.procedure, forward.procedure, "顺序无关 ⇒ 同一 draft");
    assert.deepEqual(reversed.fragment, forward.fragment, "顺序无关 ⇒ 同一 fragment");
    assert.deepEqual(again.procedure, forward.procedure, "重复调用 ⇒ 同一输出");
    // evidenceIds 稳定排序（不依赖输入顺序）。
    assert.deepEqual(forward.fragment.evidenceIds, ["obs-3", "obs-4", "obs-5"]);
  });

  it("createdAt = max(occurredAt)；提供覆盖时以覆盖为准", () => {
    const events = [
      makeEvent(6, { occurredAt: "2026-08-15T08:00:00.000Z" }),
      makeEvent(7, { occurredAt: "2026-08-15T03:00:00.000Z" }),
    ];
    const derived = inducePhase3ProcedureDraft(events, DEFAULT_OPTIONS);
    assert.equal(derived.ok, true);
    if (!derived.ok) return;
    assert.equal(derived.procedure.createdAt, "2026-08-15T08:00:00.000Z");

    const override = inducePhase3ProcedureDraft(events, {
      ...DEFAULT_OPTIONS,
      createdAt: "2026-08-16T00:00:00.000Z",
    });
    assert.equal(override.ok, true);
    if (!override.ok) return;
    assert.equal(override.procedure.createdAt, "2026-08-16T00:00:00.000Z");
  });

  it("fail-closed：数量不足 / 非 real / 重复事件 ID", () => {
    const one = inducePhase3ProcedureDraft([makeEvent(1)], DEFAULT_OPTIONS);
    assert.equal(one.ok, false);
    if (one.ok) return;
    assert.equal(one.reason, "not_enough_events");

    const synthetic = inducePhase3ProcedureDraft(
      [makeEvent(1, { provenance: "synthetic" }), makeEvent(2)],
      DEFAULT_OPTIONS,
    );
    assert.equal(synthetic.ok, false);
    if (synthetic.ok) return;
    assert.equal(synthetic.reason, "practice_event_not_real");

    const duplicated = inducePhase3ProcedureDraft(
      [makeEvent(9, { eventId: "obs-dup" }), makeEvent(9, { eventId: "obs-dup" })],
      DEFAULT_OPTIONS,
    );
    assert.equal(duplicated.ok, false);
    if (duplicated.ok) return;
    assert.equal(duplicated.reason, "not_enough_distinct_events");
  });

  it("fail-closed：同父绑定失配（id / revision / sourceHash 任一不同）", () => {
    const wrongId = inducePhase3ProcedureDraft(
      [makeEvent(1), makeEvent(2, { parentSkillId: `skill:${"f".repeat(64)}` })],
      DEFAULT_OPTIONS,
    );
    assert.equal(wrongId.ok, false);
    if (wrongId.ok) return;
    assert.equal(wrongId.reason, "parent_binding_mismatch");

    const wrongRevision = inducePhase3ProcedureDraft(
      [makeEvent(1), makeEvent(2, { parentSkillRevision: `rev:${"f".repeat(64)}` })],
      DEFAULT_OPTIONS,
    );
    assert.equal(wrongRevision.ok, false);
    if (wrongRevision.ok) return;
    assert.equal(wrongRevision.reason, "parent_binding_mismatch");

    const wrongSource = inducePhase3ProcedureDraft(
      [makeEvent(1), makeEvent(2, { sourceHash: `sha256:${"f".repeat(64)}` })],
      DEFAULT_OPTIONS,
    );
    assert.equal(wrongSource.ok, false);
    if (wrongSource.ok) return;
    assert.equal(wrongSource.reason, "parent_binding_mismatch");
  });

  it("fail-closed：covered step 缺失/失败、verifier 未 pass、attribution 未验证", () => {
    const noStep = inducePhase3ProcedureDraft(
      [
        makeEvent(1),
        makeEvent(2, {
          stepSummaries: [
            { stepId: "step-2", actor: "tool", operationClass: "execute-sql", outcome: "ok" },
          ],
        }),
      ],
      DEFAULT_OPTIONS,
    );
    assert.equal(noStep.ok, false);
    if (noStep.ok) return;
    assert.equal(noStep.reason, "practice_event_covered_step_unverified");

    const stepFailed = inducePhase3ProcedureDraft(
      [
        makeEvent(1),
        makeEvent(2, {
          attribution: "mixed",
          stepSummaries: [
            { stepId: "step-2", actor: "tool", operationClass: "detect-offset-pagination", outcome: "failed" },
          ],
        }),
      ],
      DEFAULT_OPTIONS,
    );
    assert.equal(stepFailed.ok, false);
    if (stepFailed.ok) return;
    assert.equal(stepFailed.reason, "practice_event_covered_step_unverified");

    const verifierUnknown = inducePhase3ProcedureDraft(
      [
        makeEvent(1),
        makeEvent(2, {
          attribution: "mixed",
          verifierResults: [{ verifierId: "phase3-pagination-structured-finding", result: "unknown" }],
        }),
      ],
      DEFAULT_OPTIONS,
    );
    assert.equal(verifierUnknown.ok, false);
    if (verifierUnknown.ok) return;
    assert.equal(verifierUnknown.reason, "practice_event_covered_step_unverified");

    const attributionMixed = inducePhase3ProcedureDraft(
      [makeEvent(1), makeEvent(2, { attribution: "mixed" })],
      DEFAULT_OPTIONS,
    );
    assert.equal(attributionMixed.ok, false);
    if (attributionMixed.ok) return;
    assert.equal(attributionMixed.reason, "practice_event_covered_step_unverified");
  });

  it("fail-closed：绑定哈希 / createdAt 格式坏、policy 非法事件", () => {
    const badRef = inducePhase3ProcedureDraft(
      [makeEvent(1), makeEvent(2)],
      { ...DEFAULT_OPTIONS, selectedReferenceHash: "not-a-hash" },
    );
    assert.equal(badRef.ok, false);
    if (badRef.ok) return;
    assert.equal(badRef.reason, "selected_reference_hash_invalid");

    const badPolicy = inducePhase3ProcedureDraft(
      [makeEvent(1), makeEvent(2)],
      { ...DEFAULT_OPTIONS, permissionPolicyHash: "xx" },
    );
    assert.equal(badPolicy.ok, false);
    if (badPolicy.ok) return;
    assert.equal(badPolicy.reason, "permission_policy_hash_invalid");

    // ADR-0011：effectless pilot 提供合法 hash 也必须拒绝（不得携带）。
    const forbiddenPolicy = inducePhase3ProcedureDraft(
      [makeEvent(1), makeEvent(2)],
      { ...DEFAULT_OPTIONS, permissionPolicyHash: POLICY_HASH },
    );
    assert.equal(forbiddenPolicy.ok, false);
    if (forbiddenPolicy.ok) return;
    assert.equal(forbiddenPolicy.reason, "permission_policy_hash_forbidden_for_effectless");

    const badCreated = inducePhase3ProcedureDraft(
      [makeEvent(1), makeEvent(2)],
      { ...DEFAULT_OPTIONS, createdAt: "yesterday" },
    );
    assert.equal(badCreated.ok, false);
    if (badCreated.ok) return;
    assert.equal(badCreated.reason, "created_at_invalid");

    const policyInvalid = inducePhase3ProcedureDraft(
      [makeEvent(1), makeEvent(2, { sensitivity: "confidential" })],
      DEFAULT_OPTIONS,
    );
    assert.equal(policyInvalid.ok, false);
    if (policyInvalid.ok) return;
    assert.equal(policyInvalid.reason, "practice_event_policy_invalid");
  });

  it("evidenceIds 保留来源：只含当次事件 ID，不丢失不添加", () => {
    const events = [makeEvent(11), makeEvent(12), makeEvent(13)];
    const result = inducePhase3ProcedureDraft(events, DEFAULT_OPTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const sourceIds = events.map((e) => e.eventId).sort();
    assert.deepEqual(result.procedure.evidenceIds, sourceIds);
    assert.deepEqual(result.fragment.evidenceIds, sourceIds);
    assert.equal(result.procedure.evidenceIds.length, events.length);
  });

  it("最小证据常量与契约一致（≥2）", () => {
    assert.equal(MIN_EVIDENCE_EVENTS, 2);
    assert.equal(INDUCED_OPERATION_CLASS, "detect-offset-pagination");
    assert.equal(INDUCED_VERIFIER_ID, "phase3-pagination-structured-finding");
  });
});
