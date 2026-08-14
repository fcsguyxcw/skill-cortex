import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PAGINATION_DETECTOR_SCHEMA_VERSION,
  PAGINATION_DETECTOR_VERSION,
  buildPhase3ProcedureDraft,
  checkPhase3ProcedureBindings,
  detectPagination,
  transitionPhase3ProcedureValidation,
} from "./index.ts";

const SKILL_HASH = "8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830";
const REFERENCE_HASH = "73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const POLICY_HASH = "a".repeat(64);
const PARENT_SKILL_ID = "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2";
const PARENT_SKILL_REVISION = "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec";

function draft() {
  return buildPhase3ProcedureDraft({
    parentSkillId: PARENT_SKILL_ID,
    parentSkillRevision: PARENT_SKILL_REVISION,
    skillMdHash: SKILL_HASH,
    selectedReferenceHash: REFERENCE_HASH,
    permissionPolicyHash: POLICY_HASH,
    createdAt: "2026-08-14T00:00:00.000Z",
    evidenceIds: ["practice:offset-1"],
  });
}

function current() {
  return {
    parentSkillId: PARENT_SKILL_ID,
    parentSkillRevision: PARENT_SKILL_REVISION,
    skillMdHash: SKILL_HASH,
    selectedReferenceHash: REFERENCE_HASH,
    detectorSchemaVersion: PAGINATION_DETECTOR_SCHEMA_VERSION,
    detectorVersion: PAGINATION_DETECTOR_VERSION,
    permissionPolicyHash: POLICY_HASH,
  };
}

describe("bounded pagination detector", () => {
  it("covers the train query shapes", () => {
    assert.equal(
      detectPagination("SELECT * FROM posts ORDER BY id LIMIT 20 OFFSET 40;").class,
      "uses_offset",
    );
    assert.equal(
      detectPagination("SELECT * FROM posts WHERE id > $1 ORDER BY id LIMIT 20;").class,
      "uses_keyset",
    );
    assert.equal(
      detectPagination("SELECT * FROM posts WHERE author_id = $1;").class,
      "no_pagination",
    );
    assert.equal(
      detectPagination("SELECT id FROM posts ORDER BY created_at DESC LIMIT 10;").class,
      "no_pagination",
    );
  });

  it("supports bounded OFFSET clause order and standard FETCH form", () => {
    for (const sql of [
      "SELECT * FROM logs ORDER BY id OFFSET $1 LIMIT $2",
      "SELECT * FROM logs ORDER BY id OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY",
      "WITH p AS (SELECT * FROM logs LIMIT 3 OFFSET 6) SELECT * FROM p",
    ]) {
      const finding = detectPagination(sql);
      assert.equal(finding.class, "uses_offset");
      assert.ok(sql.includes(finding.evidence.matchText));
      assert.match(finding.evidence.matchText, /offset/i);
    }
  });

  it("skips strings, comments, dollar strings, and quoted identifiers", () => {
    for (const sql of [
      "SELECT 'OFFSET 7' AS note",
      "SELECT $$OFFSET 8$$ AS note",
      "SELECT id FROM logs -- OFFSET 9\n",
      "SELECT id /* OFFSET 10 */ FROM logs",
      'SELECT "OFFSET", id FROM logs',
      "SELECT `OFFSET`, id FROM logs",
      "SELECT [OFFSET], id FROM logs",
    ]) {
      assert.equal(detectPagination(sql).class, "no_pagination", sql);
    }
  });

  it("abstains on empty, malformed, unsupported, or multi-statement input", () => {
    for (const sql of ["", "SELECT * FROM logs OFFSET", "SELECT * FROM logs LIMIT", "SELECT @x", "SELECT 1; SELECT 2", "UPDATE jobs SET offset = 4"] ) {
      assert.equal(detectPagination(sql).class, "abstain", sql);
    }
  });
});

describe("procedure draft and bindings", () => {
  it("builds a complete deterministic draft without effects, permissions, or LLM holes", () => {
    const first = draft();
    const second = draft();
    assert.deepEqual(second, first);
    assert.equal(first.status, "draft");
    assert.equal(first.parentSkillId, PARENT_SKILL_ID);
    assert.equal(first.parentSkillRevision, PARENT_SKILL_REVISION);
    assert.equal(first.sourceBindings.skillMdHash, `sha256:${SKILL_HASH}`);
    assert.equal(first.sourceBindings.selectedReferenceHash, `sha256:${REFERENCE_HASH}`);
    assert.equal(first.sourceBindings.detectorSchemaVersion, PAGINATION_DETECTOR_SCHEMA_VERSION);
    assert.equal(first.sourceBindings.detectorVersion, PAGINATION_DETECTOR_VERSION);
    assert.equal(first.dependencyFingerprint.permissionPolicyHash, `sha256:${POLICY_HASH}`);
    assert.match(first.artifactHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(first.declaredEffects, []);
    assert.deepEqual(first.requiredPermissions, []);
    assert.deepEqual(first.llmHoles, []);
  });

  it("rejects malformed parent identities and timestamps", () => {
    const base = {
      parentSkillId: PARENT_SKILL_ID,
      parentSkillRevision: PARENT_SKILL_REVISION,
      skillMdHash: SKILL_HASH,
      selectedReferenceHash: REFERENCE_HASH,
      permissionPolicyHash: POLICY_HASH,
      createdAt: "2026-08-14T00:00:00.000Z",
    };
    assert.throws(
      () => buildPhase3ProcedureDraft({ ...base, parentSkillId: "installed:skill" }),
      /parent_skill_id_must_be_skill_sha256/,
    );
    assert.throws(
      () => buildPhase3ProcedureDraft({ ...base, parentSkillRevision: "1.1.0" }),
      /parent_skill_revision_must_be_rev_sha256/,
    );
    assert.throws(
      () => buildPhase3ProcedureDraft({ ...base, createdAt: "2026-08-14" }),
      /created_at_must_be_iso_timestamp/,
    );
  });

  it("changes the artifact hash when a bound source or detector input changes", () => {
    const baseline = draft();
    const changedReference = buildPhase3ProcedureDraft({
      ...current(),
      selectedReferenceHash: "b".repeat(64),
      createdAt: baseline.createdAt,
    });
    assert.notEqual(changedReference.artifactHash, baseline.artifactHash);
  });

  it("matches current bindings and fails closed on source or dependency drift", () => {
    const procedure = draft();
    assert.deepEqual(checkPhase3ProcedureBindings(procedure, current()), { ok: true });

    const sourceMismatch = checkPhase3ProcedureBindings(procedure, {
      ...current(),
      selectedReferenceHash: "b".repeat(64),
    });
    assert.equal(sourceMismatch.ok, false);
    if (!sourceMismatch.ok) assert.equal(sourceMismatch.reason, "source_mismatch");

    const dependencyMismatch = checkPhase3ProcedureBindings(procedure, {
      ...current(),
      permissionPolicyHash: "not-a-hash",
    });
    assert.equal(dependencyMismatch.ok, false);
    if (!dependencyMismatch.ok) assert.equal(dependencyMismatch.reason, "dependency_mismatch");
  });

  it("immutably transitions only a validated decision with a controlled report ID", () => {
    const original = draft();
    const validated = transitionPhase3ProcedureValidation(original, {
      decision: "validated",
      validationReportId: "validation:phase3-pagination-001",
    });
    assert.notEqual(validated, original);
    assert.equal(original.status, "draft");
    assert.equal(original.validationReportId, "pending:phase3-pagination-validation");
    assert.equal(validated.status, "validated");
    assert.equal(validated.validationReportId, "validation:phase3-pagination-001");

    for (const decision of ["draft", "canary", "active"] as const) {
      assert.throws(
        () => transitionPhase3ProcedureValidation(original, {
          decision,
          validationReportId: "validation:phase3-pagination-001",
        }),
        /requires_validated_decision/,
      );
    }
    assert.throws(
      () => transitionPhase3ProcedureValidation(original, {
        decision: "validated",
        validationReportId: "",
      }),
      /validation_report_id_invalid/,
    );
  });
});
