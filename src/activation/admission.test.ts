import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  LearningEvidenceAssessment,
  PracticeEvent,
  SkillRecord,
} from "../core/contracts/index.ts";
import { decideLearningAdmission } from "./admission.ts";

const SKILL_ID = "skill:" + "1".repeat(64);
const REVISION = "rev:" + "2".repeat(64);
const SOURCE_HASH = "sha256:" + "3".repeat(64);

function parentSkill(): SkillRecord {
  return {
    schemaVersion: 1,
    skillId: SKILL_ID,
    skillRevision: REVISION,
    name: "test-skill",
    description: "Test skill.",
    scope: "project",
    sourceLocator: "fixture",
    sourceHash: SOURCE_HASH,
    disableModelInvocation: false,
    declaredAliases: [],
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2026-08-23T00:00:00.000Z",
  };
}

function event(overrides: Partial<PracticeEvent> = {}): PracticeEvent {
  return {
    schemaVersion: 1,
    eventId: "event-1",
    occurredAt: "2026-08-23T00:00:00.000Z",
    tenantScope: "project:test",
    provenance: "real",
    parentSkillId: SKILL_ID,
    parentSkillRevision: REVISION,
    sourceHash: SOURCE_HASH,
    candidateSkillIds: [SKILL_ID],
    selectedSkillIds: [SKILL_ID],
    executionMode: "skill_md",
    redactedTaskFeatures: ["verified-feature"],
    stepSummaries: [{ stepId: "step-1", actor: "agent", operationClass: "skill-step", outcome: "ok" }],
    authorizationResults: [],
    guardResults: [],
    verifierResults: [{ verifierId: "result-check", result: "pass" }],
    attribution: "verified_skill_effect",
    sensitivity: "none",
    retentionClass: "project_manual",
    ...overrides,
  };
}

function assessment(overrides: Partial<LearningEvidenceAssessment> = {}): LearningEvidenceAssessment {
  return {
    schemaVersion: 1,
    assessmentId: "assessment:event-1",
    eventId: "event-1",
    tenantScope: "project:test",
    parentSkillId: SKILL_ID,
    parentSkillRevision: REVISION,
    sourceHash: SOURCE_HASH,
    taskOutcome: "verified_success",
    skillContribution: "verified",
    evidenceKind: "positive",
    verifier: { kind: "independent_verifier", result: "pass" },
    assessedAt: "2026-08-23T00:01:00.000Z",
    ...overrides,
  };
}

describe("Learning Admission", () => {
  it("独立评估绑定的 verified success + verified contribution 才准入 positive", () => {
    assert.deepEqual(
      decideLearningAdmission({ event: event(), parentSkill: parentSkill(), assessment: assessment() }),
      {
        decision: "positive",
        taskOutcome: "verified_success",
        skillContribution: "verified",
        reason: "verified_skill_contribution",
        evidenceIds: ["event-1", "assessment:event-1"],
      },
    );
  });

  it("缺少独立评估时 fail closed", () => {
    const decision = decideLearningAdmission({ event: event(), parentSkill: parentSkill() });
    assert.equal(decision.decision, "reject");
    assert.equal(decision.reason, "assessment_missing");
  });

  it("malformed assessment 不崩溃且拒绝", () => {
    for (const malformed of [
      null,
      { ...assessment(), verifier: { kind: "agent_self_report", result: "pass" } },
      { ...assessment(), taskOutcome: "success" },
    ]) {
      const decision = decideLearningAdmission({
        event: event(),
        parentSkill: parentSkill(),
        assessment: malformed as LearningEvidenceAssessment,
      });
      assert.equal(decision.decision, "reject");
      assert.equal(decision.reason, "assessment_invalid");
    }
  });

  it("mixed/unknown contribution 不得 consolidation", () => {
    for (const skillContribution of ["mixed", "unknown"] as const) {
      const decision = decideLearningAdmission({
        event: event(),
        parentSkill: parentSkill(),
        assessment: assessment({ skillContribution }),
      });
      assert.equal(decision.decision, "reject");
      assert.equal(decision.reason, "skill_contribution_unresolved");
    }
  });

  it("evaluation/synthetic 事件即使评估 pass 也拒绝", () => {
    for (const provenance of ["evaluation", "synthetic"] as const) {
      const decision = decideLearningAdmission({
        event: event({ provenance }),
        parentSkill: parentSkill(),
        assessment: assessment(),
      });
      assert.equal(decision.decision, "reject");
      assert.equal(decision.reason, "practice_event_not_real");
    }
  });

  it("父 revision/source 绑定失配时拒绝", () => {
    const decision = decideLearningAdmission({
      event: event(),
      parentSkill: parentSkill(),
      assessment: assessment({ sourceHash: "sha256:" + "4".repeat(64) }),
    });
    assert.equal(decision.decision, "reject");
    assert.equal(decision.reason, "assessment_binding_mismatch");
  });

  it("候选未选中且有 disproved 评估时准入 near-miss boundary", () => {
    const observed = event({ selectedSkillIds: [], attribution: "unknown" });
    const decision = decideLearningAdmission({
      event: observed,
      parentSkill: parentSkill(),
      assessment: assessment({ skillContribution: "disproved", evidenceKind: "near_miss" }),
    });
    assert.equal(decision.decision, "boundary");
    assert.equal(decision.reason, "verified_near_miss");
  });

  it("环境/工具等外部失败只能 observation，不能成为 boundary cue", () => {
    const observed = event({
      stepSummaries: [{ stepId: "step-1", actor: "tool", operationClass: "network-timeout", outcome: "failed" }],
      verifierResults: [{ verifierId: "result-check", result: "fail" }],
      attribution: "mixed",
      failureClass: "environment_drift",
    });
    const decision = decideLearningAdmission({
      event: observed,
      parentSkill: parentSkill(),
      assessment: assessment({
        taskOutcome: "verified_failure",
        skillContribution: "disproved",
        evidenceKind: "external_failure",
      }),
    });
    assert.equal(decision.decision, "reject");
    assert.equal(decision.reason, "external_failure_observation_only");
  });
});
