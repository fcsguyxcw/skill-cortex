import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LEGACY_PLACEHOLDER_POLICY_HASH,
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
    // ADR-0011：effectless/permissionless ⇒ permissionPolicyHash 必须显式省略。
    assert.equal(first.sourceBindings.permissionPolicyHash, undefined);
    assert.equal(first.dependencyFingerprint.permissionPolicyHash, undefined);
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

  it("rejects any provided permissionPolicyHash for effectless procedure (incl. old 4f placeholder)", () => {
    const base = {
      parentSkillId: PARENT_SKILL_ID,
      parentSkillRevision: PARENT_SKILL_REVISION,
      skillMdHash: SKILL_HASH,
      selectedReferenceHash: REFERENCE_HASH,
      createdAt: "2026-08-14T00:00:00.000Z",
    };
    // ADR-0011 §1/§4：effectless 必须省略；合法 hash 也拒绝。
    assert.throws(
      () => buildPhase3ProcedureDraft({ ...base, permissionPolicyHash: POLICY_HASH }),
      /permission_policy_hash_forbidden_for_effectless/,
    );
    // 旧占位 `sha256:4f…`（64 hex）同样拒绝。
    assert.throws(
      () => buildPhase3ProcedureDraft({ ...base, permissionPolicyHash: "4f".repeat(32) }),
      /permission_policy_hash_forbidden_for_effectless/,
    );
    assert.throws(
      () => buildPhase3ProcedureDraft({ ...base, permissionPolicyHash: "not-a-hash" }),
      /permission_policy_hash_forbidden_for_effectless/,
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

    // effectless 且 current 提供 hash：procedure 未绑定 ⇒ 不构成约束（resolver 语义）。
    const extraCurrentPolicy = checkPhase3ProcedureBindings(procedure, {
      ...current(),
      permissionPolicyHash: POLICY_HASH,
    });
    assert.deepEqual(extraCurrentPolicy, { ok: true });
  });

  it("fails bindings when an effectless procedure carries a permissionPolicyHash (old placeholder artifact)", () => {
    // 直接构造旧形状 artifact（builder 已拒绝带 hash 的 effectless draft）：
    // 模拟“去占位前”携带 `sha256:4f…` 的 procedure，binding 必须 fail。
    const procedure = draft();
    const legacy = {
      ...procedure,
      sourceBindings: {
        ...procedure.sourceBindings,
        permissionPolicyHash: `sha256:${POLICY_HASH}`,
      },
      dependencyFingerprint: {
        ...procedure.dependencyFingerprint,
        permissionPolicyHash: `sha256:${POLICY_HASH}`,
      },
    };
    const placeholder = {
      ...procedure,
      sourceBindings: {
        ...procedure.sourceBindings,
        permissionPolicyHash: LEGACY_PLACEHOLDER_POLICY_HASH,
      },
      dependencyFingerprint: {
        ...procedure.dependencyFingerprint,
        permissionPolicyHash: LEGACY_PLACEHOLDER_POLICY_HASH,
      },
    };
    for (const legacyProcedure of [legacy, placeholder]) {
      const binding = checkPhase3ProcedureBindings(legacyProcedure, current());
      assert.equal(binding.ok, false);
      if (!binding.ok) {
        assert.equal(binding.reason, "dependency_mismatch");
        assert.ok(binding.mismatches.includes("permissionPolicyHash"));
      }
    }
  });

  it("fails bindings when a permission-declaring procedure binds the legacy placeholder on all three sides", () => {
    // ADR-0011 §2/§4：声明非空 effects/permissions 时，三方均为已知旧占位
    // `sha256:4f…` 仍不是真实 policy 指纹 ⇒ dependency_mismatch，不能通过。
    const procedure = draft();
    const declaring = {
      ...procedure,
      declaredEffects: ["analyze"],
      requiredPermissions: ["read-only-analysis"],
      sourceBindings: {
        ...procedure.sourceBindings,
        permissionPolicyHash: LEGACY_PLACEHOLDER_POLICY_HASH,
      },
      dependencyFingerprint: {
        ...procedure.dependencyFingerprint,
        permissionPolicyHash: LEGACY_PLACEHOLDER_POLICY_HASH,
      },
    };
    const binding = checkPhase3ProcedureBindings(declaring, {
      ...current(),
      permissionPolicyHash: LEGACY_PLACEHOLDER_POLICY_HASH,
    });
    assert.equal(binding.ok, false);
    if (!binding.ok) {
      assert.equal(binding.reason, "dependency_mismatch");
      assert.ok(binding.mismatches.includes("permissionPolicyHash"));
    }
  });

  it("tool schema hash does not depend on permissionPolicyHash", () => {
    const procedure = draft();
    // ADR-0011 §5：工具 schema hash 只由 reference + detector 版本派生，不依赖权限绑定。
    const changedReference = buildPhase3ProcedureDraft({
      ...current(),
      selectedReferenceHash: "b".repeat(64),
      createdAt: procedure.createdAt,
    });
    assert.ok(!Object.keys(procedure.dependencyFingerprint).includes("permissionPolicyHash"));
    assert.notEqual(
      changedReference.dependencyFingerprint.toolSchemaHash,
      procedure.dependencyFingerprint.toolSchemaHash,
    );
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
