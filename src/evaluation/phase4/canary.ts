/**
 * Phase 4 — project-local canary harness（不真实宿主部署、不写用户环境）。
 *
 * leader D3：本文件是 project-local 验证 harness，**不是真实 canary 发布**：
 * - shadow harness（runP3CanarySimulation）：executionContext="shadow_replay"，procedure 恒
 *   validated（ADR-0012：shadow replay 是验证方法，不是 procedure 状态）；
 * - Gate P4 canary harness（runP3CanaryGateSimulation）：procedure 经显式 validated→canary
 *   transition（transitionPhase3ProcedureCanary，绑定 shadow replay 证据 + canary 报告），
 *   在 executionContext="canary" 上下文跑同一冻结 held-out 集（ADR-0012 §2：canary={canary}）；
 *   上下文×状态矩阵由 resolver 强制：validated 进不了 canary 上下文（insufficient_evidence），
 *   canary 也进不了 active 上下文——绝不冒充发布。
 *
 * 分栏指标（implementation plan §9，不得用单一加权总分掩盖）：
 * - fallbackRecoveryRate：guard/verifier/procedure 失败回退后慢路径成功加载率；
 * - wrongFastPathRate：非 abstain 期望案例中快路径输出类别错误率；
 * - correctRejectionRate：应 abstain 案例中被正确路由到慢路径的比例；
 * - safetyStopCount（Gate P4 安全栏）：sideEffectCount≠0 / artifact 结果非法 ⇒ safety_stop
 *   计数，必须为 0；重复调用确定性由调用方（测试）两次 run 深度相等验证。
 *
 * 冻结值（P3_GATE_FROZEN，与 Gate P3 闭环一致）；permissionPolicyHash 按 ADR-0011
 * effectless pilot 显式省略（不绑定权限策略）。
 */
import { buildPhase3ProcedureDraft, transitionPhase3ProcedureCanary, transitionPhase3ProcedureValidation, type Phase3CanaryProcedure } from "../../procedures/phase3/draft.ts";
import type { CompiledProcedure } from "../../core/contracts/index.ts";
import { detectPagination, type PaginationFinding } from "../../procedures/phase3/detector.ts";
import {
  execute,
  type ExecutionOutcome,
  type ExecutorServices,
} from "../../runtime/executor.ts";
import { verifyStructuredFinding } from "../../adapters/pi/practice-pagination-hook.ts";
import { HELDOUT_CASES, type PaginationCase } from "../phase3/cases.ts";
import { P3_GATE_FROZEN } from "../phase3/p3-gate-runner.ts";

export const CANARY_VERIFIER_ID = "phase3-pagination-structured-finding";
/**
 * harness 执行上下文（leader D3）：shadow_replay = 观察式验证，不产生用户可见 effect。
 * validated procedure 只允许在 shadow_replay 上下文执行（ADR-0012 §2），不冒充 canary/active。
 */
export const CANARY_EXECUTION_CONTEXT = "shadow_replay" as const;
/**
 * Gate P4：project-local canary 执行上下文（ADR-0012 §2：canary 上下文只放行 canary 状态）。
 * 限量发布语义在 project-local 通过冻结 held-out 集 + effectless 只读 artifact 模拟；
 * 不启动真实宿主部署、不写用户日常环境。
 */
export const CANARY_GATE_EXECUTION_CONTEXT = "canary" as const;
/** 冻结 canary 报告 ID（Gate P4 shadow replay 通过报告，与 P3 validation report 同风格独立前缀）。 */
export const CANARY_GATE_REPORT_ID = "canary:phase3-pagination-p4-gate-2026-08-16" as const;

/** 冻结构造 validated procedure（确定性；与 P3 Gate 闭环同一冻结值）。 */
export function buildCanaryValidatedProcedure() {
  const draft = buildPhase3ProcedureDraft({
    parentSkillId: P3_GATE_FROZEN.parentSkillId,
    parentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
    skillMdHash: P3_GATE_FROZEN.sourceHash,
    selectedReferenceHash: P3_GATE_FROZEN.selectedReferenceHash,
    createdAt: "2026-08-15T00:00:00.000Z",
    evidenceIds: [...P3_GATE_FROZEN.eventIds],
  });
  return transitionPhase3ProcedureValidation(draft, {
    decision: "validated",
    validationReportId: P3_GATE_FROZEN.validationReportId,
  });
}

/**
 * Gate P4：显式 validated→canary 晋升（发布动作，不是执行上下文）。
 * 要求 validated + shadow replay 证据（P3_GATE_FROZEN.eventIds 非空 + canary 报告绑定），
 * 无证据/非 validated 输入由 transition 拒绝（fail closed）。
 */
export function buildCanaryProcedure(): Phase3CanaryProcedure {
  return transitionPhase3ProcedureCanary(buildCanaryValidatedProcedure(), {
    decision: "canary",
    canaryReportId: CANARY_GATE_REPORT_ID,
  });
}

/** 慢路径模拟：project-local 标记，不读/写用户环境。 */
export function simulateLoadParentSkill() {
  return {
    loaded: true,
    skillMdBody:
      "<!-- project-local canary slow-path simulation: 父 SKILL.md 在此加载（未部署真实宿主） -->",
  };
}

/** 创建 canary 使用的 ExecutorServices（快路径 = detectPagination；结构化 verifier）。 */
export function createCanaryServices(): ExecutorServices {
  return {
    async executeArtifact({ input }) {
      const sql = (input as { sql?: unknown }).sql;
      const finding: PaginationFinding = detectPagination(
        typeof sql === "string" ? sql : "",
      );
      return {
        result: finding,
        steps: [
          {
            stepId: "detect-offset-pagination",
            actor: "procedure",
            operationClass: "detect-offset-pagination",
            outcome: "ok",
          },
        ],
        // ADR-0012 §4：由 detector finding 决定结构化处置——abstain ⇒ abstained
        // （executor 统一产生 procedure_abstained 回退，外层不再手工路由）；否则 completed。
        disposition: finding.class === "abstain" ? "abstained" : "completed",
        sideEffectCount: 0, // MVP：只读静态检测，无副作用
      };
    },
    async loadParentSkill() {
      return simulateLoadParentSkill();
    },
    async checkAuthorization(_request) {
      return "approved"; // 只读分析：批准
    },
    async verifyPostcondition({ result, taskInput }) {
      const finding = result as PaginationFinding;
      const sql = (taskInput as { sql?: unknown }).sql;
      const pass = typeof sql === "string" && verifyStructuredFinding(sql, finding);
      return {
        pass,
        verifierId: CANARY_VERIFIER_ID,
        observedEffect: pass ? "structured-finding-valid" : "structured-finding-invalid",
      };
    },
  };
}

export interface CanaryPerCase {
  caseId: string;
  expected: PaginationCase["expected"];
  outcome: ExecutionOutcome["outcome"];
  findingClass: string | null;
  correct: boolean;
  /** fallback 后慢路径是否成功加载（恢复证据）。 */
  recovered?: boolean;
  /** 由 executor 统一产生的 procedure_abstained 回退（detector 判 abstain，无副作用）。 */
  abstained?: boolean;
}

export interface CanaryResult {
  frozenBasis: string;
  total: number;
  fastPathCount: number;
  abstainRoutedToSlowPath: number;
  fallbackCount: number;
  deniedCount: number;
  /** Gate P4 安全栏：safety_stop 数（sideEffectCount≠0 / artifact 结果非法）——必须为 0。 */
  safetyStopCount: number;
  /** 分栏指标（N/A 表示分母为 0，不进入判定）。 */
  fallbackRecoveryRate: number | "N/A";
  wrongFastPathRate: number | "N/A";
  correctRejectionRate: number | "N/A";
  perCase: CanaryPerCase[];
}

/**
 * 共享跑分：给定 procedure + executionContext 跑冻结 held-out 集（确定性可回放）。
 * 上下文×状态矩阵由 resolver 强制（validated 进不了 canary 上下文等），本函数不做状态判断。
 */
async function runHeldoutCases(
  procedure: CompiledProcedure,
  executionContext: string,
  frozenBasis: string,
): Promise<CanaryResult> {
  const services = createCanaryServices();
  const perCase: CanaryPerCase[] = [];

  for (const case_ of HELDOUT_CASES) {
    const outcome = await execute({
      selectedSkill: {
        skillId: P3_GATE_FROZEN.parentSkillId,
        skillRevision: P3_GATE_FROZEN.parentSkillRevision,
      },
      procedure,
      environment: {
        currentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
        currentDependencyFingerprint: procedure.dependencyFingerprint,
        executionContext,
        preconditions: [
          { predicateId: "bounded-sql-input", result: true },
          { predicateId: "source-bindings-current", result: true },
        ],
        requestedEffects: [],
        authorizationRequired: false,
      },
      taskInput: { sql: case_.sql },
      guardObservations: [
        { predicateId: "bounded-supported-sql", phase: "runtime", result: true },
        { predicateId: "source-and-dependency-match", phase: "runtime", result: true },
      ],
      services,
    });

    if (outcome.outcome === "fast_path") {
      const finding = outcome.result as PaginationFinding;
      perCase.push({
        caseId: case_.id,
        expected: case_.expected,
        outcome: "fast_path",
        findingClass: finding.class,
        correct: finding.class === case_.expected,
      });
      continue;
    }

    // 由 executor 统一产生的 procedure_abstained 回退（无副作用、已加载慢路径）。
    // 外层不再手工 if(finding.class==="abstain") 绕过 executor（验收修复）。
    if (outcome.outcome === "fallback" && outcome.fallbackReason === "procedure_abstained") {
      perCase.push({
        caseId: case_.id,
        expected: case_.expected,
        outcome: "fallback",
        findingClass: null,
        correct: case_.expected === "abstain", // detector 判 abstain 且期望确实为 abstain
        recovered: outcome.slowPath.loaded,
        abstained: true,
      });
      continue;
    }

    perCase.push({
      caseId: case_.id,
      expected: case_.expected,
      outcome: outcome.outcome,
      findingClass: null,
      correct: false, // held-out 上其它 fallback/denied 不是预期结果（防御停止，不算正确分类）
      recovered: outcome.outcome === "fallback" ? outcome.slowPath.loaded : undefined,
    });
  }

  const fastPathCases = perCase.filter((c) => c.outcome === "fast_path");
  const abstainRouted = perCase.filter((c) => c.abstained === true);
  const fallbacks = perCase.filter((c) => c.outcome === "fallback" && c.abstained !== true);
  const denied = perCase.filter((c) => c.outcome === "denied");
  const safetyStops = perCase.filter((c) => c.outcome === "safety_stop");

  const fastPathNonAbstainExpected = fastPathCases.filter((c) => c.expected !== "abstain");
  const wrongFastPath = fastPathCases.filter((c) => c.expected !== "abstain" && !c.correct);

  return {
    frozenBasis,
    total: perCase.length,
    fastPathCount: fastPathCases.length,
    abstainRoutedToSlowPath: abstainRouted.length,
    fallbackCount: fallbacks.length,
    deniedCount: denied.length,
    safetyStopCount: safetyStops.length,
    fallbackRecoveryRate:
      fallbacks.length === 0
        ? "N/A"
        : fallbacks.filter((c) => c.recovered === true).length / fallbacks.length,
    wrongFastPathRate:
      fastPathNonAbstainExpected.length === 0
        ? "N/A"
        : wrongFastPath.length / fastPathNonAbstainExpected.length,
    correctRejectionRate:
      abstainRouted.length === 0
        ? "N/A"
        : abstainRouted.filter((c) => c.correct).length / abstainRouted.length,
    perCase,
  };
}

/** project-local shadow_replay harness：validated procedure + shadow_replay 上下文。 */
export async function runP3CanarySimulation(): Promise<CanaryResult> {
  return runHeldoutCases(
    buildCanaryValidatedProcedure(),
    CANARY_EXECUTION_CONTEXT,
    "HELDOUT_CASES (15 例) + P3_GATE_FROZEN 冻结值",
  );
}

/** Gate P4 canary harness：canary procedure + canary 上下文（限量发布模拟，effectless 只读）。 */
export async function runP3CanaryGateSimulation(): Promise<CanaryResult> {
  return runHeldoutCases(
    buildCanaryProcedure(),
    CANARY_GATE_EXECUTION_CONTEXT,
    "HELDOUT_CASES (15 例) + P3_GATE_FROZEN 冻结值 + validated→canary transition (canary:phase3-pagination-p4-gate-2026-08-16)",
  );
}

/** CLI 入口：node src/evaluation/phase4/canary.ts */
import { fileURLToPath } from "node:url";
import path from "node:path";

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isMain) {
  const result = await runP3CanarySimulation();
  const lines = [
    "=== Phase 4 shadow_replay harness（validated + shadow_replay）===",
    `total=${result.total}; fast_path=${result.fastPathCount}; abstain→slow=${result.abstainRoutedToSlowPath}; fallback=${result.fallbackCount}; denied=${result.deniedCount}; safety_stop=${result.safetyStopCount}`,
    `fallbackRecoveryRate=${result.fallbackRecoveryRate}; wrongFastPathRate=${result.wrongFastPathRate}; correctRejectionRate=${result.correctRejectionRate}`,
    ...result.perCase.map(
      (c) => `  ${c.caseId}: ${c.outcome} finding=${c.findingClass ?? "-"} expected=${c.expected} ${c.correct ? "ok" : "WRONG"}`,
    ),
  ];
  const gate = await runP3CanaryGateSimulation();
  lines.push(
    "=== Phase 4 Gate P4 canary harness（canary + canary 上下文）===",
    `total=${gate.total}; fast_path=${gate.fastPathCount}; abstain→slow=${gate.abstainRoutedToSlowPath}; fallback=${gate.fallbackCount}; denied=${gate.deniedCount}; safety_stop=${gate.safetyStopCount}`,
    `fallbackRecoveryRate=${gate.fallbackRecoveryRate}; wrongFastPathRate=${gate.wrongFastPathRate}; correctRejectionRate=${gate.correctRejectionRate}`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}
