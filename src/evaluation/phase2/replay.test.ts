import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import { validatePracticeEvent } from "../../practice/policy/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import {
  createDocxPilotEvent,
  DOCX_PILOT_DEPENDENCY_FINGERPRINT,
  DOCX_PILOT_EVENT,
  DOCX_PILOT_SKILL_ID,
  DOCX_PILOT_SKILL_REVISION,
  DOCX_PILOT_SOURCE_HASH_FULL,
  isFullSha256,
  replayDocxPilot,
} from "./replay.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const tempDirs: string[] = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function makeStore(): { store: PracticeStore; root: string } {
  const root = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-phase2-replay-"));
  tempDirs.push(root);
  return { store: new PracticeStore({ rootDir: root, projectRoot: PROJECT_ROOT }), root };
}

function policyNormalized(event: PracticeEvent): PracticeEvent {
  const policy = validatePracticeEvent(event);
  assert.equal(policy.ok, true);
  const normalized: PracticeEvent = {
    ...event,
    attribution: policy.attribution,
  };
  if (policy.failureClass !== "unknown") normalized.failureClass = policy.failureClass;
  if (policy.firstAttributableFailureStepId !== undefined) {
    normalized.firstAttributableFailureStepId = policy.firstAttributableFailureStepId;
  }
  return normalized;
}

describe("phase2 docx observation replay", () => {
  it("builds a deterministic, fully bound evaluation slow-path event", () => {
    const event = createDocxPilotEvent("phase2-docx-check");
    assert.deepEqual(createDocxPilotEvent("phase2-docx-check"), event);
    assert.equal(event.provenance, "evaluation");
    assert.equal(event.executionMode, "skill_md");
    assert.equal(event.parentSkillId, DOCX_PILOT_SKILL_ID);
    assert.match(event.parentSkillRevision, /^rev:[0-9a-f]{64}$/);
    assert.equal(event.sourceHash, DOCX_PILOT_SOURCE_HASH_FULL);
    assert.equal(isFullSha256(event.sourceHash), true);
    assert.equal(event.dependencyFingerprint?.sourceHash, event.sourceHash);
    assert.equal(isFullSha256(event.dependencyFingerprint?.toolSchemaHash ?? ""), true);
    assert.equal(isFullSha256(event.dependencyFingerprint?.permissionPolicyHash ?? ""), true);
    assert.deepEqual(event.dependencyFingerprint, DOCX_PILOT_DEPENDENCY_FINGERPRINT);

    assert.deepEqual(
      event.stepSummaries.map((step) => step.operationClass),
      [
        "docx-validate-read-only",
        "docx-unpack-project-temp-idempotent",
        "docx-text-readback-deterministic",
      ],
    );
    assert.equal(event.authorizationResults.length, 2);
    assert.ok(event.authorizationResults.every((result) => result.result === "unknown"));
    assert.equal(event.guardResults.length, 3);
    assert.ok(event.guardResults.every((result) => result.result === "unknown"));
    assert.equal(event.verifierResults.length, 2);
    assert.ok(event.verifierResults.every((verifier) => verifier.result === "unknown"));
    assert.equal(event.attribution, "unknown", "caller must not self-attest attribution");
    assert.equal(validatePracticeEvent(event).attribution, "mixed");
  });

  it("replays through policy and round-trips complete fields in evaluation partition only", async () => {
    const { store } = makeStore();
    const persisted = await replayDocxPilot(store, { eventId: "phase2-docx-roundtrip" });
    const source = createDocxPilotEvent("phase2-docx-roundtrip");

    assert.deepEqual(persisted, policyNormalized(source));
    assert.equal(persisted.provenance, "evaluation");
    assert.equal("failureClass" in persisted, false);
    assert.equal(persisted.attribution, "mixed");
    assert.deepEqual(
      await store.listProvenance(source.tenantScope, "evaluation"),
      [persisted],
    );
    assert.deepEqual(await store.queryEvidence(source.tenantScope), []);
  });

  it("requires explicit distinct IDs for repeated fixture replay and rejects accidental reuse", async () => {
    const { store } = makeStore();
    const first = await replayDocxPilot(store, { eventId: "phase2-docx-replay-a" });
    const second = await replayDocxPilot(store, { eventId: "phase2-docx-replay-b" });
    assert.notEqual(first.eventId, second.eventId);

    await assert.rejects(
      replayDocxPilot(store, { eventId: "phase2-docx-replay-a" }),
      /already exists/,
    );
    const events = await store.listProvenance(first.tenantScope, "evaluation");
    assert.deepEqual(
      events.map((event) => event.eventId),
      ["phase2-docx-replay-a", "phase2-docx-replay-b"],
    );
  });

  it("contains no raw task/path/secret and exposes no memory promotion API", async () => {
    const { store, root } = makeStore();
    const persisted = await replayDocxPilot(store, { eventId: "phase2-docx-safety" });
    const serialized = JSON.stringify(persisted);

    assert.ok(persisted.redactedTaskFeatures.every((feature) => feature.length <= 32));
    assert.doesNotMatch(serialized, /[A-Za-z]:\\(?:Users|Documents and Settings|Program Files)\\/i);
    assert.doesNotMatch(serialized, /(?:^|\s)\/(?:home|Users|root)\//);
    assert.doesNotMatch(serialized, /(?:api[_-]?key|password|bearer|private key|sk-[a-z0-9])/i);
    assert.ok(persisted.verifierResults.every((result) => result.observedEffect === "replay-not-executed"));
    assert.equal("procedureId" in persisted, false);
    assert.equal("proposeActivationUpdate" in store, false);
    assert.equal("proposeProcedure" in store, false);

    const hashDirs = await readdir(root);
    assert.equal(hashDirs.length, 1);
    const storedFiles = await readdir(path.join(root, hashDirs[0]!));
    assert.deepEqual(storedFiles.sort(), ["claims", "evaluation"]);
    const eventFile = path.join(root, hashDirs[0]!, "evaluation", "phase2-docx-safety.json");
    const onDisk = JSON.parse(await readFile(eventFile, "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.provenance, "evaluation");
    assert.equal("activationProfile" in onDisk, false);
    assert.equal("compiledProcedure" in onDisk, false);
  });

  it("uses a stable default fixture without executing docx helpers", () => {
    assert.deepEqual(DOCX_PILOT_EVENT, createDocxPilotEvent());
    assert.equal(DOCX_PILOT_EVENT.parentSkillRevision, DOCX_PILOT_SKILL_REVISION);
    assert.equal(DOCX_PILOT_EVENT.stepSummaries.every((step) => step.outcome === "unknown"), true);
  });
});
