import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { PracticeEvent, SkillRecord } from "../core/contracts/index.ts";
import { PracticeStore } from "../practice/store/index.ts";
import { LearningAssessmentStore } from "./admission-store.ts";
import {
  type PositiveContributionVerifier,
  verifyAndStorePositiveContribution,
} from "./contribution-verifier.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SKILL_ID = "skill:" + "1".repeat(64);
const OTHER_SKILL_ID = "skill:" + "9".repeat(64);
const REVISION = "rev:" + "2".repeat(64);
const SOURCE_HASH = "sha256:" + "3".repeat(64);
const TENANT = "project:contribution-verifier-test";

let tempRoot = "";
let seq = 0;

function parent(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    schemaVersion: 1,
    skillId: SKILL_ID,
    skillRevision: REVISION,
    name: "bounded-skill",
    description: "Fixture skill.",
    scope: "project",
    sourceLocator: "fixture",
    sourceHash: SOURCE_HASH,
    disableModelInvocation: false,
    declaredAliases: [],
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

function event(overrides: Partial<PracticeEvent> = {}): PracticeEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    occurredAt: "2026-08-23T00:00:00.000Z",
    tenantScope: TENANT,
    provenance: "real",
    parentSkillId: SKILL_ID,
    parentSkillRevision: REVISION,
    sourceHash: SOURCE_HASH,
    candidateSkillIds: [SKILL_ID],
    selectedSkillIds: [SKILL_ID],
    executionMode: "skill_md",
    redactedTaskFeatures: ["bounded-verifier-fixture"],
    stepSummaries: [{ stepId: "step-1", actor: "agent", operationClass: "bounded-operation", outcome: "ok" }],
    authorizationResults: [],
    guardResults: [],
    verifierResults: [{ verifierId: "bounded-result-check", result: "pass" }],
    attribution: "verified_skill_effect",
    sensitivity: "none",
    retentionClass: "project_manual",
    ...overrides,
  };
}

function verifier(overrides: Partial<PositiveContributionVerifier> = {}): PositiveContributionVerifier {
  return {
    verifierId: "trusted-bounded-verifier",
    parentSkillId: SKILL_ID,
    parentSkillRevision: REVISION,
    sourceHash: SOURCE_HASH,
    requiredOperationClass: "bounded-operation",
    requiredPracticeVerifierId: "bounded-result-check",
    verify: async () => "verified_contribution",
    ...overrides,
  };
}

function stores(): { events: PracticeStore; assessments: LearningAssessmentStore } {
  seq += 1;
  const root = path.join(tempRoot, `case-${seq}`);
  return {
    events: new PracticeStore({ rootDir: path.join(root, "practice"), projectRoot: tempRoot }),
    assessments: new LearningAssessmentStore({ rootDir: path.join(root, "assessments"), projectRoot: tempRoot }),
  };
}

before(() => {
  tempRoot = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-contribution-verifier-"));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("bounded contribution verifier", () => {
  it("仅 exact catalog + exact registered verifier + 独立复核通过时写入 positive assessment", async () => {
    const { events, assessments } = stores();
    const observed = event();
    await events.append(observed);

    const result = await verifyAndStorePositiveContribution({
      tenantScope: TENANT,
      eventId: observed.eventId,
      eventSource: events,
      assessmentStore: assessments,
      catalogRecords: [parent()],
      verifiers: [verifier()],
      assessedAt: () => "2026-08-23T00:01:00.000Z",
    });

    assert.equal(result.status, "stored");
    assert.equal(result.assessment?.taskOutcome, "verified_success");
    assert.equal(result.assessment?.skillContribution, "verified");
    assert.deepEqual(await assessments.getAssessment(TENANT, observed.eventId), result.assessment);
  });

  it("任意 catalog Skill 没有显式 verifier registration 时不可归因", async () => {
    const { events, assessments } = stores();
    const observed = event({
      parentSkillId: OTHER_SKILL_ID,
      candidateSkillIds: [OTHER_SKILL_ID],
      selectedSkillIds: [OTHER_SKILL_ID],
    });
    await events.append(observed);

    const result = await verifyAndStorePositiveContribution({
      tenantScope: TENANT,
      eventId: observed.eventId,
      eventSource: events,
      assessmentStore: assessments,
      catalogRecords: [parent({ skillId: OTHER_SKILL_ID })],
      verifiers: [verifier()],
    });

    assert.deepEqual(result, { status: "skipped", reason: "verifier_missing" });
    assert.deepEqual(await assessments.list(TENANT), []);
  });

  it("revision/source 漂移或所需 event evidence 不匹配时 fail closed，且不调用 verifier", async () => {
    for (const testCase of [
      { catalog: [parent({ skillRevision: "rev:" + "4".repeat(64) })], expected: "parent_binding_missing" },
      { catalog: [parent()], registered: verifier({ sourceHash: "sha256:" + "5".repeat(64) }), expected: "verifier_missing" },
      { catalog: [parent()], observed: event({ verifierResults: [{ verifierId: "other", result: "pass" }] }), expected: "required_practice_evidence_missing" },
    ] as const) {
      const { events, assessments } = stores();
      const observed = testCase.observed ?? event();
      let calls = 0;
      const registered = testCase.registered ?? verifier({
        verify: async () => {
          calls += 1;
          return "verified_contribution";
        },
      });
      await events.append(observed);
      const result = await verifyAndStorePositiveContribution({
        tenantScope: TENANT,
        eventId: observed.eventId,
        eventSource: events,
        assessmentStore: assessments,
        catalogRecords: testCase.catalog,
        verifiers: [registered],
      });
      assert.equal(result.reason, testCase.expected);
      assert.equal(calls, 0);
      assert.deepEqual(await assessments.list(TENANT), []);
    }
  });

  it("显式 verifier 返回 unverified 时保持零 assessment", async () => {
    const { events, assessments } = stores();
    const observed = event();
    await events.append(observed);
    const result = await verifyAndStorePositiveContribution({
      tenantScope: TENANT,
      eventId: observed.eventId,
      eventSource: events,
      assessmentStore: assessments,
      catalogRecords: [parent()],
      verifiers: [verifier({ verify: async () => "unverified" })],
    });
    assert.deepEqual(result, { status: "skipped", reason: "contribution_unverified" });
    assert.deepEqual(await assessments.list(TENANT), []);
  });

  it("同一 immutable binding 出现多个 verifier registration 时因歧义拒绝", async () => {
    const { events, assessments } = stores();
    const observed = event();
    await events.append(observed);
    const result = await verifyAndStorePositiveContribution({
      tenantScope: TENANT,
      eventId: observed.eventId,
      eventSource: events,
      assessmentStore: assessments,
      catalogRecords: [parent()],
      verifiers: [verifier(), verifier({ verifierId: "second-verifier" })],
    });
    assert.deepEqual(result, { status: "skipped", reason: "verifier_binding_ambiguous" });
    assert.deepEqual(await assessments.list(TENANT), []);
  });
});
