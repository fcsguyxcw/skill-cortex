/**
 * Phase 4 — resolveExecution 分支覆盖测试。
 *
 * 覆盖冻结检查顺序 a–i 全部分支与边界：
 * a no_skill_selected（abstain）；b no_procedure（skill_md）；c insufficient_evidence
 * （非 validated/canary/active）；d revision_mismatch；e dependency_mismatch（含部分字段、
 * 指纹缺失、多余字段不构成约束）；f precondition_failed（fail/unknown/缺失结果）；
 * g unsupported_effect；h authorization_required（mode=compiled_procedure + 授权声明）；
 * i eligible_procedure。外加 decisionId 确定性、checkedPreconditions 填充规则。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompiledProcedure, DependencyFingerprint } from "../core/contracts/index.ts";
import { resolveExecution, type ResolverEnvironment, type SelectedSkillInput } from "./resolver.ts";

const SKILL = { skillId: "skill:0000000000000000000000000000000000000000000000000000000000000001", skillRevision: "rev:1111111111111111111111111111111111111111111111111111111111111111" };

function makeProcedure(overrides: Partial<CompiledProcedure> = {}): CompiledProcedure {
  return {
    schemaVersion: 1,
    procedureId: "procedure:test:0000000000000000000000000000000000000000000000000000000000000001",
    parentSkillId: SKILL.skillId,
    parentSkillRevision: SKILL.skillRevision,
    procedureRevision: "rev:2222222222222222222222222222222222222222222222222222222222222222",
    status: "validated",
    dependencyFingerprint: { sourceHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333" },
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
    currentDependencyFingerprint: { sourceHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333" },
    preconditions: [{ predicateId: "pre-1", result: true }],
    requestedEffects: ["read-only-analysis"],
    authorizationRequired: false,
    ...overrides,
  };
}

describe("resolveExecution", () => {
  it("a. 无选中 Skill ⇒ abstain / no_skill_selected / fallback=abstain；skillId 为空串", () => {
    const decision = resolveExecution({ environment: env() });
    assert.equal(decision.mode, "abstain");
    assert.equal(decision.reason, "no_skill_selected");
    assert.equal(decision.fallbackMode, "abstain");
    assert.equal(decision.authorizationRequired, false);
    assert.equal(decision.skillId, "");
    assert.equal(decision.procedureId, undefined);
  });

  it("b. 有选中但无 procedure ⇒ skill_md / no_procedure / load_parent_skill", () => {
    const decision = resolveExecution({ selectedSkill: SKILL, environment: env() });
    assert.equal(decision.mode, "skill_md");
    assert.equal(decision.reason, "no_procedure");
    assert.equal(decision.fallbackMode, "load_parent_skill");
    assert.equal(decision.skillId, SKILL.skillId);
    assert.equal(decision.skillRevision, SKILL.skillRevision);
  });

  it("c. procedure.status 非 validated/canary/active ⇒ insufficient_evidence", () => {
    for (const status of ["draft", "suspended", "retired"] as const) {
      const decision = resolveExecution({
        selectedSkill: SKILL,
        procedure: makeProcedure({ status }),
        environment: env(),
      });
      assert.equal(decision.reason, "insufficient_evidence", `status=${status}`);
      assert.equal(decision.mode, "skill_md");
      assert.equal(decision.fallbackMode, "load_parent_skill");
      assert.equal(decision.procedureId, "procedure:test:0000000000000000000000000000000000000000000000000000000000000001");
      assert.deepEqual(decision.checkedPreconditions, [], "状态非法时不评估前置条件");
    }
  });

  it("d. currentSkillRevision ≠ parentSkillRevision ⇒ revision_mismatch", () => {
    const decision = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ currentSkillRevision: "rev:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }),
    });
    assert.equal(decision.reason, "revision_mismatch");
    assert.equal(decision.mode, "skill_md");
    assert.equal(decision.fallbackMode, "load_parent_skill");
    assert.deepEqual(decision.checkedPreconditions, []);
  });

  it("e. 依赖指纹不匹配 ⇒ dependency_mismatch（值不等 / 指纹缺失 / 必填 sourceHash 缺）", () => {
    // 值不等
    const valueMismatch = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ currentDependencyFingerprint: { sourceHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }),
    });
    assert.equal(valueMismatch.reason, "dependency_mismatch");
    // 指纹缺失（undefined）
    const missingFp = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ currentDependencyFingerprint: undefined }),
    });
    assert.equal(missingFp.reason, "dependency_mismatch");
    // 必填 sourceHash 缺失（对象但无值）
    const missingSource = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ currentDependencyFingerprint: {} as DependencyFingerprint }),
    });
    assert.equal(missingSource.reason, "dependency_mismatch");
    // 部分绑定：procedure 只绑 sourceHash，env 多余字段不构成约束
    const partial = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure({ dependencyFingerprint: { sourceHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333" } }),
      environment: env({ currentDependencyFingerprint: { sourceHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333", modelId: "extra-model" } }),
    });
    assert.equal(partial.reason, "eligible_procedure", "env 多余字段不影响匹配");
  });

  it("f. 前置条件 fail / unknown / 缺失结果 ⇒ precondition_failed（fail-closed）", () => {
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

    // procedure 声明了前置但 env 未提供结果 ⇒ 视为 unknown ⇒ fail-closed
    const missing = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ preconditions: [] }),
    });
    assert.equal(missing.reason, "precondition_failed");
    assert.deepEqual(missing.checkedPreconditions, [{ predicateId: "pre-1", result: "unknown" }]);
  });

  it("g. requestedEffect 越界 ⇒ unsupported_effect", () => {
    const decision = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ requestedEffects: ["read-only-analysis", "write-artifact"] }),
    });
    assert.equal(decision.reason, "unsupported_effect");
    assert.equal(decision.mode, "skill_md");
    // 空请求也合法（不越界）
    const empty = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env({ requestedEffects: [] }),
    });
    assert.equal(empty.reason, "eligible_procedure");
  });

  it("h. authorizationRequired ⇒ authorization_required，mode=compiled_procedure，授权声明=true", () => {
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

  it("i. 全部满足 ⇒ eligible_procedure，mode=compiled_procedure，checkedPreconditions 全 pass", () => {
    const decision = resolveExecution({
      selectedSkill: SKILL,
      procedure: makeProcedure(),
      environment: env(),
    });
    assert.equal(decision.reason, "eligible_procedure");
    assert.equal(decision.mode, "compiled_procedure");
    assert.equal(decision.authorizationRequired, false);
    assert.deepEqual(decision.checkedPreconditions, [{ predicateId: "pre-1", result: true }]);
    assert.equal(decision.procedureId, "procedure:test:0000000000000000000000000000000000000000000000000000000000000001");
  });

  it("decisionId 确定性：相同输入 ⇒ 相同 ID；不同 reason ⇒ 不同 ID", () => {
    const first = resolveExecution({ selectedSkill: SKILL, procedure: makeProcedure(), environment: env() });
    const second = resolveExecution({ selectedSkill: SKILL, procedure: makeProcedure(), environment: env() });
    assert.equal(first.decisionId, second.decisionId);
    const noProc = resolveExecution({ selectedSkill: SKILL, environment: env() });
    assert.notEqual(first.decisionId, noProc.decisionId);
    assert.match(first.decisionId, /^decision:[0-9a-f]{32}$/);
  });

  it("canary 与 active 状态允许快路径", () => {
    for (const status of ["canary", "active"] as const) {
      const decision = resolveExecution({
        selectedSkill: SKILL,
        procedure: makeProcedure({ status }),
        environment: env(),
      });
      assert.equal(decision.reason, "eligible_procedure", `status=${status}`);
    }
  });

  it("selectedSkill 的 revision 与 procedure.parentSkillRevision 无关（以 environment 为准）", () => {
    // procedure 绑定父 revision；selectedSkill.skillRevision 是快照，revision 校验看 env
    const selected: SelectedSkillInput = { ...SKILL, skillRevision: "rev:9999999999999999999999999999999999999999999999999999999999999999" };
    const decision = resolveExecution({
      selectedSkill: selected,
      procedure: makeProcedure(),
      environment: env(),
    });
    assert.equal(decision.reason, "eligible_procedure");
    assert.equal(decision.skillRevision, selected.skillRevision);
  });
});
