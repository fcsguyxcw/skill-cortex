/**
 * Phase 3 指标汇总、成本模型与 promotion 硬门判定（阈值文档 §6/§7）。
 *
 * 独立性：本模块只消费（case, finding）与冻结阈值；不导入候选 detector
 * （src/procedures/phase3/），不调用 LLM。分母为 0 的指标记为 "N/A"（既不算 0
 * 也不算 1，不进入 promotion 判定）。缺 finding 的 case 计为 fail(missing_finding)，
 * 与全 abstain 一样无法逃过 accuracy（防“部分提交/全回退”逃逸）。
 */

import type { PaginationCase } from "./cases.ts";
import {
  inspectPracticeEvidenceAssessment,
  type PracticeEvidenceAssessment,
  type PracticeEvidenceBinding,
} from "./practice-evidence.ts";
import { isFindingClass, verify, type VerifyCode } from "./verifier.ts";

export const THRESHOLDS = {
  accuracy: 0.95,
  offsetRecall: 1.0,
  offsetFpr: 0.05,
  expectedAbstainRecall: 1.0,
  abstainRate: 0.20,
  unexpectedAbstainRate: 0.10,
  nBreakEven: 10,
} as const;

/** 指标值：number 或 "N/A"（分母=0）。N/A 不参与判定。 */
export type MetricValue = number | "N/A";

export interface MetricsCounts {
  total: number;
  offsetExpected: number;
  nonOffsetExpected: number;
  abstainExpected: number;
  nonAbstainExpected: number;
  offsetPredicted: number; // 全部案例中 finding.class=uses_offset 数
  abstainPredicted: number;
  passed: number;
}

export interface Metrics {
  accuracy: MetricValue;
  offsetRecall: MetricValue;
  offsetFpr: MetricValue;
  expectedAbstainRecall: MetricValue;
  abstainRate: MetricValue;
  unexpectedAbstainRate: MetricValue;
  counts: MetricsCounts;
}

export type EvalOutcome =
  | { pass: true; code: "ok"; findingClass: string | null }
  | { pass: false; code: Exclude<VerifyCode, "ok"> | "missing_finding"; findingClass: string | null };

export interface PerCaseResult {
  caseId: string;
  expected: PaginationCase["expected"];
  findingClass: string | null;
  outcome: EvalOutcome;
}

export interface EvaluationReport {
  perCase: PerCaseResult[];
  metrics: Metrics;
}

function ratio(numerator: number, denominator: number): MetricValue {
  return denominator === 0 ? "N/A" : numerator / denominator;
}

/** 缺 finding 或 finding 结构无效时 class 取 null。 */
function findingClassOf(finding: unknown): string | null {
  if (typeof finding !== "object" || finding === null || !("class" in finding)) return null;
  const cls = (finding as { class?: unknown }).class;
  return typeof cls === "string" ? cls : null;
}

/**
 * 汇总：case.id ↔ finding 配对后逐例 verify；缺 finding 计 fail(missing_finding)。
 * 指标全部按阈值文档 §6 精确定义（分子/分母见 Metrics 注释与 counts）。
 */
export function evaluate(
  cases: readonly PaginationCase[],
  findings: ReadonlyMap<string, unknown>,
): EvaluationReport {
  const perCase: PerCaseResult[] = cases.map((c) => {
    const finding = findings.get(c.id);
    if (finding === undefined) {
      return { caseId: c.id, expected: c.expected, findingClass: null, outcome: { pass: false, code: "missing_finding", findingClass: null } };
    }
    const findingClass = findingClassOf(finding);
    const result = verify(c, finding);
    let outcome: EvalOutcome;
    if (result.pass) {
      outcome = { pass: true, code: "ok", findingClass };
    } else {
      // fail 分支 code 不含 "ok"（防御分支保持类型精确）
      const code: Exclude<VerifyCode, "ok"> = result.code === "ok" ? "label_mismatch" : result.code;
      outcome = { pass: false, code, findingClass };
    }
    return { caseId: c.id, expected: c.expected, findingClass, outcome };
  });

  const passed = perCase.filter((r) => r.outcome.pass).length;
  const offsetExpected = perCase.filter((r) => r.expected === "uses_offset");
  const nonOffsetExpected = perCase.filter((r) => r.expected !== "uses_offset");
  const abstainExpected = perCase.filter((r) => r.expected === "abstain");
  const nonAbstainExpected = perCase.filter((r) => r.expected !== "abstain");
  const offsetPredicted = perCase.filter((r) => r.findingClass === "uses_offset");
  const abstainPredicted = perCase.filter((r) => r.findingClass === "abstain");

  const counts: MetricsCounts = {
    total: perCase.length,
    offsetExpected: offsetExpected.length,
    nonOffsetExpected: nonOffsetExpected.length,
    abstainExpected: abstainExpected.length,
    nonAbstainExpected: nonAbstainExpected.length,
    offsetPredicted: offsetPredicted.length,
    abstainPredicted: abstainPredicted.length,
    passed,
  };

  const metrics: Metrics = {
    // accuracy 分母 = 全部案例（含 abstain）——全 abstain 无法逃过
    accuracy: ratio(passed, counts.total),
    offsetRecall: ratio(offsetExpected.filter((r) => r.outcome.pass).length, counts.offsetExpected),
    offsetFpr: ratio(
      nonOffsetExpected.filter((r) => r.findingClass === "uses_offset").length,
      counts.nonOffsetExpected,
    ),
    expectedAbstainRecall: ratio(
      abstainExpected.filter((r) => r.outcome.pass).length,
      counts.abstainExpected,
    ),
    abstainRate: ratio(counts.abstainPredicted, counts.total),
    unexpectedAbstainRate: ratio(
      nonAbstainExpected.filter((r) => r.findingClass === "abstain").length,
      counts.nonAbstainExpected,
    ),
    counts,
  };
  return { perCase, metrics };
}

// ---------------------------------------------------------------------------
// 成本模型（阈值文档 §6.1，字节口径，可复现、无 LLM）
// ---------------------------------------------------------------------------

export interface CostReport {
  compileAndValidationCost: number; // 一次性（reference 字节 + 全部案例 sql 字节）
  meanSlowPathCost: number;
  meanFastPathCost: number;
  meanFallbackCost: number;
  /** N_break-even；分母 ≤ 0（无净节省）时记 "N/A"，不参与判定。 */
  nBreakEven: MetricValue;
}

export interface CostInput {
  referenceBytes: number; // fs.statSync().size 采集 data-pagination.md 字节
  cases: readonly PaginationCase[];
  findings: ReadonlyMap<string, unknown>; // abstain 判定用
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * 慢路径必读 reference + 查询；快路径只扫查询；fallback 对 abstain 案例仍按慢路径计
 * （阈值文档 §6.1：fallback_cost(c) = 对 abstain/低置信案例仍按 slow_path_cost 计）。
 */
export function computeCost(input: CostInput): CostReport {
  const compileAndValidationCost =
    input.referenceBytes +
    input.cases.reduce((sum, c) => sum + byteLength(c.sql), 0);
  const perCase = input.cases.map((c) => {
    const slow = input.referenceBytes + byteLength(c.sql);
    const fast = byteLength(c.sql);
    const finding = input.findings.get(c.id);
    const cls = findingClassOf(finding);
    const isAbstain = cls === "abstain";
    const fallback = isAbstain ? slow : 0;
    return { slow, fast, fallback };
  });

  const meanSlowPathCost =
    perCase.length === 0 ? 0 : perCase.reduce((s, x) => s + x.slow, 0) / perCase.length;
  const meanFastPathCost =
    perCase.length === 0 ? 0 : perCase.reduce((s, x) => s + x.fast, 0) / perCase.length;
  const meanFallbackCost =
    perCase.length === 0 ? 0 : perCase.reduce((s, x) => s + x.fallback, 0) / perCase.length;

  const denominator = meanSlowPathCost - meanFastPathCost - meanFallbackCost;
  // 分母=0 或为负（abstain 占比过高导致无净节省）→ N/A，N_break-even 不参与判定
  const nBreakEven: MetricValue =
    denominator > 0 ? compileAndValidationCost / denominator : "N/A";

  return { compileAndValidationCost, meanSlowPathCost, meanFastPathCost, meanFallbackCost, nBreakEven };
}

// ---------------------------------------------------------------------------
// Promotion 硬门（阈值文档 §7；单一加权总分不得掩盖任一维度失败）
// ---------------------------------------------------------------------------

export type GateStatus = "pass" | "fail";

export interface GateResult {
  gateId: string;
  name: string;
  status: GateStatus;
  detail: string;
}

/**
 * 真实宿主 LLM 成本证据（结构化，防 boolean 自证）。缺失/无效 = blocker fail。
 * 字节口径 comparator（CostReport）永不进入本证据。
 */
export interface RealCostEvidence {
  unit: "latency_ms" | "tokens";
  compileAndValidationCost: number;
  meanSlowPathCost: number;
  meanFastPathCost: number;
  meanFallbackCost: number;
  nBreakEven: number;
  sampleSize: number;
}

const REAL_COST_FIELDS = [
  "compileAndValidationCost",
  "meanSlowPathCost",
  "meanFastPathCost",
  "meanFallbackCost",
  "nBreakEven",
  "sampleSize",
] as const;

/**
 * 验证真实成本证据：全部字段有限且非负、sampleSize 为正整数、
 * 分母语义有效（meanSlow − meanFast − meanFallback > 0）且 nBreakEven 与
 * 公式自洽（防任意伪造值）。任一不满足 → { ok: false, reasons }。
 */
export function validateRealCostEvidence(e: unknown): { ok: true } | { ok: false; reasons: string[] } {
  if (typeof e !== "object" || e === null) {
    return { ok: false, reasons: ["not_object"] };
  }
  const r = e as Record<string, unknown>;
  const reasons: string[] = [];
  if (r.unit !== "latency_ms" && r.unit !== "tokens") reasons.push("unit_invalid");

  const values: Record<string, number> = {};
  for (const field of REAL_COST_FIELDS) {
    const v = r[field];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      reasons.push(`${field}_not_finite`);
      continue;
    }
    if (v < 0) reasons.push(`${field}_negative`);
    values[field] = v;
  }
  const sampleSize = r.sampleSize as unknown;
  if (typeof sampleSize === "number" && Number.isFinite(sampleSize) && sampleSize >= 0 && !Number.isInteger(sampleSize)) {
    reasons.push("sample_size_not_integer");
  }
  if (typeof sampleSize === "number" && Number.isFinite(sampleSize) && sampleSize <= 0) {
    reasons.push("sample_size_zero");
  }

  if (reasons.length === 0 && values.compileAndValidationCost !== undefined) {
    const denominator =
      values.meanSlowPathCost - values.meanFastPathCost - values.meanFallbackCost;
    if (!(denominator > 0)) {
      reasons.push("denominator_not_positive");
    } else {
      const expected = values.compileAndValidationCost / denominator;
      if (Math.abs(values.nBreakEven - expected) > 1e-9 * Math.max(1, Math.abs(expected))) {
        reasons.push("n_break_even_inconsistent");
      }
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export interface PromotionInput {
  metrics: Metrics;
  /**
   * ADR-0008 可归因使用证据引用（必填；当前仓库无 real pagination evidence，调用方传空数组
   * → practice_evidence 门 fail，保持 draft）。与 evidenceIndependenceOk（train/heldout 独立性）
   * 是两个不同门：前者证明“多次真实可归因使用”，后者防评测泄漏，不互相替代。
   */
  practiceEvidence: PracticeEvidenceAssessment;
  /** Parent binding copied from the procedure draft; assessment reuse across procedures fails. */
  practiceEvidenceBinding: PracticeEvidenceBinding;
  /** 真实宿主 LLM 成本证据（缺失或无效 = §7.9 blocker fail；cost gate 只用它）。 */
  realCostEvidence?: RealCostEvidence;
  /** 字节口径 comparator（阈值文档 §6.1）：仅独立参考输出，永不参与 promotion 判定。 */
  byteCostReference?: CostReport;
  /** §7.2：静态审查声明——artifact 无 SQL 执行/数据库连接/网络/自动改写。 */
  artifactSafetyOk: boolean;
  /** §7.3：绑定父 skill_id + revision + dependency fingerprint。 */
  sourceBindingOk: boolean;
  /** §7.4：Owner 声明 held-out 未用于调参/反向修正，标签未回改。 */
  evidenceIndependenceOk: boolean;
  /** §7.5：verifier 独立于 procedure/LLM 自评（本实现即独立 verifier，仍由 Owner 确认）。 */
  verifierIndependenceOk: boolean;
  /** §7.10：procedure 未超出只读静态检测声明范围。 */
  scopeConformanceOk: boolean;
}

function gate(gateId: string, name: string, status: GateStatus, detail: string): GateResult {
  return { gateId, name, status, detail };
}

/**
 * 指标比较：N/A（分母=0/空集）→ 明确 fail(insufficient_evidence)，绝不因“非 fail”进入
 * validated——promotion 所需的任何指标缺失即为证据不足。
 */
function cmp(
  value: MetricValue,
  op: ">=" | "<=",
  threshold: number,
  label: string,
): GateStatus {
  if (value === "N/A") return "fail";
  return op === ">=" ? (value >= threshold ? "pass" : "fail") : value <= threshold ? "pass" : "fail";
}

function insufficient(label: string): string {
  return `${label}=N/A（分母=0/空集）→ insufficient_evidence：无证据支持该门，保持 draft`;
}

/** 判定：任一 fail → draft（保持父 SKILL.md 慢路径）；所有门 pass → validated。 */
export function judgePromotion(input: PromotionInput): {
  gates: GateResult[];
  decision: "validated" | "draft";
  /** 字节口径 comparator 独立参考输出（永不参与判定）。 */
  byteCostReference: CostReport | undefined;
} {
  const { metrics } = input;
  const gates: GateResult[] = [];

  // §7.1 质量硬门：offset recall = 1.0（漏报 OFFSET 使检测失效）；N/A → insufficient_evidence
  gates.push(
    gate(
      "offset_recall",
      "offset recall = 1.0（质量硬门）",
      metrics.offsetRecall === "N/A" ? "fail" : cmp(metrics.offsetRecall, ">=", THRESHOLDS.offsetRecall, "offsetRecall"),
      metrics.offsetRecall === "N/A"
        ? insufficient("offsetRecall")
        : `offsetRecall=${metrics.offsetRecall}（|H_offset|=${metrics.counts.offsetExpected}）`,
    ),
  );

  // ADR-0008 架构硬门：至少 2 个 distinct provenance=real 的受控 eventId（多次真实可归因使用）
  const practiceEvidence = inspectPracticeEvidenceAssessment(
    input.practiceEvidence,
    input.practiceEvidenceBinding,
  );
  gates.push(
    gate(
      "practice_evidence",
      "≥2 个 Store-verified、policy-valid、父绑定匹配的 distinct real PracticeEvent",
      practiceEvidence.ok ? "pass" : "fail",
      practiceEvidence.ok
        ? `distinct real eventIds=${practiceEvidence.distinctRealCount} ≥ 2`
        : practiceEvidence.reason,
    ),
  );

  // §7.2 结构化安全（真正安全门）：无执行/连接/网络/自动改写
  gates.push(
    gate(
      "artifact_safety",
      "无 SQL 执行/连接/网络/自动改写（静态审查）",
      input.artifactSafetyOk ? "pass" : "fail",
      input.artifactSafetyOk ? "静态审查通过" : "发现执行/连接/网络/改写调用或意图",
    ),
  );

  // §7.3 来源一致性：绑定父 skill_id + revision + dependency fingerprint
  gates.push(
    gate(
      "source_binding",
      "绑定父 skill_id + revision + dependency fingerprint",
      input.sourceBindingOk ? "pass" : "fail",
      input.sourceBindingOk ? "绑定声明齐备" : "绑定缺失（skill/revision/fingerprint）",
    ),
  );

  // §7.4 证据独立（训练-验证泄漏防护）
  gates.push(
    gate(
      "evidence_independence",
      "held-out 未用于调参/反向修正，标签未回改",
      input.evidenceIndependenceOk ? "pass" : "fail",
      input.evidenceIndependenceOk ? "Owner 声明证据独立" : "存在 held-out 泄漏或标签回改",
    ),
  );

  // §7.5 verifier 独立（不用 LLM 自评/procedure 自证）
  gates.push(
    gate(
      "verifier_independence",
      "verifier 独立于 procedure/LLM 自评",
      input.verifierIndependenceOk ? "pass" : "fail",
      input.verifierIndependenceOk ? "冻结 oracle + 独立 verifier" : "使用 LLM 自评或 procedure 自证",
    ),
  );

  // §7.6 correctness：accuracy ≥ 0.95 且 FPR ≤ 0.05 且 expected-abstain recall = 1.0
  // 任一子指标 N/A → insufficient_evidence fail（不因“非 fail”蒙混）
  const acc = metrics.accuracy;
  const fpr = metrics.offsetFpr;
  const abRecall = metrics.expectedAbstainRecall;
  const correctnessFailures: string[] = [];
  if (acc === "N/A") correctnessFailures.push(insufficient("accuracy"));
  else if (acc < THRESHOLDS.accuracy) correctnessFailures.push(`accuracy=${acc} < ${THRESHOLDS.accuracy}`);
  if (fpr === "N/A") correctnessFailures.push(insufficient("offsetFpr"));
  else if (fpr > THRESHOLDS.offsetFpr) correctnessFailures.push(`offsetFpr=${fpr} > ${THRESHOLDS.offsetFpr}`);
  if (abRecall === "N/A") correctnessFailures.push(insufficient("expectedAbstainRecall"));
  else if (abRecall < THRESHOLDS.expectedAbstainRecall) correctnessFailures.push(`expectedAbstainRecall=${abRecall} < ${THRESHOLDS.expectedAbstainRecall}`);
  gates.push(
    gate(
      "correctness",
      "accuracy≥0.95 且 offset FPR≤0.05 且 expected-abstain recall=1.0",
      correctnessFailures.length === 0 ? "pass" : "fail",
      correctnessFailures.length === 0
        ? `accuracy=${acc}; offsetFpr=${fpr}; expectedAbstainRecall=${abRecall}`
        : correctnessFailures.join("; "),
    ),
  );

  // §7.7 回退：unexpected-abstain rate ≤ 0.10
  gates.push(
    gate(
      "fallback",
      "unexpected-abstain rate ≤ 0.10",
      metrics.unexpectedAbstainRate === "N/A" ? "fail" : cmp(metrics.unexpectedAbstainRate, "<=", THRESHOLDS.unexpectedAbstainRate, "unexpectedAbstainRate"),
      metrics.unexpectedAbstainRate === "N/A"
        ? insufficient("unexpectedAbstainRate")
        : `unexpectedAbstainRate=${metrics.unexpectedAbstainRate}（|H_nonabstain|=${metrics.counts.nonAbstainExpected}）`,
    ),
  );

  // §7.8 成本：abstain rate ≤ 0.20（N/A → insufficient_evidence）；nBreakEven 只用真实
  // evidence（unit=latency_ms/tokens），字节口径 byteCostReference 永不参与。
  const ar = metrics.abstainRate;
  const costFailures: string[] = [];
  if (ar === "N/A") costFailures.push(insufficient("abstainRate"));
  else if (ar > THRESHOLDS.abstainRate) costFailures.push(`abstainRate=${ar} > ${THRESHOLDS.abstainRate}`);
  let costDetail = `abstainRate=${ar}`;
  if (input.realCostEvidence !== undefined) {
    const validation = validateRealCostEvidence(input.realCostEvidence);
    if (!validation.ok) {
      costFailures.push(`realCostEvidence 无效: ${validation.reasons.join(",")}`);
    } else if (input.realCostEvidence.nBreakEven > THRESHOLDS.nBreakEven) {
      costFailures.push(`nBreakEven=${input.realCostEvidence.nBreakEven} > ${THRESHOLDS.nBreakEven}`);
    }
    costDetail += `; realCostEvidence[${input.realCostEvidence.unit}] nBreakEven=${input.realCostEvidence.nBreakEven}`;
  } else {
    costDetail += "；无真实成本证据（cost gate 的 nBreakEven 不参与，见 §7.9 blocker）";
  }
  if (input.byteCostReference !== undefined) {
    costDetail += `；字节口径 comparator（独立参考，永不参与判定）nBreakEven=${input.byteCostReference.nBreakEven}`;
  }
  gates.push(
    gate(
      "cost",
      "abstain rate ≤ 0.20；nBreakEven ≤ 10（仅真实 evidence）",
      costFailures.length === 0 ? "pass" : "fail",
      costFailures.length === 0 ? costDetail : costFailures.join("; "),
    ),
  );

  // §7.9 Gate P3 blocker：真实宿主 LLM 慢路径成本证据（结构化、验证通过）；
  // 缺失或无效 → fail（不得以 boolean 自证，不得以字节 comparator 冒充）
  const evidence = input.realCostEvidence;
  const evidenceValidation = evidence === undefined ? undefined : validateRealCostEvidence(evidence);
  gates.push(
    gate(
      "real_cost_evidence",
      "真实宿主 LLM 慢路径成本证据（结构化 unit/sampleSize/分母语义验证）",
      evidence !== undefined && evidenceValidation?.ok === true ? "pass" : "fail",
      evidence === undefined
        ? "缺失：无真实 LLM 成本证据（Gate P3 blocker）；字节 comparator 不构成 token/latency 节省证明"
        : evidenceValidation!.ok
          ? `已验证：unit=${evidence.unit}; sampleSize=${evidence.sampleSize}; nBreakEven=${evidence.nBreakEven}`
          : `无效：${(evidenceValidation as { ok: false; reasons: string[] }).reasons.join(",")}`,
    ),
  );

  // §7.10 越权：procedure 未超出只读静态检测声明范围
  gates.push(
    gate(
      "scope_conformance",
      "未超出只读静态检测声明范围",
      input.scopeConformanceOk ? "pass" : "fail",
      input.scopeConformanceOk ? "仅只读静态检测" : "超出声明范围（含写操作等）",
    ),
  );

  const decision: "validated" | "draft" = gates.some((g) => g.status === "fail") ? "draft" : "validated";
  return { gates, decision, byteCostReference: input.byteCostReference };
}
