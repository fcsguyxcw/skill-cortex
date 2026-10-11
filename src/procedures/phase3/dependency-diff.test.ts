/**
 * Phase 5 slice 2 —— dependency diff 与失效测试。
 *
 * 覆盖：
 * - diff 纯函数：维度绑定/命中语义（source 恒绑定；tool/permission/environment/model/prompt
 *   字段存在才绑定；绑定字段 current 缺失 ⇒ fail-closed 命中）；
 * - 无关维度不失效：纯确定性 artifact（未绑定 model/prompt/environment）的 current
 *   变化不产生 impacted ⇒ shouldInvalidate=false（plan §10 task 2：不让纯确定性 artifact
 *   因无关模型变化失效）；
 * - 含 LLM hole 的 procedure 绑定 modelId/promptHash ⇒ model/prompt 变化触发失效；
 * - 失效编排：source 变化 ⇒ validated/canary/active 各 suspend（reason 记录命中维度）；
 *   tool schema 变化只失效相关 artifact（不同绑定各判各）；终态不重复 suspend。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DependencyFingerprint } from "../../core/contracts/index.ts";
import {
  buildPhase3ProcedureDraft,
  transitionPhase3ProcedureActive,
  transitionPhase3ProcedureCanary,
  transitionPhase3ProcedureValidation,
  type Phase3InvalidatableProcedure,
  type Phase3ValidatedProcedure,
} from "./index.ts";
import {
  diffProcedureDependencies,
  invalidateOnDependencyDrift,
  type FingerprintDimension,
} from "./dependency-diff.ts";

const SKILL_HASH = "8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830";
const REFERENCE_HASH = "73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const PARENT_SKILL_ID = "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2";
const PARENT_SKILL_REVISION = "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec";
const VALIDATION_REPORT = "validation:phase3-pagination-p3-gate-2026-08-15";
const CANARY_REPORT = "canary:phase3-pagination-p4-gate-2026-08-16";
const ACTIVE_REPORT = "active:phase3-pagination-p4-canary-2026-08-16";
const OTHER_SKILL_HASH = "11".repeat(32);
const OTHER_TOOL_SCHEMA_HASH = "22".repeat(32);
const POLICY_HASH = `sha256:${"33".repeat(32)}`;
const MODEL_ID = "model:test-gpt-4o";
const PROMPT_HASH = `sha256:${"44".repeat(32)}`;
const ENV_CLASS = "project-local-sandbox";

function draftOf(overrides: { detectorVersion?: string } = {}) {
  return buildPhase3ProcedureDraft({
    parentSkillId: PARENT_SKILL_ID,
    parentSkillRevision: PARENT_SKILL_REVISION,
    skillMdHash: SKILL_HASH,
    selectedReferenceHash: REFERENCE_HASH,
    createdAt: "2026-08-14T00:00:00.000Z",
    evidenceIds: ["practice:offset-1", "practice:keyset-1"],
    ...overrides,
  });
}

function validatedOf(overrides: { detectorVersion?: string } = {}) {
  return transitionPhase3ProcedureValidation(draftOf(overrides), {
    decision: "validated",
    validationReportId: VALIDATION_REPORT,
  });
}

function canaryOf() {
  return transitionPhase3ProcedureCanary(validatedOf(), {
    decision: "canary",
    canaryReportId: CANARY_REPORT,
  });
}

function activeOf() {
  return transitionPhase3ProcedureActive(canaryOf(), {
    decision: "active",
    activeReportId: ACTIVE_REPORT,
  });
}

/** 绑定额外指纹维度（构造含 LLM hole / permission / environment 的 procedure）。 */
function withExtraFingerprint(
  procedure: Phase3ValidatedProcedure,
  extra: Partial<DependencyFingerprint> & {
    llmHoles?: Phase3ValidatedProcedure["llmHoles"];
    declaredEffects?: string[];
    requiredPermissions?: string[];
  },
): Phase3ValidatedProcedure {
  return {
    ...procedure,
    ...(extra.llmHoles !== undefined ? { llmHoles: extra.llmHoles } : {}),
    ...(extra.declaredEffects !== undefined ? { declaredEffects: extra.declaredEffects } : {}),
    ...(extra.requiredPermissions !== undefined ? { requiredPermissions: extra.requiredPermissions } : {}),
    dependencyFingerprint: {
      ...procedure.dependencyFingerprint,
      ...extra,
    },
  };
}

/** 与绑定全匹配的 current 指纹。 */
function matchingCurrent(procedure: Phase3ValidatedProcedure): DependencyFingerprint {
  return { ...procedure.dependencyFingerprint };
}

function currentOverrides(
  procedure: Phase3ValidatedProcedure,
  overrides: Partial<DependencyFingerprint>,
): DependencyFingerprint {
  return { ...matchingCurrent(procedure), ...overrides };
}

describe("dependency diff：维度绑定与命中", () => {
  it("全匹配 ⇒ 无 impacted、shouldInvalidate=false；bound 含 source（sourceHash 恒绑定）", () => {
    const procedure = validatedOf();
    const diff = diffProcedureDependencies(procedure, matchingCurrent(procedure));
    assert.deepEqual(diff.impactedDimensions, []);
    assert.equal(diff.shouldInvalidate, false);
    assert.deepEqual(diff.boundDimensions, ["source", "tool"], "pagination 绑定 source + tool（permission/environment/model/prompt 省略）");
  });

  it("source 变化 ⇒ impacted=[source] ⇒ 需失效", () => {
    const procedure = validatedOf();
    const diff = diffProcedureDependencies(
      procedure,
      currentOverrides(procedure, { sourceHash: `sha256:${OTHER_SKILL_HASH}` }),
    );
    assert.deepEqual(diff.impactedDimensions, ["source"]);
    assert.equal(diff.shouldInvalidate, true);
  });

  it("tool schema 变化 ⇒ impacted=[tool] ⇒ 需失效", () => {
    const procedure = validatedOf();
    const diff = diffProcedureDependencies(
      procedure,
      currentOverrides(procedure, { toolSchemaHash: OTHER_TOOL_SCHEMA_HASH }),
    );
    assert.deepEqual(diff.impactedDimensions, ["tool"]);
    assert.equal(diff.shouldInvalidate, true);
  });

  it("绑定字段 current 缺失 ⇒ fail-closed 命中（无法证明匹配即变化）", () => {
    const procedure = validatedOf();
    const current: DependencyFingerprint = { sourceHash: procedure.dependencyFingerprint.sourceHash };
    const diff = diffProcedureDependencies(procedure, current);
    assert.deepEqual(diff.impactedDimensions, ["tool"], "toolSchemaHash 绑定但 current 缺失 ⇒ 命中");
    assert.equal(diff.shouldInvalidate, true);
  });

  it("permission：声明权限并绑定 ⇒ 变化命中；effectless（未绑定）⇒ 不失效", () => {
    // 合法构造（数据合同 §3.2 + ADR-0011）：声明 effects ⇒ permissionPolicyHash 必填绑定。
    const bound = withExtraFingerprint(validatedOf(), {
      declaredEffects: ["detect-pagination"],
      permissionPolicyHash: POLICY_HASH,
    });
    const hit = diffProcedureDependencies(
      bound,
      currentOverrides(bound, { permissionPolicyHash: `sha256:${"99".repeat(32)}` }),
    );
    assert.deepEqual(hit.impactedDimensions, ["permission"], "绑定 permission 变化必须命中");

    const effectless = validatedOf(); // 未绑定 permissionPolicyHash
    const miss = diffProcedureDependencies(
      effectless,
      currentOverrides(effectless, { permissionPolicyHash: POLICY_HASH }),
    );
    assert.equal(miss.shouldInvalidate, false, "effectless 未绑定 ⇒ 权限变化不失效");
  });

  it("environment：procedure 绑定 ⇒ 变化命中；未绑定 ⇒ 不失效", () => {
    const bound = withExtraFingerprint(validatedOf(), { environmentClass: ENV_CLASS });
    const hit = diffProcedureDependencies(bound, currentOverrides(bound, { environmentClass: "prod" }));
    assert.deepEqual(hit.impactedDimensions, ["environment"]);

    const plain = validatedOf();
    const miss = diffProcedureDependencies(plain, currentOverrides(plain, { environmentClass: "prod" }));
    assert.equal(miss.shouldInvalidate, false, "纯确定性 artifact 未绑定 environment ⇒ 不失效");
  });

  it("model/prompt：纯确定性（llmHoles=[] 未绑定）⇒ 无关变化不失效；含 LLM hole ⇒ 命中", () => {
    const plain = validatedOf();
    const miss = diffProcedureDependencies(
      plain,
      currentOverrides(plain, { modelId: MODEL_ID, promptHash: PROMPT_HASH }),
    );
    assert.deepEqual(miss.impactedDimensions, [], "纯确定性 artifact 不因无关模型变化失效");
    assert.equal(miss.shouldInvalidate, false);

    const withHole = withExtraFingerprint(validatedOf(), {
      llmHoles: [
        {
          holeId: "hole-1",
          purpose: "ambiguous classification edge case",
          inputBoundary: [],
          outputSchema: {},
        },
      ],
      modelId: MODEL_ID,
      promptHash: PROMPT_HASH,
    });
    const modelHit = diffProcedureDependencies(
      withHole,
      currentOverrides(withHole, { modelId: "model:other" }),
    );
    assert.deepEqual(modelHit.impactedDimensions, ["model"], "含 LLM hole ⇒ model 变化触发重验");
    const promptHit = diffProcedureDependencies(
      withHole,
      currentOverrides(withHole, { promptHash: `sha256:${"77".repeat(32)}` }),
    );
    assert.deepEqual(promptHit.impactedDimensions, ["prompt"], "含 LLM hole ⇒ prompt 变化触发重验");
  });

  it("boundDimensions 只含绑定维度（permission/environment/model/prompt 未绑定则不在集）", () => {
    const plain = validatedOf();
    const diff = diffProcedureDependencies(plain, matchingCurrent(plain));
    assert.deepEqual(diff.boundDimensions, ["source", "tool"]);
  });
});

describe("dependency 失效：invalidateOnDependencyDrift", () => {
  it("source 变化 ⇒ validated/canary/active 均 suspend，reason 记录命中维度", () => {
    const cases: Array<[string, Phase3InvalidatableProcedure]> = [
      ["validated", validatedOf()],
      ["canary", canaryOf()],
      ["active", activeOf()],
    ];
    for (const [status, procedure] of cases) {
      const result = invalidateOnDependencyDrift(procedure, {
        ...procedure.dependencyFingerprint,
        sourceHash: `sha256:${OTHER_SKILL_HASH}`,
      });
      assert.equal(result.diff.shouldInvalidate, true, `${status} 必须命中`);
      assert.ok(result.suspended !== undefined, `${status} 必须 suspend`);
      assert.equal(result.suspended!.status, "suspended");
      assert.equal(result.suspended!.lifecycleReason, "dependency drift: source");
      assert.equal(result.suspended!.procedureRevision, procedure.procedureRevision, "失败不改变 artifact 版本");
      // 审计链保留（suspend 只改状态 + reason）。
      assert.equal(result.suspended!.validationReportId, VALIDATION_REPORT);
    }
  });

  it("tool schema 变化只失效相关 artifact（不同绑定各判各，无关 artifact 不 suspend）", () => {
    // procA：默认 detector（toolSchemaHash A）；procB：不同 detector 版本（toolSchemaHash B）。
    const procA = validatedOf();
    const procB = validatedOf({ detectorVersion: "2.0.0" });
    assert.notEqual(
      procA.dependencyFingerprint.toolSchemaHash,
      procB.dependencyFingerprint.toolSchemaHash,
      "两 procedure 必须绑定不同 toolSchemaHash",
    );
    // current 匹配 procA 的 tool 维度（source 相同）。
    const current = {
      ...procA.dependencyFingerprint,
      toolSchemaHash: procA.dependencyFingerprint.toolSchemaHash,
    };
    const a = invalidateOnDependencyDrift(procA, current);
    const b = invalidateOnDependencyDrift(procB, current);
    assert.equal(a.suspended, undefined, "匹配的 artifact 不失效");
    assert.ok(b.suspended !== undefined, "tool schema 变化只失效绑定旧 schema 的 artifact");
    assert.deepEqual(b.diff.impactedDimensions, ["tool"]);
  });

  it("无关 model 变化不失效纯确定性 artifact（llmHoles=[]）", () => {
    const procedure = activeOf();
    const result = invalidateOnDependencyDrift(procedure, {
      ...procedure.dependencyFingerprint,
      modelId: MODEL_ID,
      promptHash: PROMPT_HASH,
    });
    assert.equal(result.suspended, undefined, "纯确定性 artifact 不因无关模型变化失效");
    assert.deepEqual(result.diff.impactedDimensions, []);
  });

  it("含 LLM hole 的 procedure 在 model/prompt 变化时 suspend", () => {
    const withHole = withExtraFingerprint(validatedOf(), {
      llmHoles: [
        { holeId: "hole-1", purpose: "ambiguous classification", inputBoundary: [], outputSchema: {} },
      ],
      modelId: MODEL_ID,
      promptHash: PROMPT_HASH,
    });
    const modelDrift = invalidateOnDependencyDrift(withHole, {
      ...withHole.dependencyFingerprint,
      modelId: "model:other",
    });
    assert.ok(modelDrift.suspended !== undefined);
    assert.equal(modelDrift.suspended!.lifecycleReason, "dependency drift: model");

    const promptDrift = invalidateOnDependencyDrift(withHole, {
      ...withHole.dependencyFingerprint,
      promptHash: `sha256:${"88".repeat(32)}`,
    });
    assert.ok(promptDrift.suspended !== undefined);
    assert.equal(promptDrift.suspended!.lifecycleReason, "dependency drift: prompt");
  });

  it("全匹配 ⇒ 不失效（suspended undefined，原 procedure 原样）", () => {
    const procedure = activeOf();
    const result = invalidateOnDependencyDrift(procedure, { ...procedure.dependencyFingerprint });
    assert.equal(result.suspended, undefined);
    assert.equal(result.diff.shouldInvalidate, false);
  });

  it("终态（suspended/retired）不重复 suspend（fail-closed）", () => {
    const active = activeOf();
    const drifted = {
      ...active.dependencyFingerprint,
      sourceHash: `sha256:${OTHER_SKILL_HASH}`,
    };
    const suspended = invalidateOnDependencyDrift(active, drifted).suspended!;
    assert.equal(suspended.status, "suspended");
    // 终态 suspended：diff 命中仍需 fail-closed（不重复 suspend）。
    assert.throws(
      () => invalidateOnDependencyDrift(suspended as never, drifted),
      /suspend_transition_requires_non_terminal_procedure/,
      "终态 suspended 不重复 suspend",
    );
  });
});

describe("diff 确定性", () => {
  it("同输入同输出（可回放）；维度枚举受控", () => {
    const procedure = validatedOf();
    const current = currentOverrides(procedure, { sourceHash: `sha256:${OTHER_SKILL_HASH}` });
    assert.deepEqual(
      diffProcedureDependencies(procedure, current),
      diffProcedureDependencies(procedure, current),
    );
    for (const dimension of [...diffProcedureDependencies(procedure, current).impactedDimensions]) {
      assert.ok(
        ["source", "tool", "permission", "environment", "model", "prompt"].includes(dimension),
        "维度必须是受控枚举",
      );
    }
    const dimensions: readonly FingerprintDimension[] = ["source", "tool"];
    assert.deepEqual(dimensions, ["source", "tool"]);
  });
});
