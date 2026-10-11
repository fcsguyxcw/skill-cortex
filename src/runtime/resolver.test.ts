/**
 * Phase 4 — resolveExecution 分支覆盖测试（ADR-0012 / leader 冻结决策 D1–D4）。
 *
 * 覆盖冻结检查顺序 a–j 全部分支与边界：
 * a no_skill_selected（abstain）；b no_procedure（skill_md）；c parent_skill_mismatch
 * （身份先于状态/版本）；d 上下文×状态矩阵（shadow/canary/active/unknown，fail-closed）；
 * e revision 双重 fail-closed（selectedSkill 快照 与 env.current 任一失配）；f dependency
 * （含 ADR-0011 permissionPolicyHash fail-closed）；g precondition_failed；h effects 集合
 * 精确相等（子集/超集/空请求对非空声明均 unsupported_effect）；i authorization_required；
 * j eligible_procedure。外加 executionContext 规范化、decisionId 纳入 context、
 * checkedPreconditions 填充规则与优先级（身份 > 状态/版本）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompiledProcedure, DependencyFingerprint } from "../core/contracts/index.ts";
import {
  effectsSetEqual,
  isStatusEligibleInContext,
  normalizeExecutionContext,
  resolveExecution,
  type ResolverEnvironment,
  type SelectedSkillInput,
} from "./resolver.ts";

const SKILL: SelectedSkillInput = {
  skillId: "skill:0000000000000000000000000000000000000000000000000000000000000001",
  skillRevision: "rev:1111111111111111111111111111111111111111111111111111111111111111",
};
const OTHER_SKILL_ID = "skill:9999999999999999999999999999999999999999999999999999999999999999";
const OTHER_REVISION = "rev:9999999999999999999999999999999999999999999999999999999999999999";
/** ADR-0011：声明了 effects 的 procedure 必须绑定可核验 permissionPolicyHash（默认 fixture 合法值）。 */
const POLICY_HASH = "sha256:5555555555555555555555555555555555555555555555555555555555555555";

function makeProcedure(overrides: Partial<CompiledProcedure> = {}): CompiledProcedure {
  return {
    schemaVersion: 1,
    procedureId: "procedure:test:0000000000000000000000000000000000000000000000000000000000000001",
    parentSkillId: SKILL.skillId,
    parentSkillRevision: SKILL.skillRevision,
    procedureRevision: "rev:2222222222222222222222222222222222222222222222222222222222222222",
    status: "validated",
    dependencyFingerprint: {
      sourceHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      permissionPolicyHash: POLICY_HASH,
    },
    inputSchema: {},
    preconditions: [{ predicateId: "pre-1", description: "source present" }],
    coveredSteps: [],
    forbiddenAutomationSteps: [],
    runtimeGuards: [],
    llmHoles: [],
    declaredEffects: ["read-only-analysis"],
    requiredPermissions: [],
    postconditions: [],
    artifactLocator: "draft://pagination-v1",
    artifactHash: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    evidenceIds: [],
    validationReportId: "report:phase3:0000000000000000000000000000000000000000000000000000000000000001",
    createdAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function env(overrides: Partial<ResolverEnvironment> = {}): ResolverEnvironment {
  return {
    currentSkillRevision: SKILL.skillRevision,
    currentDependencyFingerprint: {
      sourceHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      permissionPolicyHash: POLICY_HASH,
    },
    executionContext: "shadow_replay", // 默认观察上下文（缺省测试显式覆盖）
    preconditions: [{ predicateId: "pre-1", result: true }],
    requestedEffects: ["read-only-analysis"],
    authorizationRequired: false,
    ...overrides,
  };
}

describe("resolver 纯函数辅助", () => {
  it("normalizeExecutionContext：合法三态保留；缺失/非法 ⇒ unknown（不伪造）", () => {
    assert.equal(normalizeExecutionContext("shadow_replay"), "shadow_replay");
    assert.equal(normalizeExecutionContext("canary"), "canary");
    assert.equal(normalizeExecutionContext("active"), "active");
    for (const bad of [undefined, null, 42, "production", "unknown", {}, ["shadow_replay"]]) {
      assert.equal(normalizeExecutionContext(bad), "unknown", `input=${String(bad)}`);
    }
  });

  it("isStatusEligibleInContext：shadow_replay={validated,canary,active}；canary={canary}；active={active}；unknown=∅", () => {
    for (const status of ["validated", "canary", "active"] as const) {
      assert.equal(isStatusEligibleInContext(status, "shadow_replay"), true, `shadow_replay+${status}`);
    }
    for (const status of ["draft", "suspended", "retired"] as const) {
      assert.equal(isStatusEligibleInContext(status, "shadow_replay"), false, `shadow_replay+${status}`);
    }
    assert.equal(isStatusEligibleInContext("canary", "canary"), true);
    for (const status of ["validated", "active", "draft", "suspended", "retired"] as const) {
      assert.equal(isStatusEligibleInContext(status, "canary"), false, `canary+${status}`);
    }
    assert.equal(isStatusEligibleInContext("active", "active"), true);
    for (const status of ["validated", "canary", "draft", "suspended", "retired"] as const) {
      assert.equal(isStatusEligibleInContext(status, "active"), false, `active+${status}`);
    }
    for (const status of ["validated", "canary", "active", "draft", "suspended", "retired"] as const) {
      assert.equal(isStatusEligibleInContext(status, "unknown"), false, `unknown+${status}`);
    }
  });

  it("effectsSetEqual：集合精确相等（顺序不敏感）；子集/超集/空对非空 ⇒ false", () => {
    assert.equal(effectsSetEqual(["a", "b"], ["a", "b"]), true);
    assert.equal(effectsSetEqual(["b", "a"], ["a", "b"]), true, "顺序不敏感");
    assert.equal(effectsSetEqual([], []), true);
    assert.equal(effectsSetEqual(["a"], []), false, "超集");
    assert.equal(effectsSetEqual([], ["a"]), false, "子集");
    assert.equal(effectsSetEqual(["a", "b"], ["a"]), false);
    assert.equal(effectsSetEqual(["a", "a"], ["a"]), false, "重复按集合长度失配");
    assert.equal(effectsSetEqual(["a", "a"], ["a", "b"]), false, "等长数组也不能用重复项漏掉声明项");
  });
});

describe("resolveExecution", () => {
  it("a. 无选中 Skill ⇒ abstain / no_skill_selected；context 如实输出（合法保留、缺失 unknown）", () => {
    const withCtx = resolveExecution({ environment: env() });
    assert.equal(withCtx.mode, "abstain");
    assert.equal(withCtx.reason, "no_skill_selected");
    assert.equal(withCtx.fallbackMode, "abstain");
    assert.equal(withCtx.authorizationRequired, false);
    assert.equal(withCtx.executionContext, "shadow_replay");
    assert.equal(withCtx.skillId, "");
    assert.equal(withCtx.procedureId, undefined);
    // 缺失 context 不伪造合法值
    const noCtx = resolveExecution({ environment: env({ executionContext: undefined }) });
    assert.equal(noCtx.executionContext, "unknown");
    assert.equal(noCtx.reason, "no_skill_selected");
  });

  it("b. 有选中但无 procedure ⇒ skill_md / no_procedure；非法 context 输出 unknown", () => {
    const decision = resolveExecution({ selectedSkill: SKILL, environment: env() });
    assert.equal(decision.mode, "skill_md");
    assert.equal(decision.reason, "no_procedure");
    assert.equal(decision.fallbackMode, "load_parent_skill");
    assert.equal(decision.executionContext, "shadow_replay");
    assert.equal(decision.skillId, SKILL.skillId);
    assert.equal(decision.skillRevision, SKILL.skillRevision);
    const illegal = resolveExecution({
      selectedSkill: SKILL,
      environment: env({ executionContext: "production" }),
    });
    assert.equal(illegal.reason, "no_procedure");
    assert.equal(illegal.executionContext, "unknown");
  });

  it("c. 父 Skill 身份不匹配 ⇒ parent_skill_mismatch（先于状态与版本；ADR-0012 §3）", () => {
    const wrongSkill = resolveExecution({
      selectedSkill: { ...SKILL, skillId: OTHER_SKILL_ID },
      procedure: makeProcedure(),
      environment: env(),
    });
    assert.equal(wrongSkill.reason, "parent_skill_mismatch");
    assert.equal(wrongSkill.mode, "skill_md");
    assert.equal(wrongSkill.fallbackMode, "load_parent_skill");
    assert.equal(wrongSkill.procedureId, "procedure:test:0000000000000000000000000000000000000000000000000000000000000001");
    assert.deepEqual(wrongSkill.checkedPreconditions, [], "身份不匹配时不评估后续");

    // 身份不匹配 且 版本不匹配 ⇒ 身份优先
    const bothWrong = resolveExecution({
      selectedSkill: { ...SKILL, skillId: OTHER_SKILL_ID },
      procedure: makeProcedure(),
      environment: env({ currentSkillRevision: OTHER_REVISION }),
    });
    assert.equal(bothWrong.reason, "parent_skill_mismatch");

    // 身份不匹配 且 status=draft ⇒ 身份优先
    const draftWrongSkill = resolveExecution({
      selectedSkill: { ...SKILL, skillId: OTHER_SKILL_ID },
      procedure: makeProcedure({ status: "draft" }),
      environment: env(),
    });
    assert.equal(draftWrongSkill.reason, "parent_skill_mismatch");
  });

  it("d. 上下文×状态矩阵（ADR-0012 §2）；unknown/缺失/非法 ⇒ insufficient_evidence（fail-closed，D1）", () => {
    // shadow_replay：validated/canary/active 允许；draft/suspended/retired 拒绝
    for (const status of ["validated", "canary", "active"] as const) {
      const d = resolveExecution({
        selectedSkill: SKILL,
        procedure: makeProcedure({ status }),
        environment: env({ executionContext: "shadow_replay" }),
      });
      assert.equal(d.reason, "eligible_procedure", `shadow_replay+${status}`);
    }
    for (const status of ["draft", "suspended", "retired"] as const) {
      const d = resolveExecution({
        selectedSkill: SKILL,
        procedure: makeProcedure({ status }),
        environment: env({ executionContext: "shadow_replay" }),
      });
      assert.equal(d.reason, "insufficient_evidence", `shadow_replay+${status}`);
    }
    // canary：只允许 canary
    const canaryOk = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure({ status: "canary" }),
      environment: env({ executionContext: "canary" }),
    });
    assert.equal(canaryOk.reason, "eligible_procedure");
    for (const status of ["validated", "active", "draft", "suspended", "retired"] as const) {
      const d = resolveExecution({
        selectedSkill: SKILL,
        procedure: makeProcedure({ status }),
        environment: env({ executionContext: "canary" }),
      });
      assert.equal(d.reason, "insufficient_evidence", `canary+${status}`);
    }
    // active：只允许 active
    const activeOk = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure({ status: "active" }),
      environment: env({ executionContext: "active" }),
    });
    assert.equal(activeOk.reason, "eligible_procedure");
    for (const status of ["validated", "canary", "draft", "suspended", "retired"] as const) {
      const d = resolveExecution({
        selectedSkill: SKILL,
        procedure: makeProcedure({ status }),
        environment: env({ executionContext: "active" }),
      });
      assert.equal(d.reason, "insufficient_evidence", `active+${status}`);
    }
    // unknown（缺失/非法/显式 unknown）：任何状态都拒绝，输出 unknown 不伪造
    for (const context of [undefined, "production", "unknown"]) {
      for (const status of ["validated", "canary", "active"] as const) {
        const d = resolveExecution({
          selectedSkill: SKILL,
          procedure: makeProcedure({ status }),
          environment: env({ executionContext: context }),
        });
        assert.equal(d.reason, "insufficient_evidence", `context=${String(context)}+${status}`);
        assert.equal(d.executionContext, "unknown", `不伪造合法 context（${String(context)}）`);
      }
    }
  });

  it("e. revision 双重 fail-closed（D2）：selectedSkill 快照 或 env.current 任一失配 ⇒ revision_mismatch", () => {
    // env 失配（既有语义）
    const envMismatch = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ currentSkillRevision: OTHER_REVISION }),
    });
    assert.equal(envMismatch.reason, "revision_mismatch");
    assert.equal(envMismatch.mode, "skill_md");
    assert.deepEqual(envMismatch.checkedPreconditions, []);

    // selectedSkill 快照失配（D2 新增：快照也必须等于 parent）
    const snapshotMismatch = resolveExecution({
      selectedSkill: { ...SKILL, skillRevision: OTHER_REVISION },
      procedure: makeProcedure(),
      environment: env(),
    });
    assert.equal(snapshotMismatch.reason, "revision_mismatch");
    assert.equal(snapshotMismatch.skillRevision, OTHER_REVISION, "decision 记录快照值");

    // 两者都匹配 ⇒ 通过
    const bothOk = resolveExecution({ selectedSkill: SKILL, procedure: makeProcedure(), environment: env() });
    assert.equal(bothOk.reason, "eligible_procedure");
  });

  it("f. 依赖指纹不匹配 ⇒ dependency_mismatch（值不等 / 指纹缺失 / 必填 sourceHash 缺 / ADR-0011 权限绑定缺）", () => {
    const valueMismatch = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ currentDependencyFingerprint: { sourceHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }),
    });
    assert.equal(valueMismatch.reason, "dependency_mismatch");

    const missingFp = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ currentDependencyFingerprint: undefined }),
    });
    assert.equal(missingFp.reason, "dependency_mismatch");

    const missingSource = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ currentDependencyFingerprint: {} as DependencyFingerprint }),
    });
    assert.equal(missingSource.reason, "dependency_mismatch");

    // 部分绑定：procedure 只绑 sourceHash + permissionPolicyHash，env 多余字段不构成约束
    const partial = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure({ dependencyFingerprint: { sourceHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333", permissionPolicyHash: POLICY_HASH } }),
      environment: env({ currentDependencyFingerprint: { sourceHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333", permissionPolicyHash: POLICY_HASH, modelId: "extra-model" } }),
    });
    assert.equal(partial.reason, "eligible_procedure", "env 多余字段不影响匹配");

    // ADR-0011 fail-closed：声明了 effects 但 fingerprint 省略 permissionPolicyHash ⇒ mismatch
    const declaredNoPolicy = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure({
        declaredEffects: ["read-only-analysis"],
        requiredPermissions: [],
        dependencyFingerprint: { sourceHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333" },
      }),
      environment: env(),
    });
    assert.equal(declaredNoPolicy.reason, "dependency_mismatch", "非空权限声明必须绑定 permissionPolicyHash");

    // effectless：declared/required 均空 + 省略 permissionPolicyHash ⇒ 仍可通过（ADR-0011 省略语义）
    const effectless = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure({ declaredEffects: [], requiredPermissions: [] }),
      environment: env({ requestedEffects: [] }),
    });
    assert.equal(effectless.reason, "eligible_procedure", "effectless 省略不构成约束");
  });

  it("g. 前置条件 fail / unknown / 缺失结果 ⇒ precondition_failed（fail-closed）", () => {
    const fail = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ preconditions: [{ predicateId: "pre-1", result: false }] }),
    });
    assert.equal(fail.reason, "precondition_failed");
    assert.deepEqual(fail.checkedPreconditions, [{ predicateId: "pre-1", result: false }]);

    const unknown = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ preconditions: [{ predicateId: "pre-1", result: "unknown" }] }),
    });
    assert.equal(unknown.reason, "precondition_failed");
    assert.deepEqual(unknown.checkedPreconditions, [{ predicateId: "pre-1", result: "unknown" }]);

    const missing = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ preconditions: [] }),
    });
    assert.equal(missing.reason, "precondition_failed");
    assert.deepEqual(missing.checkedPreconditions, [{ predicateId: "pre-1", result: "unknown" }]);
  });

  it("h. effects 集合精确相等（D4）：子集/超集/空请求对非空声明 ⇒ unsupported_effect；空×空与乱序 ⇒ eligible", () => {
    const superset = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ requestedEffects: ["read-only-analysis", "write-artifact"] }),
    });
    assert.equal(superset.reason, "unsupported_effect");
    assert.equal(superset.mode, "skill_md");

    // 空请求对非空声明 ⇒ 不精确相等（反转旧“空请求合法”语义）
    const emptyRequest = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ requestedEffects: [] }),
    });
    assert.equal(emptyRequest.reason, "unsupported_effect", "空请求对非空 declaredEffects 必须拒绝");

    // 顺序不敏感
    const reordered = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure({ declaredEffects: ["a", "b"] }),
      environment: env({ requestedEffects: ["b", "a"] }),
    });
    assert.equal(reordered.reason, "eligible_procedure", "集合比较顺序不敏感");

    // 空×空 ⇒ eligible
    const bothEmpty = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure({ declaredEffects: [], requiredPermissions: [] }),
      environment: env({ requestedEffects: [] }),
    });
    assert.equal(bothEmpty.reason, "eligible_procedure");
  });

  it("i. authorizationRequired ⇒ authorization_required，mode=compiled_procedure，授权声明=true", () => {
    const decision = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ authorizationRequired: true }),
    });
    assert.equal(decision.reason, "authorization_required");
    assert.equal(decision.mode, "compiled_procedure");
    assert.equal(decision.authorizationRequired, true);
    assert.equal(decision.fallbackMode, "load_parent_skill");
    assert.equal(decision.procedureId, "procedure:test:0000000000000000000000000000000000000000000000000000000000000001");
  });

  it("j. 全部满足 ⇒ eligible_procedure，mode=compiled_procedure，checkedPreconditions 全 pass", () => {
    const decision = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env(),
    });
    assert.equal(decision.reason, "eligible_procedure");
    assert.equal(decision.mode, "compiled_procedure");
    assert.equal(decision.authorizationRequired, false);
    assert.equal(decision.executionContext, "shadow_replay");
    assert.deepEqual(decision.checkedPreconditions, [{ predicateId: "pre-1", result: true }]);
    assert.equal(decision.procedureId, "procedure:test:0000000000000000000000000000000000000000000000000000000000000001");
  });

  it("decisionId：确定性 + 纳入 executionContext + reason 区分", () => {
    const first = resolveExecution({ selectedSkill: SKILL, procedure: makeProcedure(), environment: env() });
    const second = resolveExecution({ selectedSkill: SKILL, procedure: makeProcedure(), environment: env() });
    assert.equal(first.decisionId, second.decisionId);

    // 相同 skill/procedure/mode/reason、不同 context ⇒ 不同 ID
    const shadow = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure({ status: "active" }),
      environment: env({ executionContext: "shadow_replay" }),
    });
    const active = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure({ status: "active" }),
      environment: env({ executionContext: "active" }),
    });
    assert.equal(shadow.reason, "eligible_procedure");
    assert.equal(active.reason, "eligible_procedure");
    assert.notEqual(shadow.decisionId, active.decisionId, "decisionId 必须纳入 executionContext");

    // parent_skill_mismatch 与 revision_mismatch 不同 ID
    const wrongSkill = resolveExecution({
      selectedSkill: { ...SKILL, skillId: OTHER_SKILL_ID },
      procedure: makeProcedure(),
      environment: env(),
    });
    const revisionWrong = resolveExecution({
      selectedSkill: { ...SKILL, skillRevision: OTHER_REVISION },
      procedure: makeProcedure(),
      environment: env(),
    });
    assert.equal(wrongSkill.reason, "parent_skill_mismatch");
    assert.equal(revisionWrong.reason, "revision_mismatch");
    assert.notEqual(wrongSkill.decisionId, revisionWrong.decisionId);

    const noProc = resolveExecution({ selectedSkill: SKILL, environment: env() });
    assert.notEqual(first.decisionId, noProc.decisionId);
    assert.match(first.decisionId, /^decision:[0-9a-f]{32}$/);
  });
});
