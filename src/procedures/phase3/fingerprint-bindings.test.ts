/**
 * Phase 5 收尾 —— conditional fingerprint binding invariant validator 测试。
 *
 * 数据合同 §3.2 + ADR-0011：
 * - llmHoles.length > 0 ⇒ modelId + promptHash 必须存在且合法非空；
 * - declaredEffects/requiredPermissions 非空 ⇒ permissionPolicyHash 必填且真实指纹
 *   （缺失/格式非法/旧占位 sha256:4f… ⇒ fail-closed）；
 * - effectless + permissionless ⇒ permissionPolicyHash 必须显式省略；
 * - 纯确定性 artifact（无 llmHoles）不强制绑定 model/prompt（绑定了也不算错，
 *   字段存在即约束——diff 语义不变）；
 * - diffProcedureDependencies 入口调用 validator：违反 invariant ⇒ throw 受控错误，
 *   不得因「字段未绑定 ⇒ 不构成约束」的 diff 语义静默绕过失效。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompiledProcedure } from "../../core/contracts/index.ts";
import {
  LEGACY_PLACEHOLDER_POLICY_HASH,
  buildPhase3ProcedureDraft,
  transitionPhase3ProcedureValidation,
} from "./index.ts";
import { validateFingerprintBindings } from "./fingerprint-bindings.ts";
import { diffProcedureDependencies } from "./dependency-diff.ts";

const SKILL_HASH = "8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830";
const REFERENCE_HASH = "73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const PARENT_SKILL_ID = "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2";
const PARENT_SKILL_REVISION = "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec";
const VALIDATION_REPORT = "validation:phase3-pagination-p3-gate-2026-08-15";
const POLICY_HASH = `sha256:${"33".repeat(32)}`;
const MODEL_ID = "model:test-gpt-4o";
const PROMPT_HASH = `sha256:${"44".repeat(32)}`;

function baseProcedure(): CompiledProcedure {
  const draft = buildPhase3ProcedureDraft({
    parentSkillId: PARENT_SKILL_ID,
    parentSkillRevision: PARENT_SKILL_REVISION,
    skillMdHash: SKILL_HASH,
    selectedReferenceHash: REFERENCE_HASH,
    createdAt: "2026-08-14T00:00:00.000Z",
    evidenceIds: ["practice:offset-1"],
  });
  return transitionPhase3ProcedureValidation(draft, {
    decision: "validated",
    validationReportId: VALIDATION_REPORT,
  });
}

/** 覆盖 fields（llmHoles/declaredEffects/requiredPermissions/dependencyFingerprint）。 */
function withOverrides(
  procedure: CompiledProcedure,
  overrides: Partial<
    Pick<CompiledProcedure, "llmHoles" | "declaredEffects" | "requiredPermissions">
  > & { fingerprint?: Partial<CompiledProcedure["dependencyFingerprint"]> },
): CompiledProcedure {
  return {
    ...procedure,
    ...(overrides.llmHoles !== undefined ? { llmHoles: overrides.llmHoles } : {}),
    ...(overrides.declaredEffects !== undefined ? { declaredEffects: overrides.declaredEffects } : {}),
    ...(overrides.requiredPermissions !== undefined ? { requiredPermissions: overrides.requiredPermissions } : {}),
    dependencyFingerprint: {
      ...procedure.dependencyFingerprint,
      ...(overrides.fingerprint ?? {}),
    },
  };
}

function assertIssues(result: ReturnType<typeof validateFingerprintBindings>, codes: string[]): void {
  assert.equal(result.ok, false, `必须拒绝：${codes.join(",")}`);
  if (!result.ok) {
    const actual = result.issues.map((issue) => issue.code);
    for (const code of codes) assert.ok(actual.includes(code), `缺少 issue: ${code}（实际 ${actual}）`);
  }
}

describe("fingerprint binding invariant：合法构造", () => {
  it("effectless + permissionless + 省略 policy + 无 llmHoles ⇒ ok（pagination 基线）", () => {
    assert.deepEqual(validateFingerprintBindings(baseProcedure()), { ok: true });
  });

  it("声明 effects ⇒ 绑定合法 policy hash ⇒ ok", () => {
    const procedure = withOverrides(baseProcedure(), {
      declaredEffects: ["detect-pagination"],
      fingerprint: { permissionPolicyHash: POLICY_HASH },
    });
    assert.deepEqual(validateFingerprintBindings(procedure), { ok: true });
  });

  it("声明 requiredPermissions ⇒ 绑定合法 policy hash ⇒ ok", () => {
    const procedure = withOverrides(baseProcedure(), {
      requiredPermissions: ["read:sql"],
      fingerprint: { permissionPolicyHash: POLICY_HASH },
    });
    assert.deepEqual(validateFingerprintBindings(procedure), { ok: true });
  });

  it("含 llmHoles ⇒ 绑定 modelId + promptHash ⇒ ok", () => {
    const procedure = withOverrides(baseProcedure(), {
      llmHoles: [
        {
          holeId: "hole-1",
          purpose: "ambiguous classification edge case",
          inputBoundary: [],
          outputSchema: {},
        },
      ],
      fingerprint: { modelId: MODEL_ID, promptHash: PROMPT_HASH },
    });
    assert.deepEqual(validateFingerprintBindings(procedure), { ok: true });
  });

  it("纯确定性（无 llmHoles）额外绑定 model/prompt 不算错（字段存在即约束，diff 语义不变）", () => {
    const procedure = withOverrides(baseProcedure(), {
      fingerprint: { modelId: MODEL_ID, promptHash: PROMPT_HASH },
    });
    assert.deepEqual(validateFingerprintBindings(procedure), { ok: true });
  });
});

describe("fingerprint binding invariant：fail-closed", () => {
  it("含 llmHoles 但缺 modelId ⇒ llm_holes_require_model_id", () => {
    const procedure = withOverrides(baseProcedure(), {
      llmHoles: [{ holeId: "hole-1", purpose: "p", inputBoundary: [], outputSchema: {} }],
      fingerprint: { promptHash: PROMPT_HASH }, // modelId 缺失
    });
    assertIssues(validateFingerprintBindings(procedure), ["llm_holes_require_model_id"]);
  });

  it("含 llmHoles 但缺 promptHash ⇒ llm_holes_require_prompt_hash", () => {
    const procedure = withOverrides(baseProcedure(), {
      llmHoles: [{ holeId: "hole-1", purpose: "p", inputBoundary: [], outputSchema: {} }],
      fingerprint: { modelId: MODEL_ID }, // promptHash 缺失
    });
    assertIssues(validateFingerprintBindings(procedure), ["llm_holes_require_prompt_hash"]);
  });

  it("含 llmHoles 但 modelId/promptHash 为空串 ⇒ 拒绝", () => {
    const procedure = withOverrides(baseProcedure(), {
      llmHoles: [{ holeId: "hole-1", purpose: "p", inputBoundary: [], outputSchema: {} }],
      fingerprint: { modelId: "   ", promptHash: "" },
    });
    assertIssues(validateFingerprintBindings(procedure), [
      "llm_holes_require_model_id",
      "llm_holes_require_prompt_hash",
    ]);
  });

  it("声明权限但缺 permissionPolicyHash ⇒ declared_permissions_require_policy_hash", () => {
    const procedure = withOverrides(baseProcedure(), { declaredEffects: ["detect-pagination"] });
    assertIssues(validateFingerprintBindings(procedure), ["declared_permissions_require_policy_hash"]);
  });

  it("声明权限但 policy hash 格式非法 ⇒ declared_permissions_require_policy_hash", () => {
    for (const bad of ["sha256:zz", "not-a-hash", "abc", ""]) {
      const procedure = withOverrides(baseProcedure(), {
        declaredEffects: ["detect-pagination"],
        fingerprint: { permissionPolicyHash: bad },
      });
      assertIssues(validateFingerprintBindings(procedure), ["declared_permissions_require_policy_hash"]);
    }
  });

  it("声明权限但 policy hash 是旧占位 sha256:4f… ⇒ permission_policy_hash_is_placeholder（非真实指纹）", () => {
    const procedure = withOverrides(baseProcedure(), {
      requiredPermissions: ["read:sql"],
      fingerprint: { permissionPolicyHash: LEGACY_PLACEHOLDER_POLICY_HASH },
    });
    assertIssues(validateFingerprintBindings(procedure), ["permission_policy_hash_is_placeholder"]);
  });

  it("effectless + permissionless 但绑定 policy hash ⇒ effectless_must_omit_policy_hash", () => {
    const procedure = withOverrides(baseProcedure(), {
      fingerprint: { permissionPolicyHash: POLICY_HASH }, // 未声明权限却绑定
    });
    assertIssues(validateFingerprintBindings(procedure), ["effectless_must_omit_policy_hash"]);
  });
});

describe("fingerprint binding invariant：diff 入口 fail-closed", () => {
  it("违反 invariant 的 procedure 调 diffProcedureDependencies ⇒ throw 受控错误（不得静默绕过失效）", () => {
    // 声明权限但缺 policy hash：permission 维度「未绑定」本会跳过失效——入口必须拦截。
    const malformed = withOverrides(baseProcedure(), { declaredEffects: ["detect-pagination"] });
    assert.throws(
      () => diffProcedureDependencies(malformed, { ...malformed.dependencyFingerprint }),
      /fingerprint_binding_invariant: declared_permissions_require_policy_hash/,
    );
  });

  it("effectless 却绑定 policy 的 malformed procedure ⇒ diff 入口 throw", () => {
    const malformed = withOverrides(baseProcedure(), {
      fingerprint: { permissionPolicyHash: POLICY_HASH },
    });
    assert.throws(
      () => diffProcedureDependencies(malformed, { ...malformed.dependencyFingerprint }),
      /fingerprint_binding_invariant: effectless_must_omit_policy_hash/,
    );
  });

  it("合法 procedure 的 diff 不受影响（validator 通过）", () => {
    const procedure = withOverrides(baseProcedure(), {
      declaredEffects: ["detect-pagination"],
      fingerprint: { permissionPolicyHash: POLICY_HASH },
    });
    const diff = diffProcedureDependencies(procedure, { ...procedure.dependencyFingerprint });
    assert.equal(diff.shouldInvalidate, false);
  });
});
