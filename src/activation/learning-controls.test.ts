import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ActivationProfile, LearningEvidenceAssessment, PracticeEvent } from "../core/contracts/index.ts";
import { PracticeStore } from "../practice/store/index.ts";
import { LearningAssessmentStore } from "./admission-store.ts";
import { LearningControlStore } from "./learning-control-store.ts";
import { LearningControls } from "./learning-controls.ts";
import { ActivationProfileStore } from "./store.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TENANT = "project:controls";
const SKILL_ID = "skill:" + "1".repeat(64);
const REVISION = "rev:" + "2".repeat(64);
const SOURCE = "sha256:" + "3".repeat(64);
let tempRoot = "";
let seq = 0;

before(() => {
  tempRoot = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-learning-controls-"));
});
after(async () => rm(tempRoot, { recursive: true, force: true }));

function observed(): PracticeEvent {
  return {
    schemaVersion: 1, eventId: "event-1", occurredAt: "2026-08-23T00:00:00.000Z",
    tenantScope: TENANT, provenance: "real", parentSkillId: SKILL_ID,
    parentSkillRevision: REVISION, sourceHash: SOURCE, candidateSkillIds: [SKILL_ID],
    selectedSkillIds: [SKILL_ID], executionMode: "skill_md", redactedTaskFeatures: ["safe-feature"],
    stepSummaries: [{ stepId: "s1", actor: "agent", operationClass: "skill-step", outcome: "ok" }],
    authorizationResults: [], guardResults: [],
    verifierResults: [{ verifierId: "v1", result: "pass" }], attribution: "verified_skill_effect",
    sensitivity: "none", retentionClass: "project_manual",
  };
}

function assessed(): LearningEvidenceAssessment {
  return {
    schemaVersion: 1, assessmentId: "assessment:event-1", eventId: "event-1", tenantScope: TENANT,
    parentSkillId: SKILL_ID, parentSkillRevision: REVISION, sourceHash: SOURCE,
    taskOutcome: "verified_success", skillContribution: "verified", evidenceKind: "positive",
    verifier: { kind: "independent_verifier", result: "pass" }, assessedAt: "2026-08-23T00:01:00.000Z",
  };
}

function profile(): ActivationProfile {
  return {
    schemaVersion: 1, profileId: "profile:controls", parentSkillId: SKILL_ID,
    parentSkillRevision: REVISION, status: "draft", learnedAliases: [],
    positiveExamples: [{ cueId: "cue:positive", features: ["safe-feature"], evidenceIds: ["event-1", "assessment:event-1"] }],
    nearMissExamples: [], environmentCues: [], createdAt: "2026-08-23T00:02:00.000Z",
    updatedAt: "2026-08-23T00:02:00.000Z",
  };
}

async function harness() {
  seq += 1;
  const root = path.join(tempRoot, `case-${seq}`);
  const practice = new PracticeStore({ rootDir: path.join(root, "practice"), projectRoot: tempRoot });
  const assessments = new LearningAssessmentStore({ rootDir: path.join(root, "assessments"), projectRoot: tempRoot });
  const activation = new ActivationProfileStore({ rootDir: path.join(root, "activation"), projectRoot: tempRoot, tenantScope: TENANT });
  const control = new LearningControlStore({ rootDir: path.join(root, "control"), projectRoot: tempRoot, tenantScope: TENANT });
  const controls = new LearningControls(control, assessments, practice, activation, TENANT);
  const event = observed();
  await practice.append(event);
  await assessments.append(assessed(), practice);
  await activation.save(profile(), { trigger: "procedure" });
  return { practice, assessments, activation, control, controls };
}

describe("LearningControls", () => {
  it("status + pause/resume 持久化，pause 不停用已有 overlay", async () => {
    const { controls } = await harness();
    assert.deepEqual(await controls.status(), {
      learningEnabled: true,
      staticDiscoveryEnabled: true,
      activeOverlayContinuesWhilePaused: true,
      activeProfileCount: 0,
      profileCount: 1,
    });
    await controls.setLearning(false);
    assert.equal((await controls.status()).learningEnabled, false);
    assert.equal((await controls.status()).profileCount, 1);
    await controls.setLearning(true);
    assert.equal((await controls.status()).learningEnabled, true);
  });

  it("list 只返回脱敏摘要，可按 skillId 过滤", async () => {
    const { controls } = await harness();
    const summaries = await controls.list();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.cueCount, 1);
    assert.deepEqual(summaries[0]!.evidenceIds, ["assessment:event-1", "event-1"]);
    assert.equal(JSON.stringify(summaries).includes("features"), false);
    assert.deepEqual(await controls.list({ skillId: "skill:" + "9".repeat(64) }), []);
  });

  it("forget evidence 级联删除 PracticeEvent/assessment 并 suspend profile", async () => {
    const { controls, practice, assessments, activation } = await harness();
    const result = await controls.forget({ evidenceId: "event-1" });
    assert.deepEqual(result.invalidatedEvidenceIds, ["event-1"]);
    assert.deepEqual(result.affectedProfileIds, ["profile:controls"]);
    assert.equal(await practice.getEvent(TENANT, "event-1"), undefined);
    assert.equal(await assessments.getAssessment(TENANT, "event-1"), undefined);
    assert.equal((await activation.getProfile("profile:controls"))!.status, "suspended");
  });

  it("forget assessment evidence id 保留 observation event，但删除 assessment 并级联 suspend", async () => {
    const { controls, practice, assessments, activation } = await harness();
    const result = await controls.forget({ evidenceId: "assessment:event-1" });
    assert.deepEqual(result.invalidatedEvidenceIds, ["assessment:event-1"]);
    assert.deepEqual(result.affectedProfileIds, ["profile:controls"]);
    assert.ok(await practice.getEvent(TENANT, "event-1"), "删除 assessment 不应删除原始 observation");
    assert.equal(await assessments.getAssessment(TENANT, "event-1"), undefined);
    assert.equal((await activation.getProfile("profile:controls"))!.status, "suspended");
  });

  it("forget profile 进入不可恢复 retired tombstone，重复调用幂等", async () => {
    const { controls, activation } = await harness();
    assert.deepEqual((await controls.forget({ profileId: "profile:controls" })).affectedProfileIds, ["profile:controls"]);
    assert.equal((await activation.getProfile("profile:controls"))!.status, "retired");
    assert.deepEqual(await controls.forget({ profileId: "profile:controls" }), {
      invalidatedEvidenceIds: [], affectedProfileIds: [],
    });
  });
});
