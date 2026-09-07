import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createEventBus,
  loadSkillsFromDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  ExtensionRunner,
  loadExtensions,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import { clearExtensionCache } from
  "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { buildSystemPrompt } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import type {
  ActivationProfile,
  LearningEvidenceAssessment,
  PracticeEvent,
} from "../../core/contracts/index.ts";
import { LearningAssessmentStore } from "../../activation/admission-store.ts";
import { LearningControlStore } from "../../activation/learning-control-store.ts";
import { ActivationProfileStore } from "../../activation/store.ts";
import { ExposureObservationStore } from "../../exposure/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import { defaultTenantScope } from "../../adapters/pi/practice-observer.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const ENTRY = path.join(PROJECT_ROOT, ".pi", "extensions", "skill-cortex", "index.ts");
const SKILL_ID = `skill:${"1".repeat(64)}`;
const REVISION = `rev:${"2".repeat(64)}`;
const SOURCE_HASH = `sha256:${"3".repeat(64)}`;
const EVENT_ID = "event-g4-production";
const ASSESSMENT_ID = "assessment:event-g4-production";
const PROFILE_ID = "profile:g4-production";

let fixtureRoot = "";
let originalCwd = "";
let modelRuntime: ModelRuntime;

before(async () => {
  originalCwd = process.cwd();
  fixtureRoot = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-g4-production-"));
  const skillDir = path.join(fixtureRoot, "pdf");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: pdf\ndescription: Read and merge PDF documents.\n---\n\n# PDF\n",
  );
  process.chdir(fixtureRoot);
  modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
    modelsPath: null,
    authPath: path.join(fixtureRoot, "auth.json"),
  });
});

after(async () => {
  process.chdir(originalCwd);
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function loadProductionRunner(): Promise<ExtensionRunner> {
  clearExtensionCache();
  const { extensions, errors, runtime } = await loadExtensions([ENTRY], fixtureRoot, createEventBus());
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1);
  return new ExtensionRunner(
    extensions,
    runtime,
    fixtureRoot,
    SessionManager.inMemory(fixtureRoot),
    new ModelRegistry(modelRuntime),
  );
}

async function runControl(
  runner: ExtensionRunner,
  name: string,
  params: Record<string, unknown> = {},
) {
  const definition = runner.getToolDefinition(name);
  assert.ok(definition, `${name} must be registered by production entry`);
  return definition.execute("g4-tool-call", params, undefined, undefined, runner.createContext());
}

function stores() {
  const tenantScope = defaultTenantScope(fixtureRoot);
  return {
    tenantScope,
    control: new LearningControlStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "control"),
      projectRoot: fixtureRoot,
      tenantScope,
    }),
    practice: new PracticeStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "practice"),
      projectRoot: fixtureRoot,
    }),
    assessments: new LearningAssessmentStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "learning-assessments"),
      projectRoot: fixtureRoot,
    }),
    activation: new ActivationProfileStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "activation"),
      projectRoot: fixtureRoot,
      tenantScope,
    }),
    exposure: new ExposureObservationStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "exposure"),
      projectRoot: fixtureRoot,
    }),
  };
}

async function seedEvidence(): Promise<void> {
  const { tenantScope, practice, assessments, activation } = stores();
  const event: PracticeEvent = {
    schemaVersion: 1,
    eventId: EVENT_ID,
    occurredAt: "2026-08-27T00:00:00.000Z",
    tenantScope,
    provenance: "real",
    parentSkillId: SKILL_ID,
    parentSkillRevision: REVISION,
    sourceHash: SOURCE_HASH,
    candidateSkillIds: [SKILL_ID],
    selectedSkillIds: [SKILL_ID],
    executionMode: "skill_md",
    redactedTaskFeatures: ["safe-feature"],
    stepSummaries: [{
      stepId: "step-1",
      actor: "agent",
      operationClass: "tool:load_skill",
      outcome: "ok",
    }],
    authorizationResults: [],
    guardResults: [],
    verifierResults: [{ verifierId: "verifier:g4", result: "pass" }],
    attribution: "verified_skill_effect",
    sensitivity: "none",
    retentionClass: "project_manual",
  };
  const assessment: LearningEvidenceAssessment = {
    schemaVersion: 1,
    assessmentId: ASSESSMENT_ID,
    eventId: EVENT_ID,
    tenantScope,
    parentSkillId: SKILL_ID,
    parentSkillRevision: REVISION,
    sourceHash: SOURCE_HASH,
    taskOutcome: "verified_success",
    skillContribution: "verified",
    evidenceKind: "positive",
    verifier: { kind: "independent_verifier", result: "pass" },
    assessedAt: "2026-08-27T00:01:00.000Z",
  };
  const profile: ActivationProfile = {
    schemaVersion: 1,
    profileId: PROFILE_ID,
    parentSkillId: SKILL_ID,
    parentSkillRevision: REVISION,
    status: "draft",
    learnedAliases: [],
    positiveExamples: [{
      cueId: "cue:g4-production",
      features: ["safe-feature"],
      evidenceIds: [EVENT_ID, ASSESSMENT_ID],
    }],
    nearMissExamples: [],
    environmentCues: [],
    createdAt: "2026-08-27T00:02:00.000Z",
    updatedAt: "2026-08-27T00:02:00.000Z",
  };
  await practice.append(event);
  await assessments.append(assessment, practice);
  await activation.save(profile, { trigger: "user" });
}

describe("D4/G4 controls through real production entry", () => {
  it("pause 跨 entry reload 持久化并阻止 observation；list/forget 真实级联；resume 再持久化", async () => {
    const first = await loadProductionRunner();
    const paused = await runControl(first, "skill_memory_set_learning", { enabled: false });
    assert.equal((paused.details as { learningEnabled: boolean }).learningEnabled, false);

    const second = await loadProductionRunner();
    const persistedPause = await runControl(second, "skill_memory_status");
    assert.equal((persistedPause.details as { learningEnabled: boolean }).learningEnabled, false,
      "new production entry instance must reload paused state");
    assert.equal((await stores().control.status()).learningEnabled, false);

    const { skills } = loadSkillsFromDir({ dir: fixtureRoot, source: "user" });
    const basePrompt = buildSystemPrompt({ cwd: fixtureRoot, skills, contextFiles: [] });
    await second.emitBeforeAgentStart("merge PDF documents", undefined, basePrompt, {
      cwd: fixtureRoot,
      skills,
      contextFiles: [],
    });
    await second.emit({ type: "agent_settled" });
    const pausedStores = stores();
    assert.deepEqual(await pausedStores.exposure.list(pausedStores.tenantScope), [],
      "paused production observer must not append exposure records");
    assert.deepEqual(await pausedStores.practice.queryEvidence(pausedStores.tenantScope), [],
      "paused production observer must not append practice records");

    await seedEvidence();
    const listed = await runControl(second, "skill_memory_list", { skill_id: SKILL_ID });
    const summaries = (listed.details as { summaries: Array<Record<string, unknown>> }).summaries;
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.profileId, PROFILE_ID);
    assert.equal("features" in summaries[0]!, false);
    assert.equal(JSON.stringify(summaries).includes("safe-feature"), false);

    const forgotten = await runControl(second, "skill_memory_forget", { evidence_id: EVENT_ID });
    assert.deepEqual(forgotten.details, {
      invalidatedEvidenceIds: [EVENT_ID],
      affectedProfileIds: [PROFILE_ID],
    });
    const afterForget = stores();
    assert.equal(await afterForget.practice.getEvent(afterForget.tenantScope, EVENT_ID), undefined);
    assert.equal(await afterForget.assessments.getAssessment(afterForget.tenantScope, EVENT_ID), undefined);
    assert.equal((await afterForget.activation.getProfile(PROFILE_ID))!.status, "suspended");

    await runControl(second, "skill_memory_set_learning", { enabled: true });
    const third = await loadProductionRunner();
    const persistedResume = await runControl(third, "skill_memory_status");
    assert.equal((persistedResume.details as { learningEnabled: boolean }).learningEnabled, true,
      "new production entry instance must reload resumed state");
  });
});
