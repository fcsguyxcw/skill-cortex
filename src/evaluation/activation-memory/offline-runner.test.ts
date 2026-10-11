import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SkillRecord } from "../../core/contracts/index.ts";
import type {
  ActivationMemoryEvalCase,
  ActivationMemoryExperienceCase,
  ActivationMemoryNegativeControlCase,
  ActivationMemoryTargetSkill,
} from "./cases.ts";
import {
  ACTIVATION_MEMORY_CALIBRATION_CASES,
  ACTIVATION_MEMORY_EXPERIENCE_CASES,
  ACTIVATION_MEMORY_HELDOUT_CASES,
  ACTIVATION_MEMORY_TARGET_SKILLS,
} from "./cases.ts";
import {
  formEvaluationActivationMemory,
  measureEvaluationFormationCueLeakage,
  verifyEvaluationFormationArtifact,
} from "./formation.ts";
import { runActivationMemoryNegativeControls } from "./negative-controls.ts";
import { runActivationMemoryOfflineCalibration } from "./offline-runner.ts";

const CHART_ID = `skill:${"1".repeat(64)}`;
const CHART_REV = `rev:${"2".repeat(64)}`;
const SECURITY_ID = `skill:${"3".repeat(64)}`;
const SECURITY_REV = `rev:${"4".repeat(64)}`;

const TARGETS: readonly ActivationMemoryTargetSkill[] = Object.freeze([
  Object.freeze({ key: "chart", name: "chart-visualization", skillId: CHART_ID, skillRevision: CHART_REV, earlyExperienceLanguage: "zh" as const }),
  Object.freeze({ key: "security", name: "security-auditor", skillId: SECURITY_ID, skillRevision: SECURITY_REV, earlyExperienceLanguage: "zh" as const }),
]);

const EXPERIENCES: readonly ActivationMemoryExperienceCase[] = Object.freeze([
  experience("E-chart-1", CHART_ID, CHART_REV, 1, "制作雷达图图片"),
  experience("E-chart-2", CHART_ID, CHART_REV, 2, "绘制渠道漏斗图"),
  experience("E-security-1", SECURITY_ID, SECURITY_REV, 1, "审查认证漏洞风险"),
  experience("E-security-2", SECURITY_ID, SECURITY_REV, 2, "检查令牌泄露问题"),
]);

const CATALOG: readonly SkillRecord[] = Object.freeze([
  record(CHART_ID, CHART_REV, "chart-visualization", "Render charts and data visualizations as image artifacts."),
  record(SECURITY_ID, SECURITY_REV, "security-auditor", "Audit code for authentication and security vulnerabilities."),
]);

const CALIBRATION_CASES: readonly ActivationMemoryEvalCase[] = Object.freeze([
  evalCase("C-chart", "calibration", "请绘制一张雷达图", [CHART_ID]),
  evalCase("C-security", "calibration", "Audit authentication vulnerabilities", [SECURITY_ID], "single", "en"),
  evalCase("C-multi", "calibration", "请绘制雷达图并审查认证漏洞", [CHART_ID, SECURITY_ID], "multi"),
  evalCase("C-no-skill", "calibration", "雷达这个词是什么意思", [], "no_skill"),
]);

describe("activation-memory evaluation formation", () => {
  it("forms deterministic M1 and M2 draft profiles from nested experience prefixes", () => {
    const m1 = formEvaluationActivationMemory({ producer: "naive", exposure: 1, targets: TARGETS, experiences: EXPERIENCES });
    const m2 = formEvaluationActivationMemory({ producer: "verified", exposure: 1, targets: TARGETS, experiences: EXPERIENCES });
    assert.equal(m1.sourceMode, "evaluation_fixture");
    assert.equal(m1.persistenceEligibility, "never");
    assert.equal(m2.persistenceEligibility, "never");
    assert.equal(m1.inputExperienceIds.length, 2);
    assert.equal(m2.inputExperienceIds.length, 2);
    assert.ok(m1.profiles.every((profile) => profile.status === "draft"));
    assert.ok(m2.profiles.every((profile) => profile.status === "draft"));
    assert.ok(m1.profiles.every((profile) => profile.learnedAliases.length === 1 && profile.positiveExamples.length === 0));
    assert.ok(m2.profiles.every((profile) => profile.learnedAliases.length === 0 && profile.positiveExamples.length === 1));
    assert.equal(JSON.stringify(m2).includes("制作雷达图图片"), false, "M2 不保存完整 fixture query");

    const replay = formEvaluationActivationMemory({
      producer: "verified",
      exposure: 1,
      targets: [...TARGETS].reverse(),
      experiences: [...EXPERIENCES].reverse(),
    });
    assert.equal(replay.artifactHash, m2.artifactHash);
    assert.equal(verifyEvaluationFormationArtifact(replay), true);
    assert.equal(verifyEvaluationFormationArtifact({ ...replay, exposure: 2 }), false);
  });

  it("uses exposure 0 as no-memory even for a memory producer", () => {
    const artifact = formEvaluationActivationMemory({ producer: "verified", exposure: 0, targets: TARGETS, experiences: EXPERIENCES });
    assert.equal(artifact.profiles.length, 0);
    assert.equal(artifact.inputExperienceIds.length, 0);
    assert.equal(artifact.persistenceEligibility, "none");
  });

  it("keeps formed M1/M2 cues below leakage thresholds on the current development fixture", () => {
    const evaluationCases = [...ACTIVATION_MEMORY_CALIBRATION_CASES, ...ACTIVATION_MEMORY_HELDOUT_CASES];
    for (const producer of ["naive", "verified"] as const) {
      const artifact = formEvaluationActivationMemory({
        producer,
        exposure: 8,
        targets: ACTIVATION_MEMORY_TARGET_SKILLS,
        experiences: ACTIVATION_MEMORY_EXPERIENCE_CASES,
      });
      const leakage = measureEvaluationFormationCueLeakage(artifact, evaluationCases);
      assert.equal(leakage.passed, true, `${producer}: ${JSON.stringify(leakage.violations)}`);
      assert.equal(leakage.comparedPairCount, 3_072);
    }
  });
});

describe("activation-memory negative controls", () => {
  it("passes shuffled, unverified, stale, deleted-evidence, cross-scope, and near-miss controls", () => {
    const controls: readonly ActivationMemoryNegativeControlCase[] = Object.freeze([
      control("N1", "shuffled_profile", CHART_ID, "no_cross_task_transfer"),
      control("N2", "unverified_success", SECURITY_ID, "no_active_overlay"),
      control("N3", "stale_revision", CHART_ID, "fallback_baseline"),
      control("N4", "deleted_evidence", SECURITY_ID, "fallback_baseline"),
      control("N5", "cross_scope", CHART_ID, "fallback_baseline"),
      control("N6", "near_miss_contamination", SECURITY_ID, "no_cross_task_transfer"),
    ]);
    const report = runActivationMemoryNegativeControls({
      catalog: CATALOG,
      targets: TARGETS,
      experiences: EXPERIENCES,
      controls,
      topK: 2,
      memoryBoost: 5,
      nearMissPenalty: 1,
    });
    assert.equal(report.controlCount, 6);
    assert.equal(report.allPassed, true, JSON.stringify(report.results));
    assert.ok(report.results.every((item) => item.observedOutcome === item.expectedOutcome));
    assert.equal(JSON.stringify(report).includes("制作雷达图图片"), false);
  });
});

describe("activation-memory six-condition offline runner", () => {
  it("runs A/B/C1/C2/D1/D2 and lets evaluation memory add a static miss", () => {
    const report = runActivationMemoryOfflineCalibration({
      catalog: CATALOG,
      targets: TARGETS,
      experiences: EXPERIENCES,
      cases: CALIBRATION_CASES,
      exposure: 1,
      topK: 2,
      memoryBoost: 5,
      nearMissPenalty: 1,
    });
    assert.deepEqual(report.conditions.map((item) => item.condition.id), ["A", "B", "C1", "C2", "D1", "D2"]);
    assert.equal(report.conditions[0]!.formation.profileCount, 0);
    assert.equal(report.conditions[1]!.formation.profileCount, 0);
    assert.ok(report.conditions.slice(2).every((item) => item.formation.profileCount === 2));
    assert.ok(report.conditions.slice(2).every((item) => item.formation.persistenceEligibility === "never"));

    for (const id of ["C1", "C2", "D1", "D2"] as const) {
      const condition = report.conditions.find((item) => item.condition.id === id)!;
      assert.ok(condition.cases[0]!.candidateSkillIds.includes(CHART_ID));
      assert.ok(condition.cases[0]!.learnedCandidateSkillIds.includes(CHART_ID));
      assert.ok(condition.cases[1]!.candidateSkillIds.includes(SECURITY_ID));
    }
    assert.equal(JSON.stringify(report).includes("请绘制一张雷达图"), false, "报告不保存 query");
    const c2 = report.conditions.find((item) => item.condition.id === "C2")!;
    assert.equal(c2.formation.positiveExampleCount, 2);
    assert.equal(c2.formation.evidenceComplete, true);
    assert.equal(c2.formation.parentRevisionBound, true);
    assert.equal(c2.metrics.overall.caseCount, 4);
    assert.equal(c2.metrics.zh.caseCount, 3);
    assert.equal(c2.metrics.en.caseCount, 1);
    assert.equal(c2.metrics.multi.multiSkillCaseCount, 1);
    assert.equal(c2.metrics.multi.multiSkillFullSetAvailability, 1);
    assert.equal(c2.metrics.noSkill.noSkillCaseCount, 1);
    assert.equal(c2.metrics.overall.staticGoldPreservationRate, 1);
  });

  it("rejects held-out before the explicit post-freeze entry point", () => {
    const heldout = [evalCase("H1", "heldout", "请绘制一张雷达图", [CHART_ID])];
    assert.throws(
      () => runActivationMemoryOfflineCalibration({
        catalog: CATALOG,
        targets: TARGETS,
        experiences: EXPERIENCES,
        cases: heldout,
        exposure: 1,
        topK: 2,
        memoryBoost: 5,
        nearMissPenalty: 1,
      }),
      /activation_memory_heldout_not_allowed_before_freeze/,
    );
  });

  it("fails before retrieval when a formed cue leaks an evaluation query", () => {
    const leaked = [evalCase("C-leaked", "calibration", "制作雷达图图片", [CHART_ID])];
    assert.throws(
      () => runActivationMemoryOfflineCalibration({
        catalog: CATALOG,
        targets: TARGETS,
        experiences: EXPERIENCES,
        cases: leaked,
        exposure: 1,
        topK: 2,
        memoryBoost: 5,
        nearMissPenalty: 1,
      }),
      /activation_memory_cue_leakage_detected/,
    );
  });

  it("fails closed on target revision drift", () => {
    const drifted = [{ ...TARGETS[0]!, skillRevision: `rev:${"9".repeat(64)}` }, TARGETS[1]!];
    assert.throws(
      () => runActivationMemoryOfflineCalibration({
        catalog: CATALOG,
        targets: drifted,
        experiences: EXPERIENCES,
        cases: CALIBRATION_CASES,
        exposure: 1,
        topK: 2,
        memoryBoost: 5,
        nearMissPenalty: 1,
      }),
      /activation_memory_target_revision_mismatch/,
    );
  });
});

function experience(id: string, targetSkillId: string, targetSkillRevision: string, ordinal: number, query: string): ActivationMemoryExperienceCase {
  return Object.freeze({ id, targetSkillId, targetSkillRevision, ordinal, language: "zh", query, provenance: "evaluation_fixture", expectedAttribution: "positive" });
}

function evalCase(
  id: string,
  partition: "calibration" | "heldout",
  query: string,
  goldSkillIds: readonly string[],
  labelType: "single" | "multi" | "no_skill" = "single",
  language: "zh" | "en" = "zh",
): ActivationMemoryEvalCase {
  return Object.freeze({ id, partition, language, labelType, query, goldSkillIds: Object.freeze([...goldSkillIds]), hardConfuser: true });
}

function record(skillId: string, skillRevision: string, name: string, description: string): SkillRecord {
  return Object.freeze({
    schemaVersion: 1,
    skillId,
    skillRevision,
    name,
    description,
    scope: "project",
    sourceLocator: `D:/fixture/${name}/SKILL.md`,
    sourceHash: `sha256:${"a".repeat(64)}`,
    disableModelInvocation: false,
    declaredAliases: [],
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2000-01-01T00:00:00.000Z",
  });
}

function control(
  id: string,
  kind: ActivationMemoryNegativeControlCase["kind"],
  targetSkillId: string,
  expectedOutcome: ActivationMemoryNegativeControlCase["expectedOutcome"],
): ActivationMemoryNegativeControlCase {
  return Object.freeze({ id, kind, targetSkillId, expectedOutcome });
}
