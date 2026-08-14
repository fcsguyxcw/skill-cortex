import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import {
  classifyFailure,
  isProductionEligible,
  resolveAttribution,
  scanRedactedTaskFeatures,
  validatePracticeEvent,
} from "./index.ts";

const FULL_SHA256 = "a".repeat(64);

function baseEvent(overrides: Partial<PracticeEvent> = {}): PracticeEvent {
  return {
    schemaVersion: 1,
    eventId: "evt-1",
    occurredAt: "2026-08-14T00:00:00.000Z",
    tenantScope: "project:test",
    provenance: "real",
    parentSkillId: "skill:abc",
    parentSkillRevision: "rev:def",
    sourceHash: FULL_SHA256,
    candidateSkillIds: ["skill:abc"],
    selectedSkillIds: ["skill:abc"],
    executionMode: "skill_md",
    redactedTaskFeatures: ["summarize document"],
    stepSummaries: [{ stepId: "s1", actor: "agent", operationClass: "summarize", outcome: "ok" }],
    authorizationResults: [{ gateId: "g1", result: "approved" }],
    guardResults: [],
    verifierResults: [],
    attribution: "unknown",
    sensitivity: "none",
    retentionClass: "project_manual",
    ...overrides,
  };
}

describe("validatePracticeEvent — hard constraints & contract", () => {
  it("accepts a valid event with a full SHA-256 source hash", () => {
    const result = validatePracticeEvent(baseEvent());
    assert.equal(result.ok, true);
    assert.equal(result.attribution, "unknown");
    assert.equal(result.failureClass, "unknown");
  });

  it("does not throw for unknown, object, array, or nested malformed inputs", () => {
    const malformed: unknown[] = [
      undefined,
      null,
      42,
      "event",
      {},
      [],
      [baseEvent()],
      baseEvent({
        executionMode: ["skill_md"] as unknown as PracticeEvent["executionMode"],
        stepSummaries: [[]] as unknown as PracticeEvent["stepSummaries"],
        authorizationResults: [["approved"]] as unknown as PracticeEvent["authorizationResults"],
        guardResults: [["pass"]] as unknown as PracticeEvent["guardResults"],
        verifierResults: [["pass"]] as unknown as PracticeEvent["verifierResults"],
      }),
      baseEvent({
        stepSummaries: [{ stepId: "s1", actor: ["agent"], operationClass: "summarize", outcome: "ok" }] as unknown as PracticeEvent["stepSummaries"],
        authorizationResults: [{ gateId: "g1", result: { value: "approved" } }] as unknown as PracticeEvent["authorizationResults"],
        guardResults: [{ predicateId: "p1", phase: "precondition", result: ["pass"] }] as unknown as PracticeEvent["guardResults"],
        verifierResults: [{ verifierId: "v1", result: { value: "pass" } }] as unknown as PracticeEvent["verifierResults"],
      }),
    ];

    for (const event of malformed) {
      let result: ReturnType<typeof validatePracticeEvent> | undefined;
      assert.doesNotThrow(() => {
        result = validatePracticeEvent(event);
      });
      assert.ok(result);
      assert.equal(result.ok, false);
    }
  });

  it("rejects schemaVersion != 1", () => {
    const bad = { ...baseEvent(), schemaVersion: 2 } as unknown as PracticeEvent;
    assert.equal(validatePracticeEvent(bad).ok, false);
    assert.ok(validatePracticeEvent(bad).issues.some((i) => i.code === "schema_version"));
  });

  it("rejects sensitivity != none", () => {
    const result = validatePracticeEvent(baseEvent({ sensitivity: "internal" }));
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "sensitivity"));
  });

  it("rejects retentionClass != project_manual", () => {
    const result = validatePracticeEvent(baseEvent({ retentionClass: "other" }));
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "retention_class"));
  });

  it("rejects a short source hash", () => {
    const result = validatePracticeEvent(baseEvent({ sourceHash: "a".repeat(63) }));
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "source_hash_invalid"));
  });

  it("rejects malformed enum values and empty nested IDs", () => {
    const result = validatePracticeEvent(
      baseEvent({
        provenance: "live" as PracticeEvent["provenance"],
        executionMode: "llm" as PracticeEvent["executionMode"],
        attribution: "success" as PracticeEvent["attribution"],
        stepSummaries: [{ stepId: "", actor: "agent", operationClass: "x", outcome: "ok" }],
        authorizationResults: [{ gateId: "", result: "approved" }],
        guardResults: [{ predicateId: "", phase: "precondition", result: "pass" }],
        verifierResults: [{ verifierId: "", result: "pass" }],
      }),
    );
    assert.equal(result.ok, false);
    for (const code of [
      "provenance_invalid",
      "execution_mode_invalid",
      "attribution_invalid",
      "step_id_invalid",
      "gate_id_invalid",
      "guard_id_invalid",
      "verifier_id_invalid",
    ]) {
      assert.ok(result.issues.some((i) => i.code === code), code);
    }
  });

  it("enforces executionMode and procedureId consistency", () => {
    assert.equal(validatePracticeEvent(baseEvent({ executionMode: "skill_md" })).ok, true);
    assert.equal(
      validatePracticeEvent(baseEvent({ executionMode: "compiled_procedure", procedureId: "proc-1" })).ok,
      true,
    );

    const missingProcedure = validatePracticeEvent(
      baseEvent({ executionMode: "compiled_procedure" }),
    );
    assert.equal(missingProcedure.ok, false);
    assert.ok(missingProcedure.issues.some((i) => i.code === "procedure_id_required"));

    const unexpectedProcedure = validatePracticeEvent(
      baseEvent({ executionMode: "skill_md", procedureId: "proc-1" }),
    );
    assert.equal(unexpectedProcedure.ok, false);
    assert.ok(unexpectedProcedure.issues.some((i) => i.code === "procedure_id_mismatch"));
  });

  it("enforces ISO timestamps, tenant scopes, and bounded IDs", () => {
    const invalid = validatePracticeEvent(
      baseEvent({
        occurredAt: "2026-02-30T00:00:00.000Z",
        tenantScope: "org:outside",
        eventId: "event with spaces",
        parentSkillId: "skill/with-slash",
        parentSkillRevision: "revision with spaces",
        routeDecisionId: "route/with-slash",
      }),
    );
    assert.equal(invalid.ok, false);
    for (const code of [
      "occurred_at_invalid",
      "tenant_scope_invalid",
      "event_id_invalid",
      "parent_skill_id_invalid",
      "parent_skill_revision_invalid",
      "route_decision_id_invalid",
    ]) {
      assert.ok(invalid.issues.some((i) => i.code === code), code);
    }
  });

  it("keeps eventId compatible with the Store filename contract", () => {
    const result = validatePracticeEvent(baseEvent({ eventId: "event:with-colon" }));
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "event_id_invalid"));
  });
});

describe("scanRedactedTaskFeatures — minimization", () => {
  it("accepts safe features", () => {
    assert.deepEqual(scanRedactedTaskFeatures(["summarize", "merge pdf"]), []);
  });

  it("accepts a short feature and rejects complete English, over-token, and long Chinese tasks", () => {
    assert.deepEqual(scanRedactedTaskFeatures(["pdf"]), []);
    const issues = scanRedactedTaskFeatures([
      "Please summarize this document for the user.",
      "summarize the document for the user and save results",
      "请帮我把这份项目文档整理成一份结构清晰并且便于后续检索和复用的中文总结",
    ]);
    assert.equal(issues.length, 3);
    assert.ok(issues.every((issue) => issue.code === "feature_full_sentence"));
  });

  it("rejects newline, empty, overlong, and full-sentence features", () => {
    const issues = scanRedactedTaskFeatures([
      "line one\nline two",
      "   ",
      "x".repeat(121),
      "This is a full sentence. Here is another one.",
    ]);
    assert.equal(issues.length, 4);
    assert.ok(issues.some((i) => i.code === "feature_multiline"));
    assert.ok(issues.some((i) => i.code === "feature_empty"));
    assert.ok(issues.some((i) => i.code === "feature_too_long"));
    assert.ok(issues.some((i) => i.code === "feature_full_sentence"));
  });

  it("rejects api key / token / password / private key", () => {
    const issues = scanRedactedTaskFeatures([
      "sk-abc123def456ghi789jkl",
      "Bearer eyJhbGciOiJIUzI1NiJ9",
      "password=hunter2",
      "-----BEGIN RSA PRIVATE KEY-----",
      "ssh-rsa AAAAB3NzaC1yc2E",
    ]);
    assert.equal(issues.length, 5);
    assert.ok(issues.some((i) => i.code === "feature_secret"));
    assert.ok(issues.some((i) => i.code === "feature_private_key"));
  });

  it("rejects Windows user path and POSIX home path", () => {
    const issues = scanRedactedTaskFeatures([
      "C:\\Users\\alice\\secret.txt",
      "/home/alice/notes.md",
    ]);
    assert.equal(issues.length, 2);
    assert.ok(issues.every((i) => i.code === "feature_absolute_path"));
  });

  it("rejects other absolute and relative filesystem paths", () => {
    const issues = scanRedactedTaskFeatures([
      "D:\\workspace\\report.docx",
      "/tmp/report.docx",
      "../private/report.docx",
    ]);
    assert.deepEqual(
      issues.map((issue) => issue.code),
      ["feature_absolute_path", "feature_absolute_path", "feature_relative_path"],
    );
  });

  it("does not echo feature content in error messages", () => {
    const secret = "sk-abc123def456ghi789jkl";
    const issues = scanRedactedTaskFeatures([secret]);
    assert.equal(issues.length, 1);
    assert.ok(!issues[0]!.message.includes(secret));
  });
});

describe("free-text minimization in event fields", () => {
  it("rejects secrets and absolute paths in observedEffect", () => {
    const secret = "Bearer ultra-secret-token-value";
    const path = "C:\\Users\\alice\\private.txt";
    const result = validatePracticeEvent(
      baseEvent({
        verifierResults: [
          { verifierId: "v-secret", result: "pass", observedEffect: secret },
          { verifierId: "v-path", result: "pass", observedEffect: path },
        ],
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "observed_effect_secret"));
    assert.ok(result.issues.some((i) => i.code === "observed_effect_absolute_path"));
    const messages = result.issues.map((i) => i.message).join("\n");
    assert.ok(!messages.includes(secret));
    assert.ok(!messages.includes(path));
  });

  it("rejects secrets, paths, and raw output in environmentFingerprint and operationClass", () => {
    const envSecret = "password=hunter2";
    const envPath = "/home/alice/private.txt";
    const operationSecret = "token=short-lived-secret";
    const result = validatePracticeEvent(
      baseEvent({
        environmentFingerprint: envSecret,
        stepSummaries: [
          { stepId: "s-secret", actor: "agent", operationClass: operationSecret, outcome: "ok" },
          { stepId: "s-path", actor: "agent", operationClass: envPath, outcome: "ok" },
          { stepId: "s-output", actor: "tool", operationClass: "HTTP/1.1 500", outcome: "failed" },
        ],
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "environment_fingerprint_secret"));
    assert.ok(result.issues.some((i) => i.code === "step_operation_class_secret"));
    assert.ok(result.issues.some((i) => i.code === "step_operation_class_absolute_path"));
    assert.ok(result.issues.some((i) => i.code === "step_operation_class_raw_tool_output"));
    const messages = result.issues.map((i) => i.message).join("\n");
    assert.ok(!messages.includes(envSecret));
    assert.ok(!messages.includes(envPath));
    assert.ok(!messages.includes(operationSecret));

    const pathResult = validatePracticeEvent(
      baseEvent({ environmentFingerprint: envPath }),
    );
    assert.equal(pathResult.ok, false);
    assert.ok(pathResult.issues.some((i) => i.code === "environment_fingerprint_absolute_path"));
  });

  it("rejects malformed free-text types without throwing", () => {
    const result = validatePracticeEvent(
      baseEvent({
        environmentFingerprint: { os: "windows" } as unknown as string,
        verifierResults: [{ verifierId: "v1", result: "pass", observedEffect: ["output"] as unknown as string }],
        stepSummaries: [{ stepId: "s1", actor: "agent", operationClass: { kind: "run" } as unknown as string, outcome: "ok" }],
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "environment_fingerprint_invalid"));
    assert.ok(result.issues.some((i) => i.code === "observed_effect_invalid"));
    assert.ok(result.issues.some((i) => i.code === "step_operation_class_invalid"));
  });
});

describe("attribution", () => {
  it("verified requires a clean verifier pass", () => {
    assert.equal(
      resolveAttribution(baseEvent({ verifierResults: [{ verifierId: "v1", result: "pass" }] })),
      "verified_skill_effect",
    );
  });

  it("no verifier → unknown; a verified claim is rejected and downgraded", () => {
    const result = validatePracticeEvent(baseEvent({ attribution: "verified_skill_effect" }));
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "unverified_attribution"));
    assert.equal(result.attribution, "unknown");
  });

  it("verifier fail → mixed (never verified)", () => {
    assert.equal(
      resolveAttribution(baseEvent({ verifierResults: [{ verifierId: "v1", result: "fail" }] })),
      "mixed",
    );
  });

  it("postcondition guard fail blocks verified", () => {
    assert.equal(
      resolveAttribution(
        baseEvent({
          verifierResults: [{ verifierId: "v1", result: "pass" }],
          guardResults: [{ predicateId: "p1", phase: "postcondition", result: "fail" }],
        }),
      ),
      "mixed",
    );
  });

  it("a failed step blocks verified", () => {
    const result = validatePracticeEvent(
      baseEvent({
        stepSummaries: [{ stepId: "s1", actor: "procedure", operationClass: "run", outcome: "failed" }],
        verifierResults: [{ verifierId: "v1", result: "pass" }],
        attribution: "verified_skill_effect",
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "unverified_attribution"));
    assert.equal(result.attribution, "mixed");
  });
});

describe("classifyFailure", () => {
  it("classifies permission / tool / environment / user / guard / postcondition / procedure", () => {
    assert.equal(classifyFailure({ authorizationResults: [{ gateId: "g", result: "denied" }] }), "permission_denied");
    assert.equal(classifyFailure({ guardResults: [{ predicateId: "p", phase: "precondition", result: "fail" }] }), "precondition_mismatch");
    assert.equal(classifyFailure({ guardResults: [{ predicateId: "p", phase: "runtime", result: "fail" }] }), "runtime_guard_failure");
    assert.equal(classifyFailure({ guardResults: [{ predicateId: "p", phase: "postcondition", result: "fail" }] }), "postcondition_failure");
    assert.equal(classifyFailure({ verifierResults: [{ verifierId: "v", result: "fail" }] }), "postcondition_failure");
    assert.equal(classifyFailure({ stepSummaries: [{ stepId: "s", actor: "tool", operationClass: "run", outcome: "failed" }] }), "tool_failure");
    assert.equal(classifyFailure({ stepSummaries: [{ stepId: "s", actor: "tool", operationClass: "network_timeout", outcome: "failed" }] }), "environment_drift");
    assert.equal(classifyFailure({ stepSummaries: [{ stepId: "s", actor: "user", operationClass: "", outcome: "failed" }] }), "user_interruption");
    assert.equal(classifyFailure({ stepSummaries: [{ stepId: "s", actor: "procedure", operationClass: "run", outcome: "failed" }] }), "procedure_error");
  });

  it("returns unknown when evidence is insufficient (does not guess)", () => {
    assert.equal(classifyFailure({}), "unknown");
    assert.equal(
      classifyFailure({ stepSummaries: [{ stepId: "s", actor: "agent", operationClass: "", outcome: "failed" }] }),
      "unknown",
    );
  });
});

describe("firstAttributableFailureStepId", () => {
  it("accepts a reference to a failed step and preserves it", () => {
    const result = validatePracticeEvent(
      baseEvent({
        stepSummaries: [{ stepId: "s1", actor: "procedure", operationClass: "run", outcome: "failed" }],
        firstAttributableFailureStepId: "s1",
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.firstAttributableFailureStepId, "s1");
  });

  it("rejects a reference to a non-failed step", () => {
    const result = validatePracticeEvent(
      baseEvent({ firstAttributableFailureStepId: "s1" }), // s1 outcome is "ok"
    );
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "first_attributable_step_invalid"));
  });

  it("external failure is not attributed to the skill (no first step)", () => {
    const result = validatePracticeEvent(
      baseEvent({
        stepSummaries: [{ stepId: "s1", actor: "tool", operationClass: "run", outcome: "failed" }],
        attribution: "mixed",
      }),
    );
    assert.equal(result.failureClass, "tool_failure");
    assert.equal(result.firstAttributableFailureStepId, undefined);
  });
});

describe("production eligibility", () => {
  it("only real + policy-valid is production eligible", () => {
    assert.equal(isProductionEligible(baseEvent()), true);
    assert.equal(isProductionEligible(baseEvent({ provenance: "evaluation" })), false);
    assert.equal(isProductionEligible(baseEvent({ provenance: "synthetic" })), false);
    assert.equal(isProductionEligible(baseEvent({ provenance: "shadow" })), false);
    assert.equal(isProductionEligible(baseEvent({ sensitivity: "internal" })), false);
  });
});
