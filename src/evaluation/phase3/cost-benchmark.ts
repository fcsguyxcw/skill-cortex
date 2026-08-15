/**
 * B6 — Phase 3 可重复成本 benchmark runner（project-local、可回放）。
 *
 * 冻结计费口径（ADR-0008 promotion gate 4 + implementation plan §8；纠正
 * phase3-gate-report §3 把“targeted tests + project typecheck”开发流水线墙钟计入
 * compile+validation 分子的保守高估——authoring/开发成本不计入 N_break-even；本口径
 * 按任务要求冻结，不是挑样本）：
 *
 * - compile + validation = procedure 运行时生成 + 验证成本，单次迭代 =
 *     a) inducePhase3ProcedureDraft（B4 induction seam，冻结契约事件，仅测代码路径延迟）；
 *     b) replayHeldoutPagination()（held-out 15 例 detector + evaluate；evaluate 内部对每例
 *        调用独立 verify()，即“held-out replay + 独立 verifier”，不重复计时）。
 *   重复 COMPILE_REPEATS 次取均值 + 标准差。
 * - slow path = 真实 Pi 慢路径检测单例 SQL 的 wall-clock：node <PI_CLI_PATH> -p -ne
 *   --no-session --provider <provider> --model <model> --thinking off，prompt 指示只读
 *   完整 SKILL.md + references/data-pagination.md 后分类；每例 1 次调用，SLOW_BATCHES 个批次。
 * - fast path = detectPagination 单例 wall-clock：每例每轮 FAST_ITERATIONS_PER_CASE 次，
 *   FAST_ROUNDS 轮，报告每例均值 + 标准差与总体均值。
 * - fallback = abstain 案例（H12–H14）仍走慢路径：meanFallback = mean over cases of
 *   (abstain ? perCaseMeanSlow : 0)。
 *
 * 输出：四类成本均值 + 标准差（方差），组装 RealCostEvidence 并经
 * validateRealCostEvidence 验证，如实报告 N_break-even（无论是否 ≤ 10）。
 * 不挑样本、不改阈值、不手工替换成本数字。
 *
 * 约束：不写工作区外；慢路径测量不落盘会话（--no-session）；CLI 模式把 JSON 报告写入
 * 仓库内 docs/reports/2026-08-14-phase3-cost-benchmark.json（project-local）。
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import { detectPagination } from "../../procedures/phase3/index.ts";
import { HELDOUT_CASES, type PaginationCase } from "./cases.ts";
import { inducePhase3ProcedureDraft } from "./induction.ts";
import { replayHeldoutPagination } from "./replay.ts";
import { validateRealCostEvidence, type RealCostEvidence } from "./metrics.ts";

/** 单次 node CLI 调用：resolve on close；超时 kill 并 reject（stdin 必须 ignore，避免 CLI 等待输入）。 */
function runPiOnce(args: readonly string[]): Promise<{ stdout: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`pi slow-path timeout after ${SLOW_PATH_CONFIG.perCallTimeoutMs}ms`));
    }, SLOW_PATH_CONFIG.perCallTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`pi slow-path exited ${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`));
        return;
      }
      resolve({ stdout, elapsedMs: performance.now() - started });
    });
  });
}

/** 冻结计费口径（修改任何一项即视为未冻结，报告须标注）。 */
export const FROZEN_COST_BASIS = {
  inputSet: "HELDOUT_CASES (src/evaluation/phase3/cases.ts, 15 frozen cases)",
  compileRepeats: 30,
  compileComponents: [
    "inducePhase3ProcedureDraft (frozen contract events, measurement-only input)",
    "replayHeldoutPagination (detector + evaluate; evaluate 内含每例独立 verify())",
  ],
  fastRounds: 5,
  fastIterationsPerCase: 2_000,
  slowBatches: 3,
  slowInvocation: "node <PI_CLI_PATH> -p -ne --no-session --provider <provider> --model <model> --thinking off",
  fallbackAbstainCaseIds: ["H12", "H13", "H14"] as readonly string[],
  nBreakEvenThreshold: 10,
} as const;

/** 慢路径 CLI 可配置（冻结默认 = 当前主机全局 CLI；可用环境变量覆盖，须在报告中记录）。 */
export const SLOW_PATH_CONFIG = {
  piCliPath:
    process.env.PI_CLI_PATH ??
    "C:/Users/a1324/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  skillDir:
    process.env.SKILL_DIR ??
    "C:/Users/a1324/.agents/skills/supabase-postgres-best-practices",
  provider: process.env.PI_PROVIDER ?? "deepseek",
  model: process.env.PI_MODEL ?? "deepseek-v4-flash",
  perCallTimeoutMs: 120_000,
} as const;

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const BENCHMARK_REPORT_PATH = path.join(
  PROJECT_ROOT,
  "docs",
  "reports",
  "2026-08-14-phase3-cost-benchmark.json",
);

/** 冻结 induction 输入（仅用于测量 compile+validation 的代码路径延迟，不构成 promotion 证据）。 */
function frozenInductionEvents(): readonly PracticeEvent[] {
  const mk = (id: number): PracticeEvent => ({
    schemaVersion: 1,
    eventId: `obs-cost-${id}`,
    occurredAt: `2026-08-15T0${id}:30:00.000Z`,
    tenantScope: "project:abcdef0123456789abcdef0123456789",
    provenance: "real",
    parentSkillId: `skill:${"a".repeat(64)}`,
    parentSkillRevision: `rev:${"b".repeat(64)}`,
    sourceHash: `sha256:${"c".repeat(64)}`,
    routeDecisionId: "route:00000000000000000000000000000000",
    candidateSkillIds: [`skill:${"a".repeat(64)}`],
    selectedSkillIds: [`skill:${"a".repeat(64)}`],
    executionMode: "skill_md",
    redactedTaskFeatures: ["prompt-hash:00000000000000000000000000000000"],
    environmentFingerprint: "pi:0.84.1",
    dependencyFingerprint: { sourceHash: `sha256:${"c".repeat(64)}`, environmentClass: "pi-0.84.1" },
    stepSummaries: [
      { stepId: `step-${id}`, actor: "tool", operationClass: "detect-offset-pagination", outcome: "ok" },
    ],
    authorizationResults: [],
    guardResults: [],
    verifierResults: [{ verifierId: "phase3-pagination-structured-finding", result: "pass" }],
    attribution: "verified_skill_effect",
    sensitivity: "none",
    retentionClass: "project_manual",
  });
  return [mk(1), mk(2)];
}

/** 冻结 induction 选项（与 B4 seam 合同一致；哈希固定）。 */
function frozenInductionOptions() {
  return {
    selectedReferenceHash: `sha256:${"d".repeat(64)}`,
    permissionPolicyHash: `sha256:${"e".repeat(64)}`,
  };
}

// ---------------------------------------------------------------------------
// 统计与组装（纯函数，可单测）
// ---------------------------------------------------------------------------

/** 算术均值；空集 → NaN。 */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** 样本标准差（n-1）；n<2 → 0（无方差证据，如实记 0 而非虚构）。 */
export function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export interface ComponentTiming {
  component: "compile_validation" | "fast_path" | "slow_path" | "fallback";
  /** 单位：latency_ms。 */
  meanMs: number;
  /** 样本标准差（latency_ms）；n<2 时记 0。 */
  stddevMs: number;
  /** 参与均值的样本数（每组件独立定义，见 FROZEN_COST_BASIS）。 */
  samples: number;
  /** 慢路径/快路径逐例明细（compile/fallback 无）。 */
  perCase?: Record<string, { meanMs: number; stddevMs: number; samples: number }>;
  /** 慢路径逐例原始观测（含批次序号），供审计。 */
  rawSamplesMs?: number[];
}

export interface BenchmarkReport {
  frozenBasis: typeof FROZEN_COST_BASIS;
  slowPathConfig: { piCliPath: string; skillDir: string; provider: string; model: string };
  measuredAt: string;
  compileValidation: ComponentTiming;
  fastPath: ComponentTiming;
  slowPath: ComponentTiming;
  fallback: ComponentTiming;
  realCostEvidence: RealCostEvidence;
  evidenceValidation: { ok: boolean; reasons?: string[] };
  slowPathOutputClasses?: Record<string, string[]>;
  /** 慢路径调用失败清单（本轮 0；样本缺口如实可见，不挑样本）。 */
  slowPathErrors: Array<{ caseId: string; batch: number; message: string }>;
}

/**
 * compile + validation 单次迭代 = induction + held-out replay（evaluate 内含独立 verify）。
 * 离线、确定性、无 LLM；输入冻结构造一次，迭代内只计时三个函数调用本身。
 */
export function measureCompileAndValidation(repeats?: number): ComponentTiming {
  const count = repeats ?? FROZEN_COST_BASIS.compileRepeats;
  const events = frozenInductionEvents();
  const options = frozenInductionOptions();
  const samples: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const started = performance.now();
    const induced = inducePhase3ProcedureDraft(events, options);
    if (!induced.ok) throw new Error(`frozen induction must succeed: ${induced.reason}`);
    replayHeldoutPagination();
    samples.push(performance.now() - started);
  }
  return { component: "compile_validation", meanMs: mean(samples), stddevMs: stddev(samples), samples: samples.length };
}

/**
 * fast path = detectPagination 单例 wall-clock。每轮遍历全部 held-out 案例，
 * 每例连续 FAST_ITERATIONS_PER_CASE 次；逐例跨轮取均值/标准差。
 */
export function measureFastPath(): ComponentTiming {
  const rounds = FROZEN_COST_BASIS.fastRounds;
  const iterations = FROZEN_COST_BASIS.fastIterationsPerCase;
  const perCaseSamples: Record<string, number[]> = {};
  for (const case_ of HELDOUT_CASES) perCaseSamples[case_.id] = [];

  // 预热（不计入样本）：各例 1,000 次，消除 JIT/模块加载冷启动。
  for (const case_ of HELDOUT_CASES) {
    for (let i = 0; i < 1_000; i += 1) detectPagination(case_.sql);
  }

  for (let round = 0; round < rounds; round += 1) {
    for (const case_ of HELDOUT_CASES) {
      const started = performance.now();
      for (let i = 0; i < iterations; i += 1) detectPagination(case_.sql);
      perCaseSamples[case_.id]!.push(performance.now() - started);
    }
  }

  const perCase: ComponentTiming["perCase"] = {};
  const flat: number[] = [];
  for (const case_ of HELDOUT_CASES) {
    const samples = perCaseSamples[case_.id]!;
    perCase[case_.id] = {
      meanMs: mean(samples) / iterations,
      stddevMs: stddev(samples) / iterations,
      samples: samples.length,
    };
    flat.push(...samples);
  }
  const caseMeans = HELDOUT_CASES.map((c) => perCase[c.id]!.meanMs);
  return {
    component: "fast_path",
    meanMs: mean(caseMeans),
    stddevMs: stddev(caseMeans),
    samples: flat.length,
    perCase,
  };
}

/** 慢路径 prompt 模板（冻结；单行，SQL 本身为单行）。 */
export function slowPathPrompt(skillDir: string, sql: string): string {
  return (
    `Read ${skillDir}/SKILL.md and ${skillDir}/references/data-pagination.md. ` +
    `Classify this SQL as exactly one of uses_offset|uses_keyset|no_pagination|abstain. ` +
    `Reply with ONLY the class name. SQL: ${sql}`
  );
}

const CLASS_TOKENS = ["uses_offset", "uses_keyset", "no_pagination", "abstain"] as const;

/** 从模型输出中解析首个分类 token（用于信息性正确性列；不参与成本）。 */
export function parseSlowPathClass(output: string): string | null {
  for (const token of CLASS_TOKENS) {
    const index = output.indexOf(token);
    if (index !== -1) return token;
  }
  return null;
}

export interface SlowPathMeasurementResult {
  timing: ComponentTiming;
  outputClasses: Record<string, string[]>;
  perCallMs: number[];
  errors: Array<{ caseId: string; batch: number; message: string }>;
}

/** 真实 Pi 慢路径：每例一次 node CLI 调用，SLOW_BATCHES 个批次，逐例计时。 */
export async function measureSlowPathReal(): Promise<SlowPathMeasurementResult> {
  const { piCliPath, skillDir, provider, model, perCallTimeoutMs } = SLOW_PATH_CONFIG;
  const batches = FROZEN_COST_BASIS.slowBatches;
  const perCaseSamples: Record<string, number[]> = {};
  const outputClasses: Record<string, string[]> = {};
  for (const case_ of HELDOUT_CASES) {
    perCaseSamples[case_.id] = [];
    outputClasses[case_.id] = [];
  }
  const perCallMs: number[] = [];
  const errors: SlowPathMeasurementResult["errors"] = [];

  for (let batch = 1; batch <= batches; batch += 1) {
    for (const case_ of HELDOUT_CASES) {
      const prompt = slowPathPrompt(skillDir, case_.sql);
      try {
        const { stdout, elapsedMs } = await runPiOnce([
          piCliPath,
          "-p",
          "-ne",
          "--no-session",
          "--provider",
          provider,
          "--model",
          model,
          "--thinking",
          "off",
          prompt,
        ]);
        perCaseSamples[case_.id]!.push(elapsedMs);
        perCallMs.push(elapsedMs);
        outputClasses[case_.id]!.push(parseSlowPathClass(stdout) ?? "<unparsed>");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ caseId: case_.id, batch, message });
        // 失败样本不入均值（如实报告 errors；不挑样本——失败即缺失，标记为测量缺口）。
      }
      process.stderr.write(
        `  batch ${batch}/${batches} ${case_.id} done (${perCaseSamples[case_.id]!.at(-1)?.toFixed(1) ?? "fail"} ms)\n`,
      );
    }
  }

  const perCase: ComponentTiming["perCase"] = {};
  for (const case_ of HELDOUT_CASES) {
    const samples = perCaseSamples[case_.id]!;
    perCase[case_.id] = {
      meanMs: mean(samples),
      stddevMs: stddev(samples),
      samples: samples.length,
    };
  }
  const caseMeans = HELDOUT_CASES.map((c) => perCase[c.id]!.meanMs).filter((v) => Number.isFinite(v));
  return {
    timing: {
      component: "slow_path",
      meanMs: mean(caseMeans),
      stddevMs: stddev(caseMeans),
      samples: perCallMs.length,
      perCase,
      rawSamplesMs: perCallMs,
    },
    outputClasses,
    perCallMs,
    errors,
  };
}

/** fallback = abstain 案例（H12–H14）仍走慢路径：mean over cases of (abstain ? perCaseMeanSlow : 0)。 */
export function deriveFallbackTiming(slowPath: ComponentTiming): ComponentTiming {
  const fallbackSamples: number[] = [];
  const perCase: ComponentTiming["perCase"] = {};
  for (const case_ of HELDOUT_CASES) {
    const isAbstain = FROZEN_COST_BASIS.fallbackAbstainCaseIds.includes(case_.id);
    const per = slowPath.perCase?.[case_.id];
    if (!isAbstain || per === undefined || !Number.isFinite(per.meanMs)) {
      perCase[case_.id] = { meanMs: 0, stddevMs: 0, samples: 0 };
      continue;
    }
    perCase[case_.id] = { ...per, meanMs: per.meanMs, stddevMs: per.stddevMs };
    fallbackSamples.push(per.meanMs);
  }
  const allCaseMeans = HELDOUT_CASES.map((c) => perCase[c.id]!.meanMs);
  return {
    component: "fallback",
    meanMs: mean(allCaseMeans),
    stddevMs: stddev(allCaseMeans),
    samples: fallbackSamples.length * FROZEN_COST_BASIS.slowBatches,
    perCase,
  };
}

/** 组装 RealCostEvidence（分母 ≤ 0 时 nBreakEven 记 0 并在验证中如实暴露 denominator_not_positive）。 */
export function assembleRealCostEvidence(
  compileValidationMs: number,
  slowPathMs: number,
  fastPathMs: number,
  fallbackMs: number,
  sampleSize: number,
): RealCostEvidence {
  const denominator = slowPathMs - fastPathMs - fallbackMs;
  const nBreakEven = denominator > 0 ? compileValidationMs / denominator : 0;
  return {
    unit: "latency_ms",
    compileAndValidationCost: compileValidationMs,
    meanSlowPathCost: slowPathMs,
    meanFastPathCost: fastPathMs,
    meanFallbackCost: fallbackMs,
    nBreakEven,
    sampleSize,
  };
}

/** 全量 benchmark（slowPath="real" 触发真实 Pi 慢路径；"skip" 仅供离线单测）。 */
export async function runCostBenchmark(options: {
  slowPath: "real" | "skip";
}): Promise<BenchmarkReport> {
  const compileValidation = measureCompileAndValidation();
  const fastPath = measureFastPath();

  let slowPath: ComponentTiming;
  let slowPathOutputClasses: Record<string, string[]> | undefined;
  let slowPathErrors: Array<{ caseId: string; batch: number; message: string }> = [];
  if (options.slowPath === "real") {
    const measured = await measureSlowPathReal();
    slowPath = measured.timing;
    slowPathOutputClasses = measured.outputClasses;
    slowPathErrors = measured.errors;
  } else {
    slowPath = { component: "slow_path", meanMs: 0, stddevMs: 0, samples: 0 };
  }

  const fallback = deriveFallbackTiming(slowPath);

  const sampleSize = slowPath.samples > 0 ? slowPath.samples : FROZEN_COST_BASIS.slowBatches * HELDOUT_CASES.length;
  const realCostEvidence = assembleRealCostEvidence(
    compileValidation.meanMs,
    slowPath.meanMs,
    fastPath.meanMs,
    fallback.meanMs,
    sampleSize,
  );
  const evidenceValidation = validateRealCostEvidence(realCostEvidence);

  const report: BenchmarkReport = {
    frozenBasis: FROZEN_COST_BASIS,
    slowPathConfig: {
      piCliPath: SLOW_PATH_CONFIG.piCliPath,
      skillDir: SLOW_PATH_CONFIG.skillDir,
      provider: SLOW_PATH_CONFIG.provider,
      model: SLOW_PATH_CONFIG.model,
    },
    measuredAt: new Date().toISOString(),
    compileValidation,
    fastPath,
    slowPath,
    fallback,
    realCostEvidence,
    evidenceValidation: evidenceValidation.ok
      ? { ok: true }
      : { ok: false, reasons: (evidenceValidation as { reasons: string[] }).reasons },
    slowPathOutputClasses,
    slowPathErrors,
  };
  return report;
}

export function formatBenchmarkReport(report: BenchmarkReport): string {
  const e = report.realCostEvidence;
  const fmt = (v: number) => v.toFixed(3);
  const lines = [
    "=== Phase 3 cost benchmark（B6）===",
    `frozen basis: ${JSON.stringify(report.frozenBasis)}`,
    `slow path: ${report.slowPathConfig.piCliPath} | ${report.slowPathConfig.provider}/${report.slowPathConfig.model} | skill=${report.slowPathConfig.skillDir}`,
    `measuredAt: ${report.measuredAt}`,
    "",
    "component            meanMs        stddevMs      samples",
    `compile_validation   ${fmt(report.compileValidation.meanMs).padStart(12)}  ${fmt(report.compileValidation.stddevMs).padStart(12)}  ${report.compileValidation.samples}`,
    `slow_path            ${fmt(report.slowPath.meanMs).padStart(12)}  ${fmt(report.slowPath.stddevMs).padStart(12)}  ${report.slowPath.samples}`,
    `fast_path            ${fmt(report.fastPath.meanMs).padStart(12)}  ${fmt(report.fastPath.stddevMs).padStart(12)}  ${report.fastPath.samples}`,
    `fallback             ${fmt(report.fallback.meanMs).padStart(12)}  ${fmt(report.fallback.stddevMs).padStart(12)}  ${report.fallback.samples}`,
    "",
    `N_break-even = compile / (slow − fast − fallback)`,
    `            = ${fmt(e.compileAndValidationCost)} / (${fmt(e.meanSlowPathCost)} − ${fmt(e.meanFastPathCost)} − ${fmt(e.meanFallbackCost)})`,
    `            = ${fmt(e.nBreakEven)} (threshold ≤ ${report.frozenBasis.nBreakEvenThreshold})`,
    `evidence validation: ${report.evidenceValidation.ok ? "PASS" : "FAIL " + JSON.stringify(report.evidenceValidation.reasons)}`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI 入口：node src/evaluation/phase3/cost-benchmark.ts [--write-report]
// ---------------------------------------------------------------------------
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const writeReport = process.argv.includes("--write-report");
  const report = await runCostBenchmark({ slowPath: "real" });
  process.stdout.write(`${formatBenchmarkReport(report)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (writeReport) {
    writeFileSync(BENCHMARK_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`report written: ${BENCHMARK_REPORT_PATH}\n`);
  }
  if (!report.evidenceValidation.ok) {
    process.exitCode = 1;
  }
}
