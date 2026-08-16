/**
 * Phase 4 — Execution Orchestrator 集成测试（纯 project-local；不部署宿主）。
 *
 * 覆盖 implementation plan §9 验证清单：
 * - 无 procedure / revision mismatch / dependency mismatch / 未知条件 → 慢路径；
 * - 只有全部 guard pass → 快路径；快慢路径使用同一 authorization gate（同一注入实例）；
 * - guard/verifier/procedure 失败 → fallback 安全停止 + 慢路径恢复；artifact 不重复执行
 *   （模拟重复调用证明无重复非幂等副作用；MVP fixture 本身只读）；
 * - verifier 失败 ⇒ canary fail 信号（不在当前调用自我修改 procedure 状态）；
 * - denied / abstain 无副作用。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompiledProcedure } from "../core/contracts/index.ts";
import {
  execute,
  SLOW_PATH_AUTH_EFFECT,
  type AuthorizationRequest,
  type ExecuteInput,
  type ExecutorServices,
} from "./executor.ts";
import type { ResolverEnvironment, SelectedSkillInput } from "./resolver.ts";

const SKILL: SelectedSkillInput = {
  skillId: "skill:0000000000000000000000000000000000000000000000000000000000000001",
  skillRevision: "rev:1111111111111111111111111111111111111111111111111111111111111111",
};

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
    preconditions: [{ predicateId: "pre-1", description: "input bounded" }],
    coveredSteps: [{ stepId: "detect-offset-pagination", sourceClauseRefs: [] }],
    forbiddenAutomationSteps: [],
    runtimeGuards: [
      { predicateId: "guard-1", description: "supported input", beforeStepIds: ["detect-offset-pagination"] },
    ],
    llmHoles: [],
    declaredEffects: ["read-only-analysis"],
    requiredPermissions: [],
    postconditions: [{ verifierId: "v-1", description: "structural finding" }],
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

interface RecordingServices {
  artifactCalls: number;
  slowPathCalls: number;
  authCalls: AuthorizationRequest[];
  verifyCalls: number;
  /** 副作用探针（测试 seam：记录 artifact 是否执行；MVP 真 fixture 只读）。 */
  sideEffectProbe: number;
}

/** 可配置 services：默认全成功；通过 overrides 注入失败行为。 */
function makeServices(overrides: Partial<ExecutorServices> = {}): {
  services: ExecutorServices;
  recording: RecordingServices;
} {
  const recording: RecordingServices = {
    artifactCalls: 0,
    slowPathCalls: 0,
    authCalls: [],
    verifyCalls: 0,
    sideEffectProbe: 0,
  };
  const services: ExecutorServices = {
    async executeArtifact({ input }) {
      recording.artifactCalls += 1;
      recording.sideEffectProbe += 1; // 仅测试探针；MVP artifact 本身只读
      return {
        result: { class: "uses_offset" },
        steps: [
          { stepId: "detect-offset-pagination", actor: "procedure", operationClass: "detect-offset-pagination", outcome: "ok" },
        ],
        sideEffectCount: recording.sideEffectProbe,
      };
    },
    async loadParentSkill() {
      recording.slowPathCalls += 1;
      return { loaded: true, skillMdBody: "<!-- slow path: parent SKILL.md -->" };
    },
    async checkAuthorization(request) {
      recording.authCalls.push(request);
      return "approved";
    },
    async verifyPostcondition() {
      recording.verifyCalls += 1;
      return { pass: true, verifierId: "v-1" };
    },
    ...overrides,
  };
  return { services, recording };
}

function fastInput(services: ExecutorServices, overrides: Parameters<typeof env>[0] = {}): ExecuteInput {
  const procedure = makeProcedure();
  return {
    selectedSkill: SKILL,
    procedure,
    environment: env(overrides),
    taskInput: { sql: "SELECT 1;" },
    guardObservations: [{ predicateId: "guard-1", phase: "runtime", result: true }],
    services,
  };
}

describe("executor：慢路径分支（plan §9）", () => {
  it("无 procedure ⇒ 慢路径（skill_md / no_procedure），慢路径加载", async () => {
    const { services, recording } = makeServices();
    const outcome = await execute({ selectedSkill: SKILL, environment: env(), taskInput: {}, services });
    assert.equal(outcome.outcome, "slow_path");
    if (outcome.outcome === "slow_path") {
      assert.equal(outcome.decision.mode, "skill_md");
      assert.equal(outcome.decision.reason, "no_procedure");
      assert.equal(outcome.slowPath.loaded, true);
    }
    assert.equal(recording.artifactCalls, 0, "慢路径不得执行 artifact");
    assert.equal(recording.slowPathCalls, 1);
  });

  it("revision mismatch ⇒ 慢路径", async () => {
    const { services, recording } = makeServices();
    const outcome = await execute(fastInput(services, { currentSkillRevision: "rev:9999999999999999999999999999999999999999999999999999999999999999" }));
    assert.equal(outcome.outcome, "slow_path");
    if (outcome.outcome === "slow_path") assert.equal(outcome.decision.reason, "revision_mismatch");
    assert.equal(recording.artifactCalls, 0);
  });

  it("dependency mismatch（指纹缺失/字段不符）⇒ 慢路径", async () => {
    const missing: ResolverEnvironment["currentDependencyFingerprint"] = undefined;
    const { services } = makeServices();
    const noFingerprint = await execute(fastInput(services, { currentDependencyFingerprint: missing }));
    assert.equal(noFingerprint.outcome, "slow_path");
    if (noFingerprint.outcome === "slow_path") assert.equal(noFingerprint.decision.reason, "dependency_mismatch");

    const wrong = await execute(
      fastInput(services, { currentDependencyFingerprint: { sourceHash: "sha256:aaaa000000000000000000000000000000000000000000000000000000000000" } }),
    );
    assert.equal(wrong.outcome, "slow_path");
    if (wrong.outcome === "slow_path") assert.equal(wrong.decision.reason, "dependency_mismatch");
  });

  it("未知条件（precondition unknown/缺失）⇒ 慢路径（fail-closed）", async () => {
    const { services } = makeServices();
    const unknown = await execute(fastInput(services, { preconditions: [{ predicateId: "pre-1", result: "unknown" }] }));
    assert.equal(unknown.outcome, "slow_path");
    if (unknown.outcome === "slow_path") assert.equal(unknown.decision.reason, "precondition_failed");
  });

  it("status 非 validated/canary/active ⇒ 慢路径（insufficient_evidence）", async () => {
    const { services } = makeServices();
    const input = fastInput(services);
    input.procedure = makeProcedure({ status: "suspended" });
    const outcome = await execute(input);
    assert.equal(outcome.outcome, "slow_path");
    if (outcome.outcome === "slow_path") assert.equal(outcome.decision.reason, "insufficient_evidence");
  });

  it("requestedEffect 越界 ⇒ 慢路径（unsupported_effect）", async () => {
    const { services } = makeServices();
    const outcome = await execute(fastInput(services, { requestedEffects: ["write-files"] }));
    assert.equal(outcome.outcome, "slow_path");
    if (outcome.outcome === "slow_path") assert.equal(outcome.decision.reason, "unsupported_effect");
  });
});

describe("executor：快路径与 guard（plan §9）", () => {
  it("只有全部 guard pass ⇒ 快路径；guard/verifier 结果如实记录", async () => {
    const { services, recording } = makeServices();
    const outcome = await execute(fastInput(services));
    assert.equal(outcome.outcome, "fast_path");
    if (outcome.outcome === "fast_path") {
      assert.equal(outcome.decision.reason, "eligible_procedure");
      assert.deepEqual(outcome.guardResults, [{ predicateId: "guard-1", phase: "runtime", result: "pass" }]);
      assert.deepEqual(outcome.verifierResults, [{ verifierId: "v-1", result: "pass" }]);
    }
    assert.equal(recording.artifactCalls, 1);
    assert.equal(recording.slowPathCalls, 0, "快路径不得加载慢路径");
  });

  it("runtime guard fail ⇒ 在 effectful step 前停止：artifact 不执行、fallback + 慢路径恢复", async () => {
    const { services, recording } = makeServices();
    const outcome = await execute({
      ...fastInput(services),
      guardObservations: [{ predicateId: "guard-1", phase: "runtime", result: false }],
    });
    assert.equal(outcome.outcome, "fallback");
    if (outcome.outcome === "fallback") {
      assert.equal(outcome.fallbackReason, "guard_failure");
      assert.equal(outcome.fallback.fallbackMode, "load_parent_skill");
      assert.equal(outcome.fallback.stopped, true);
      assert.equal(outcome.slowPath.loaded, true, "guard 失败必须恢复慢路径");
      assert.ok(!outcome.fallback.firstAttributableFailureStepId, "guard predicate 非 stepId，不猜首失败点");
    }
    assert.equal(recording.artifactCalls, 0, "guard 失败不得执行 artifact（副作用前停止）");
    assert.equal(recording.verifyCalls, 0);
    assert.equal(recording.slowPathCalls, 1);
  });

  it("runtime guard unknown ⇒ fail-closed：fallback + 慢路径恢复（绝不乐观通过）", async () => {
    const { services, recording } = makeServices();
    const outcome = await execute({
      ...fastInput(services),
      guardObservations: [{ predicateId: "guard-1", phase: "runtime", result: "unknown" }],
    });
    assert.equal(outcome.outcome, "fallback");
    if (outcome.outcome === "fallback") assert.equal(outcome.fallbackReason, "guard_failure");
    assert.equal(recording.artifactCalls, 0);
  });

  it("guard 观察缺省 ⇒ unknown ⇒ fail-closed fallback", async () => {
    const { services } = makeServices();
    const input = fastInput(services);
    input.guardObservations = [];
    const outcome = await execute(input);
    assert.equal(outcome.outcome, "fallback");
    if (outcome.outcome === "fallback") assert.equal(outcome.fallbackReason, "guard_failure");
  });

  it("verifier fail ⇒ fallback + 慢路径恢复；不在当前调用自我修改 procedure 状态", async () => {
    const { services, recording } = makeServices({
      verifyPostcondition: async () => ({ pass: false, verifierId: "v-1", observedEffect: "bad" }),
    });
    const procedure = makeProcedure();
    const outcome = await execute(fastInput(services));
    assert.equal(outcome.outcome, "fallback");
    if (outcome.outcome === "fallback") {
      assert.equal(outcome.fallbackReason, "verifier_failure");
      assert.equal(outcome.fallback.fallbackMode, "load_parent_skill");
      assert.equal(outcome.slowPath.loaded, true);
      assert.deepEqual(outcome.verifierResults, [{ verifierId: "v-1", result: "fail", observedEffect: "bad" }]);
    }
    assert.equal(recording.artifactCalls, 1, "verifier 检查发生在 artifact 之后（一次）");
    assert.equal(recording.slowPathCalls, 1);
    // 状态未变（Phase 5 才允许 suspend）：编排不修改 procedure。
    assert.equal(procedure.status, "validated");
  });

  it("procedure_error ⇒ fallback + 慢路径恢复，artifact 异常不传播", async () => {
    const { services, recording } = makeServices({
      executeArtifact: async () => {
        recording.artifactCalls += 1;
        throw new Error("artifact boom");
      },
    });
    const outcome = await execute(fastInput(services));
    assert.equal(outcome.outcome, "fallback");
    if (outcome.outcome === "fallback") {
      assert.equal(outcome.fallbackReason, "procedure_error");
      assert.equal(outcome.slowPath.loaded, true);
    }
    assert.equal(recording.artifactCalls, 1);
    assert.equal(recording.slowPathCalls, 1);
  });
});

describe("executor：同一授权 gate（plan §9）", () => {
  it("同一注入 gate 被快慢两条路径调用；denied ⇒ 两侧都安全停止", async () => {
    // 慢路径：gate 被调用（effect=SLOW_PATH_AUTH_EFFECT）。
    const slow = makeServices();
    const slowOutcome = await execute({
      selectedSkill: SKILL,
      environment: env(),
      taskInput: {},
      services: slow.services,
    });
    assert.equal(slowOutcome.outcome, "slow_path");
    assert.deepEqual(slow.recording.authCalls, [{ skillId: SKILL.skillId, effect: SLOW_PATH_AUTH_EFFECT }]);

    // 快路径：同一 gate 被调用（effect=requestedEffects）。
    const fast = makeServices();
    const fastOutcome = await execute(fastInput(fast.services));
    assert.equal(fastOutcome.outcome, "fast_path");
    assert.deepEqual(fast.recording.authCalls, [{ skillId: SKILL.skillId, effect: "read-only-analysis" }]);

    // denied：慢路径与快路径都被拦截，无 artifact / 无慢路径加载。
    const deniedSlow = makeServices({ checkAuthorization: async () => "denied" });
    const ds = await execute({ selectedSkill: SKILL, environment: env(), taskInput: {}, services: deniedSlow.services });
    assert.equal(ds.outcome, "denied");
    assert.equal(deniedSlow.recording.slowPathCalls, 0);

    const deniedFast = makeServices({ checkAuthorization: async () => "denied" });
    const df = await execute(fastInput(deniedFast.services));
    assert.equal(df.outcome, "denied");
    assert.equal(deniedFast.recording.artifactCalls, 0, "denied 后不得执行 artifact");
    assert.equal(deniedFast.recording.slowPathCalls, 0);
  });

  it("authorization_required 决策（h 分支）：gate 批准后快路径继续，拒绝则停止", async () => {
    const approved = makeServices();
    const outcome = await execute(
      fastInput(approved.services, { authorizationRequired: true }),
    );
    assert.equal(outcome.outcome, "fast_path", "gate 批准后 authorized 快路径继续");
    if (outcome.outcome === "fast_path") assert.equal(outcome.decision.reason, "authorization_required");

    const denied = makeServices({ checkAuthorization: async () => "denied" });
    const d = await execute(fastInput(denied.services, { authorizationRequired: true }));
    assert.equal(d.outcome, "denied");
  });
});

describe("executor：abstain 与副作用", () => {
  it("no_skill_selected ⇒ abstain，无任何 services 调用", async () => {
    const { services, recording } = makeServices();
    const outcome = await execute({ environment: env(), taskInput: {}, services });
    assert.equal(outcome.outcome, "abstain");
    if (outcome.outcome === "abstain") {
      assert.equal(outcome.decision.reason, "no_skill_selected");
      assert.equal(outcome.decision.fallbackMode, "abstain");
    }
    assert.equal(recording.authCalls.length, 0);
    assert.equal(recording.artifactCalls, 0);
    assert.equal(recording.slowPathCalls, 0);
  });

  it("重复调用无重复非幂等副作用：每次调用 artifact 恰好一次；guard 失败 0 次；verifier 失败不重放", async () => {
    const ok = makeServices();
    await execute(fastInput(ok.services));
    await execute(fastInput(ok.services));
    assert.equal(ok.recording.artifactCalls, 2, "两次独立调用各执行一次 artifact");
    assert.equal(ok.recording.sideEffectProbe, 2, "探针只随调用递增，无重复副作用");

    const guardFail = makeServices();
    await execute({ ...fastInput(guardFail.services), guardObservations: [{ predicateId: "guard-1", phase: "runtime", result: false }] });
    await execute({ ...fastInput(guardFail.services), guardObservations: [{ predicateId: "guard-1", phase: "runtime", result: false }] });
    assert.equal(guardFail.recording.artifactCalls, 0, "guard 失败两轮都不执行 artifact（副作用前停止）");

    const verifierFail = makeServices({ verifyPostcondition: async () => ({ pass: false, verifierId: "v-1" }) });
    await execute(fastInput(verifierFail.services));
    await execute(fastInput(verifierFail.services));
    assert.equal(verifierFail.recording.artifactCalls, 2, "verifier 失败每轮 artifact 恰一次，回退不重放");
    assert.equal(verifierFail.recording.sideEffectProbe, 2);
  });
});
