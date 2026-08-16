/**
 * Phase 4 — Execution Orchestrator（project-local 编排；不真实宿主部署）。
 *
 * 流程（ADR-0008 runtime resolution/fallback + implementation plan §9 + ADR-0012）：
 *
 *   resolveExecution → 决策：
 *   - abstain（no_skill_selected）：无副作用返回；
 *   - skill_md：加载父 SKILL.md 本身不是 effect（ADR-0012 §6），不调用授权 gate；
 *     后续真实工具调用由宿主 gate 逐次拦截（host adapter 层，不在此模块）；
 *   - compiled_procedure（快路径）：仅此处调用授权 gate（claims=procedure 声明两维）；
 *       guard 检查（缺声明观察 ⇒ checkGuards 内部合成 unknown ⇒ fail-closed）
 *       → artifact 执行（恰一次）→ 运行期结果安全校验（disposition/sideEffectCount）
 *       → disposition=abstained ⇒ 自动回退父 Skill（procedure_abstained，跳过 verifier）
 *       → disposition=completed 且 sideEffectCount=0 ⇒ postcondition verifier（verifierId
 *         必须属于 procedure.postconditions）
 *   - guard/verifier/procedure 失败 ⇒ resolveFallback（安全停止 + load_parent_skill）；
 *     artifact 结果非法（disposition/sideEffectCount 缺失或非法）或 sideEffectCount≠0
 *     ⇒ safety_stop：**不得 loadParentSkill**（避免重复/掩盖副作用），不调 verifier。
 *
 * 边界：
 * - 本编排不修改 procedure 状态（suspend/canary fail 是调用方按 Phase 5 提案，不在当前调用
 *   自我修改发布；ADR-0008）；
 * - MVP artifact 只允许确定性、可回放、只读或幂等操作；任意非幂等副作用自动快路径不允许；
 * - guard 观察缺省 ⇒ unknown ⇒ fail-closed 停止（绝不乐观通过）。
 */
import type {
  CompiledProcedure,
  ExecutionDecision,
  PracticeEvent,
} from "../core/contracts/index.ts";
import { checkGuards, type GuardObservation, type GuardOutcome } from "./guard.ts";
import { resolveFallback, type FallbackOutcome, type FallbackReason } from "./fallback.ts";
import {
  resolveExecution,
  type ResolverEnvironment,
  type SelectedSkillInput,
} from "./resolver.ts";

/**
 * 授权声明（ADR-0012 §5）：effects 与 permissions 两维分离，精确复制 procedure 声明
 * （declaredEffects / requiredPermissions），禁止占位字符串。
 */
export interface AuthorizationClaims {
  /** 与 procedure.declaredEffects 逐项一致（数组可为空当且仅当声明为空）。 */
  effects: readonly string[];
  /** 与 procedure.requiredPermissions 逐项一致（数组可为空当且仅当声明为空）。 */
  permissions: readonly string[];
}

export interface AuthorizationRequest {
  skillId: string;
  procedureId?: string;
  claims: AuthorizationClaims;
}

export type AuthorizationResult = "approved" | "denied";

export interface ArtifactStep {
  stepId: string;
  actor: "procedure";
  operationClass: string;
  outcome: "ok" | "failed" | "unknown";
}

/**
 * artifact 结构化结果（ADR-0012 §4）：disposition 必填；sideEffectCount 必填 number。
 * 缺失/非法/非 0 由 executor 按 safety_stop 处理（不得 loadParentSkill）。
 */
export interface ArtifactExecutionResult {
  /** 结构化结果（finding 等，opaque 透传）。 */
  result: unknown;
  steps: ArtifactStep[];
  /** 结构化处置（ADR-0012 §4）：completed=产生满足后置条件的确定结果；abstained=无副作用放弃。 */
  disposition: "completed" | "abstained";
  /** 可观察副作用计数（MVP 快路径必须为 0）。 */
  sideEffectCount: number;
}

export interface SlowPathOutput {
  /** project-local 模拟：父 SKILL.md 正文或加载标记。 */
  skillMdBody?: string;
  loaded: boolean;
}

export interface PostconditionVerification {
  pass: boolean;
  verifierId: string;
  observedEffect?: string;
}

export interface ExecutorServices {
  /** 确定性、可回放、只读或幂等的 artifact 执行。 */
  executeArtifact(input: {
    procedure: CompiledProcedure;
    input: unknown;
  }): Promise<ArtifactExecutionResult>;
  /** 慢路径：加载父 SKILL.md（project-local 模拟即可）。 */
  loadParentSkill(decision: ExecutionDecision): Promise<SlowPathOutput>;
  /** 外部授权 gate：快慢路径共用同一实例（plan §9）。 */
  checkAuthorization(request: AuthorizationRequest): Promise<AuthorizationResult>;
  /** postcondition verifier（独立于 procedure/LLM 自评）。 */
  verifyPostcondition(input: {
    procedure: CompiledProcedure;
    result: unknown;
    taskInput: unknown;
  }): Promise<PostconditionVerification>;
}

export interface ExecuteInput {
  selectedSkill?: SelectedSkillInput;
  procedure?: CompiledProcedure;
  environment: ResolverEnvironment;
  /** 当次任务输入（如 { sql }；opaque 透传给 artifact）。 */
  taskInput: unknown;
  /** 快路径运行时 guard 观察（由调用方/宿主提供；缺省 ⇒ unknown ⇒ fail-closed）。 */
  guardObservations?: ReadonlyArray<GuardObservation>;
  services: ExecutorServices;
}

export type ExecutionOutcome =
  | { outcome: "abstain"; decision: ExecutionDecision }
  | { outcome: "denied"; decision: ExecutionDecision; authorization: "denied" }
  | { outcome: "slow_path"; decision: ExecutionDecision; slowPath: SlowPathOutput }
  | {
      outcome: "fast_path";
      decision: ExecutionDecision;
      result: unknown;
      steps: ArtifactStep[];
      disposition: "completed";
      guardResults: PracticeEvent["guardResults"];
      verifierResults: PracticeEvent["verifierResults"];
    }
  | {
      outcome: "fallback";
      decision: ExecutionDecision;
      fallbackReason: FallbackReason;
      fallback: FallbackOutcome;
      /** 回退后已执行的慢路径（成功加载父 SKILL.md）。 */
      slowPath: SlowPathOutput;
      guardResults: PracticeEvent["guardResults"];
      verifierResults: PracticeEvent["verifierResults"];
    }
  | {
      outcome: "safety_stop";
      decision: ExecutionDecision;
      /** artifact 结果非法（disposition/sideEffectCount 缺失或非法）或意外副作用。 */
      safetyReason: "artifact_result_invalid" | "unexpected_side_effect";
      guardResults: PracticeEvent["guardResults"];
      verifierResults: PracticeEvent["verifierResults"];
    };

function guardResultsOf(outcome: GuardOutcome): PracticeEvent["guardResults"] {
  return outcome.guardResults;
}

/**
 * 主编排入口。确定性（给定同 services/同输入 → 同决策链；services 结果由注入方保证
 * 确定性）。任何 guard/verifier/procedure 失败 → fallback 安全停止 + 慢路径回退。
 */
export async function execute(input: ExecuteInput): Promise<ExecutionOutcome> {
  const { procedure, environment, taskInput, services } = input;
  const decision = resolveExecution({
    selectedSkill: input.selectedSkill,
    procedure,
    environment,
  });

  // abstain：无副作用、无授权。
  if (decision.mode === "abstain") {
    return { outcome: "abstain", decision };
  }

  // ADR-0012 §6：加载父 SKILL.md 本身不是 effect，不调用授权 gate；
  // 后续真实工具调用由宿主 gate 逐次拦截（host adapter 层）。
  if (decision.mode === "skill_md") {
    const slowPath = await services.loadParentSkill(decision);
    return { outcome: "slow_path", decision, slowPath };
  }

  // 快路径（compiled_procedure）：仅此处调用授权 gate。
  // claims 精确复制 procedure 声明（effects/permissions 两维），禁止占位字符串。
  const claims: AuthorizationClaims = {
    effects: [...procedure!.declaredEffects],
    permissions: [...procedure!.requiredPermissions],
  };
  const authorization = await services.checkAuthorization({
    skillId: decision.skillId,
    procedureId: procedure!.procedureId,
    claims,
  });
  if (authorization === "denied") {
    return { outcome: "denied", decision, authorization: "denied" };
  }

  // guard：缺声明观察 ⇒ checkGuards 内部合成 unknown ⇒ fail-closed（不再在此重复合成）。
  const guardOutcome = checkGuards({
    procedure: procedure!,
    observations: input.guardObservations ?? [],
  });
  if (!guardOutcome.ok) {
    // 在下一 effectful step 前安全停止；guard predicateId 不是 stepId，不猜首失败步骤。
    const fallback = resolveFallback({ reason: "guard_failure", steps: [] });
    const slowPath = await services.loadParentSkill(decision);
    return {
      outcome: "fallback",
      decision,
      fallbackReason: "guard_failure",
      fallback,
      slowPath,
      guardResults: guardResultsOf(guardOutcome),
      verifierResults: [],
    };
  }

  // artifact 执行（恰一次）。
  let artifactResult: ArtifactExecutionResult;
  try {
    artifactResult = await services.executeArtifact({ procedure: procedure!, input: taskInput });
  } catch {
    const fallback = resolveFallback({ reason: "procedure_error", steps: [] });
    const slowPath = await services.loadParentSkill(decision);
    return {
      outcome: "fallback",
      decision,
      fallbackReason: "procedure_error",
      fallback,
      slowPath,
      guardResults: guardResultsOf(guardOutcome),
      verifierResults: [],
    };
  }

  // 运行期结果安全校验（ADR-0012 §4 + 本轮冻结）：
  // - disposition 缺失/非法或 sideEffectCount 缺失/非有限数 ⇒ safety_stop(artifact_result_invalid)
  // - sideEffectCount !== 0 ⇒ safety_stop(unexpected_side_effect)
  // - safety_stop 不得 loadParentSkill（避免重复/掩盖已发生副作用），verifier 不调用。
  const disposition = artifactResult.disposition;
  const sideEffectCount = artifactResult.sideEffectCount;
  if (
    (disposition !== "completed" && disposition !== "abstained") ||
    typeof sideEffectCount !== "number" ||
    !Number.isFinite(sideEffectCount)
  ) {
    return {
      outcome: "safety_stop",
      decision,
      safetyReason: "artifact_result_invalid",
      guardResults: guardResultsOf(guardOutcome),
      verifierResults: [],
    };
  }
  if (sideEffectCount !== 0) {
    return {
      outcome: "safety_stop",
      decision,
      safetyReason: "unexpected_side_effect",
      guardResults: guardResultsOf(guardOutcome),
      verifierResults: [],
    };
  }

  // abstained + sideEffectCount=0 ⇒ 无副作用放弃，自动回退父 Skill（跳过 verifier）。
  if (disposition === "abstained") {
    const fallback = resolveFallback({ reason: "procedure_abstained", steps: artifactResult.steps });
    const slowPath = await services.loadParentSkill(decision);
    return {
      outcome: "fallback",
      decision,
      fallbackReason: "procedure_abstained",
      fallback,
      slowPath,
      guardResults: guardResultsOf(guardOutcome),
      verifierResults: [],
    };
  }

  // completed + 0 ⇒ postcondition verifier；verifierId 必须属于 procedure.postconditions。
  const verification = await services.verifyPostcondition({
    procedure: procedure!,
    result: artifactResult.result,
    taskInput,
  });
  const verifierDeclared = procedure!.postconditions.some(
    (p) => p.verifierId === verification.verifierId,
  );
  if (!verifierDeclared) {
    // verifierId 未声明：verifier 结果不可接受 ⇒ verifier_failure（不信任未声明的 verifier）。
    const candidate = artifactResult.steps.find((step) => step.outcome === "failed")?.stepId;
    const fallback = resolveFallback({
      reason: "verifier_failure",
      steps: artifactResult.steps,
      candidateFailurePoint: candidate,
    });
    const slowPath = await services.loadParentSkill(decision);
    return {
      outcome: "fallback",
      decision,
      fallbackReason: "verifier_failure",
      fallback,
      slowPath,
      guardResults: guardResultsOf(guardOutcome),
      verifierResults: [{ verifierId: verification.verifierId, result: "fail" }],
    };
  }
  if (!verification.pass) {
    // 快路径已执行（副作用仅限只读/幂等 MVP）；安全停止，不重放、不自我发布。
    const candidate = artifactResult.steps.find((step) => step.outcome === "failed")?.stepId;
    const fallback = resolveFallback({
      reason: "verifier_failure",
      steps: artifactResult.steps,
      candidateFailurePoint: candidate,
    });
    const slowPath = await services.loadParentSkill(decision);
    return {
      outcome: "fallback",
      decision,
      fallbackReason: "verifier_failure",
      fallback,
      slowPath,
      guardResults: guardResultsOf(guardOutcome),
      verifierResults: [
        {
          verifierId: verification.verifierId,
          result: "fail",
          ...(verification.observedEffect !== undefined ? { observedEffect: verification.observedEffect } : {}),
        },
      ],
    };
  }

  return {
    outcome: "fast_path",
    decision,
    result: artifactResult.result,
    steps: artifactResult.steps,
    disposition: "completed",
    guardResults: guardResultsOf(guardOutcome),
    verifierResults: [
      {
        verifierId: verification.verifierId,
        result: "pass",
        ...(verification.observedEffect !== undefined ? { observedEffect: verification.observedEffect } : {}),
      },
    ],
  };
}
