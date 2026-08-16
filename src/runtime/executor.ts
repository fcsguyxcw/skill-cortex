/**
 * Phase 4 — Execution Orchestrator（project-local 编排；不真实宿主部署）。
 *
 * 流程（ADR-0008 runtime resolution/fallback + implementation plan §9）：
 *
 *   resolveExecution → 决策：
 *   - abstain（no_skill_selected）：无副作用返回；
 *   - 同一授权 gate 应用于【快慢两条路径】（plan §9：快慢路径使用同一 authorization gate）；
 *     denied ⇒ 安全停止（outcome=denied，无副作用）；
 *   - skill_md（无 procedure / revision 失配 / dependency 失配 / 前置条件失败 /
 *     越界 effect / 状态不足）：走慢路径（加载父 SKILL.md，project-local 模拟）；
 *   - compiled_procedure（eligible / authorization_required 已获准）：
 *       guard 检查（任一 fail|unknown ⇒ 在下一 effectful step 前停止 → fallback）
 *       → artifact 执行（确定性、可回放、只读或幂等）→ postcondition verifier；
 *   - guard/verifier/procedure 失败 ⇒ resolveFallback（安全停止 + load_parent_skill），
 *     并执行慢路径回退；不重复副作用（快路径已停止，绝不重放 artifact）。
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

/** 慢路径动作的授权 effect 标记（project-local 模拟；真实宿主部署另行核验）。 */
export const SLOW_PATH_AUTH_EFFECT = "load-parent-skill";

export interface AuthorizationRequest {
  skillId: string;
  /** 本次请求的 effect：快路径 = requestedEffects 拼接；慢路径 = SLOW_PATH_AUTH_EFFECT。 */
  effect: string;
}

export type AuthorizationResult = "approved" | "denied";

export interface ArtifactStep {
  stepId: string;
  actor: "procedure";
  operationClass: string;
  outcome: "ok" | "failed" | "unknown";
}

export interface ArtifactExecutionResult {
  /** 结构化结果（finding 等，opaque 透传）。 */
  result: unknown;
  steps: ArtifactStep[];
  /** 可观察副作用计数（测试/审计 seam；MVP 快路径必须为 0）。 */
  sideEffectCount?: number;
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

  // 同一授权 gate：慢路径 = 加载父 Skill；快路径 = 请求的 effects。
  const effect =
    decision.mode === "skill_md"
      ? SLOW_PATH_AUTH_EFFECT
      : environment.requestedEffects.join(",") || "<procedure-execution>";
  const authorization = await services.checkAuthorization({
    skillId: decision.skillId,
    effect,
  });
  if (authorization === "denied") {
    return { outcome: "denied", decision, authorization: "denied" };
  }

  // 慢路径（含 resolver 的 skill_md 拒绝分支）：加载父 SKILL.md（project-local 模拟）。
  if (decision.mode === "skill_md") {
    const slowPath = await services.loadParentSkill(decision);
    return { outcome: "slow_path", decision, slowPath };
  }

  // 快路径：guard → artifact → postcondition verifier。
  // fail-closed：procedure 声明的每个 runtime guard 必须有观察；缺省 ⇒ unknown ⇒ 停止。
  const declaredRuntimeGuards = new Map(
    procedure!.runtimeGuards.map((guard) => [guard.predicateId, guard] as const),
  );
  const providedObservations = input.guardObservations ?? [];
  const missingGuardObservation = (
    predicateId: string,
  ): GuardObservation => ({ predicateId, phase: "runtime", result: "unknown" });
  const completeObservations: GuardObservation[] = [
    ...procedure!.runtimeGuards.map((guard) => {
      const found = providedObservations.find((o) => o.predicateId === guard.predicateId);
      return found ?? missingGuardObservation(guard.predicateId);
    }),
    ...providedObservations.filter((o) => !declaredRuntimeGuards.has(o.predicateId)),
  ];
  const guardOutcome = checkGuards({
    procedure: procedure!,
    observations: completeObservations,
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

  const verification = await services.verifyPostcondition({
    procedure: procedure!,
    result: artifactResult.result,
    taskInput,
  });
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
