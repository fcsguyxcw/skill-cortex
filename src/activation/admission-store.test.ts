import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { LearningEvidenceAssessment, PracticeEvent } from "../core/contracts/index.ts";
import { PracticeStore } from "../practice/store/index.ts";
import { LearningAssessmentStore } from "./admission-store.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SKILL_ID = "skill:" + "1".repeat(64);
const REVISION = "rev:" + "2".repeat(64);
const SOURCE_HASH = "sha256:" + "3".repeat(64);
const TENANT = "project:assessment-test";

let tempRoot = "";
let seq = 0;

function event(eventId = "event-1", overrides: Partial<PracticeEvent> = {}): PracticeEvent {
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: "2026-08-23T00:00:00.000Z",
    tenantScope: TENANT,
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

function assessment(
  eventId = "event-1",
  overrides: Partial<LearningEvidenceAssessment> = {},
): LearningEvidenceAssessment {
  return {
    schemaVersion: 1,
    assessmentId: `assessment:${eventId}`,
    eventId,
    tenantScope: TENANT,
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

function makeStores(): { assessments: LearningAssessmentStore; events: PracticeStore; root: string } {
  seq += 1;
  const root = path.join(tempRoot, `case-${seq}`);
  return {
    root,
    assessments: new LearningAssessmentStore({
      rootDir: path.join(root, "assessments"),
      projectRoot: tempRoot,
    }),
    events: new PracticeStore({
      rootDir: path.join(root, "practice"),
      projectRoot: tempRoot,
    }),
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

before(() => {
  tempRoot = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-learning-assessment-store-"));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("LearningAssessmentStore", () => {
  it("append 后可跨实例按 event 读回并 list；未知字段不落盘", async () => {
    const { assessments, events, root } = makeStores();
    const observed = event();
    await events.append(observed);
    const withExtra = assessment() as LearningEvidenceAssessment & { rawTask?: string };
    withExtra.rawTask = "must-not-persist";
    await assessments.append(withExtra, events);

    const reloaded = new LearningAssessmentStore({
      rootDir: path.join(root, "assessments"),
      projectRoot: tempRoot,
    });
    const stored = await reloaded.getAssessment(TENANT, observed.eventId);
    assert.deepEqual(stored, assessment());
    assert.equal(JSON.stringify(stored).includes("rawTask"), false);
    assert.deepEqual(await reloaded.list(TENANT), [assessment()]);
  });

  it("assessmentId 与 eventId 均不可覆盖", async () => {
    const { assessments, events } = makeStores();
    await events.append(event("event-1"));
    await assessments.append(assessment("event-1"), events);
    await assert.rejects(
      assessments.append(assessment("event-1"), events),
      /learning_assessment_id_already_exists/,
    );

    await events.append(event("event-2"));
    await assert.rejects(
      assessments.append(
        assessment("event-2", { assessmentId: "assessment:event-1" }),
        events,
      ),
      /learning_assessment_id_already_exists/,
    );

    await assert.rejects(
      assessments.append(
        assessment("event-1", { assessmentId: "assessment:second-opinion" }),
        events,
      ),
      /learning_assessment_event_already_assessed/,
    );
  });

  it("仅绑定已落盘 real skill_md event；缺失/绑定失配均零 assessment", async () => {
    const { assessments, events } = makeStores();
    await assert.rejects(
      assessments.append(assessment("missing"), events),
      /learning_assessment_event_missing/,
    );

    await events.append(event());
    await assert.rejects(
      assessments.append(assessment("event-1", { sourceHash: "sha256:" + "9".repeat(64) }), events),
      /learning_assessment_event_binding_mismatch/,
    );
    assert.deepEqual(await assessments.list(TENANT), []);
  });

  it("tenant 隔离且 rootDir 必须位于 projectRoot", async () => {
    const { assessments, events } = makeStores();
    await events.append(event());
    await assessments.append(assessment(), events);
    assert.equal(await assessments.getAssessment("project:other", "event-1"), undefined);
    assert.throws(
      () => new LearningAssessmentStore({ rootDir: path.resolve(tempRoot, "..", "outside") , projectRoot: tempRoot }),
      /learning_assessment_store_root_must_be_inside_project_root/,
    );
  });

  it("损坏 JSON 读取 fail closed，错误不回显内容或路径", async () => {
    const { assessments, events, root } = makeStores();
    await events.append(event());
    await assessments.append(assessment(), events);
    const filePath = path.join(root, "assessments", sha(TENANT), "records", `${sha("event-1")}.json`);
    await writeFile(filePath, "{secret-content", "utf8");
    await assert.rejects(
      assessments.getAssessment(TENANT, "event-1"),
      (error: unknown) => {
        assert.match(String(error), /learning_assessment_store_corrupt: json_parse/);
        assert.equal(String(error).includes("secret-content"), false);
        assert.equal(String(error).includes(filePath), false);
        return true;
      },
    );
  });
});
