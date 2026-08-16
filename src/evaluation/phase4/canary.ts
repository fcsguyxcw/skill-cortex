/**
 * Phase 4 — project-local canary 模拟（不真实宿主部署、不写用户环境）。
 *
 * 用冻结的 P3 validated procedure（buildPhase3ProcedureDraft + transition 确定性构造）
 * 通过 Execution Orchestrator 跑冻结 held-out 案例集：detectPagination 快路径；
 * finding=abstain 的案例按 ADR-0008 回退慢路径（project-local 模拟加载父 SKILL.md）。
 *
 * 分栏指标（implementation plan §9，不得用单一加权总分掩盖）：
 * - fallbackRecoveryRate：guard/verifier/procedure 失败回退后慢路径成功加载率；
 * - wrongFastPathRate：非 abstain 期望案例中快路径输出类别错误率；
 * - correctRejectionRate：应 abstain 案例中被正确路由到慢路径的比例。
 *
 * 冻结值（P3_GATE_FROZEN，与 Gate P3 闭环一致）；permissionPolicyHash 为 Owner 占位。
 */
import { buildPhase3ProcedureDraft, transitionPhase3ProcedureValidation } from "../../procedures/phase3/draft.ts";
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

/** 冻结构造 validated procedure（确定性；与 P3 Gate 闭环同一冻结值）。 */
export function buildCanaryValidatedProcedure() {
  const draft = buildPhase3ProcedureDraft({
    parentSkillId: P3_GATE_FROZEN.parentSkillId,
    parentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
    skillMdHash: P3_GATE_FROZEN.sourceHash,
    selectedReferenceHash: P3_GATE_FROZEN.selectedReferenceHash,
    permissionPolicyHash: P3_GATE_FROZEN.permissionPolicyHash,
    createdAt: "2026-08-15T00:00:00.000Z",
    evidenceIds: [...P3_GATE_FROZEN.eventIds],
  });
  return transitionPhase3ProcedureValidation(draft, {
    decision: "validated",
    validationReportId: P3_GATE_FROZEN.validationReportId,
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
  outcome: ExecutionOutcome["outcome"] | "abstain_routed_slow";
  findingClass: string | null;
  correct: boolean;
  /** fallback 后慢路径是否成功加载（恢复证据）。 */
  recovered?: boolean;
}

export interface CanaryResult {
  frozenBasis: string;
  total: number;
  fastPathCount: number;
  abstainRoutedToSlowPath: number;
  fallbackCount: number;
  deniedCount: number;
  /** 分栏指标（N/A 表示分母为 0，不进入判定）。 */
  fallbackRecoveryRate: number | "N/A";
  wrongFastPathRate: number | "N/A";
  correctRejectionRate: number | "N/A";
  perCase: CanaryPerCase[];
}

/** project-local canary：validated procedure 跑冻结 held-out 集。确定性可回放。 */
export async function runP3CanarySimulation(): Promise<CanaryResult> {
  const procedure = buildCanaryValidatedProcedure();
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
      if (finding.class === "abstain") {
        // 程序判定 abstain ⇒ ADR-0008 回退慢路径（project-local 模拟）。
        await services.loadParentSkill(outcome.decision);
        perCase.push({
          caseId: case_.id,
          expected: case_.expected,
          outcome: "abstain_routed_slow",
          findingClass: finding.class,
          correct: case_.expected === "abstain",
        });
        continue;
      }
      perCase.push({
        caseId: case_.id,
        expected: case_.expected,
        outcome: "fast_path",
        findingClass: finding.class,
        correct: finding.class === case_.expected,
      });
      continue;
    }

    perCase.push({
      caseId: case_.id,
      expected: case_.expected,
      outcome: outcome.outcome,
      findingClass: null,
      correct: false, // held-out 上 fallback/denied 不是预期结果（防御停止，不算正确分类）
      recovered: outcome.outcome === "fallback" ? outcome.slowPath.loaded : undefined,
    });
  }

  const fastPathCases = perCase.filter((c) => c.outcome === "fast_path");
  const abstainRouted = perCase.filter((c) => c.outcome === "abstain_routed_slow");
  const fallbacks = perCase.filter((c) => c.outcome === "fallback");
  const denied = perCase.filter((c) => c.outcome === "denied");

  const fastPathNonAbstainExpected = fastPathCases.filter((c) => c.expected !== "abstain");
  const wrongFastPath = fastPathCases.filter((c) => c.expected !== "abstain" && !c.correct);

  return {
    frozenBasis: "HELDOUT_CASES (15 例) + P3_GATE_FROZEN 冻结值",
    total: perCase.length,
    fastPathCount: fastPathCases.length,
    abstainRoutedToSlowPath: abstainRouted.length,
    fallbackCount: fallbacks.length,
    deniedCount: denied.length,
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

/** CLI 入口：node src/evaluation/phase4/canary.ts */
import { fileURLToPath } from "node:url";
import path from "node:path";

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isMain) {
  const result = await runP3CanarySimulation();
  const lines = [
    "=== Phase 4 project-local canary（detectPagination 快路径）===",
    `total=${result.total}; fast_path=${result.fastPathCount}; abstain→slow=${result.abstainRoutedToSlowPath}; fallback=${result.fallbackCount}; denied=${result.deniedCount}`,
    `fallbackRecoveryRate=${result.fallbackRecoveryRate}; wrongFastPathRate=${result.wrongFastPathRate}; correctRejectionRate=${result.correctRejectionRate}`,
    ...result.perCase.map(
      (c) => `  ${c.caseId}: ${c.outcome} finding=${c.findingClass ?? "-"} expected=${c.expected} ${c.correct ? "ok" : "WRONG"}`,
    ),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}
