/**
 * Phase 3 Gate P3 正式闭环 validation runner（narrow；禁止启动 Phase 4）。
 *
 * 整链（13 步口径，全部使用真实证据，非 fixture）：
 * 1. 从 project-local PracticeStore 读 2 条真实事件（tenantScope + eventId 冻结）；
 * 2. inducePhase3ProcedureDraft(realEvents, frozen hashes)，确认 draft 绑定冻结父身份一致；
 * 3. resolvePracticeEvidence（真实绑定 + requiredOperationClass/VerifierId）→ 真实 assessment；
 * 4. 读 docs/reports/2026-08-14-phase3-cost-benchmark.json 的 realCostEvidence（validate）；
 * 5. replayHeldoutPagination() → held-out metrics；
 * 6. checkPhase3ProcedureBindings → sourceBindingOk（不是裸 boolean 声明）；
 * 7. judgePromotion → 11 门；要求 11/11 PASS + decision=validated；
 * 8. validated 时调 transitionPhase3ProcedureValidation（draft→validated，合法 validationReportId），
 *    生成正式 validation report 写入 docs/reports/。
 *
 * 确定性可回放：同一 store 状态 + 冻结输入 → 同一结果（不依赖当前 Agent 选择、不写 Store）。
 * 失败路径：任何前置步骤失败 → decision=draft，不执行 transition，result 明确记录失败步骤。
 *
 * 冻结值：parent skill:670b8f65…/rev:ce271d33…/sourceHash sha256:8e5a86aa…；
 * selectedReferenceHash=sha256:73c9fa10…；permissionPolicyHash 按 ADR-0011 省略
 * （effectless/permissionless pilot 不绑定权限策略；任何占位都不作真实 binding evidence）。
 *
 * 来源隔离（ADR-0011 §7）：sourceMode 由入口 options 是否带任何 override 决定（纯函数
 * sourceModeOf，不信任事件内自报 provenance/attribution 字段升级）。仅
 * formal_real_store（完全无 override 的默认 project-local store）可执行 draft→validated
 * transition；evaluation_fixture（任一注入 override）下 judgePromotion 结果只作为结构测试
 * assessmentDecision，公开 decision 恒保持 draft 并记录 transitionBlockedReason=non_formal_source。
 * CLI（--write-report）无 options，是唯一正式入口，写报告前断言 allowFormalReportWrite。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import {
  checkPhase3ProcedureBindings,
  transitionPhase3ProcedureValidation,
  type Phase3ProcedureDraft,
  type Phase3ValidatedProcedure,
} from "../../procedures/phase3/draft.ts";
import { PAGINATION_DETECTOR_SCHEMA_VERSION, PAGINATION_DETECTOR_VERSION } from "../../procedures/phase3/detector.ts";
import { HELDOUT_CASES } from "./cases.ts";
import { inducePhase3ProcedureDraft } from "./induction.ts";
import {
  judgePromotion,
  validateRealCostEvidence,
  type GateResult,
  type Metrics,
  type RealCostEvidence,
} from "./metrics.ts";
import { resolvePracticeEvidence, type PracticeEvidenceAssessment } from "./practice-evidence.ts";
import { replayHeldoutPagination } from "./replay.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

/** Gate P3 正式闭环冻结常量（修改任何一项即视为未冻结）。 */
export const P3_GATE_FROZEN = {
  tenantScope: "project:bcf863bcbed32e5513c21e03a7fbebab",
  eventIds: [
    "obs-79b95a7214bcc42134378bef3428132e2582e32e",
    "obs-9ee1fe7756f2334733d47fcb67aa16463393401b",
  ],
  parentSkillId: "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2",
  parentSkillRevision: "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec",
  sourceHash: "sha256:8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830",
  selectedReferenceHash: "sha256:73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa",
  /** ADR-0011：effectless/permissionless pilot 显式省略（不构成依赖绑定约束）。 */
  requiredOperationClass: "detect-offset-pagination",
  requiredVerifierId: "phase3-pagination-structured-finding",
  validationReportId: "validation:phase3-pagination-p3-gate-2026-08-15",
  storeRootDir: ".skill-cortex/practice",
  costBenchmarkReportPath: "docs/reports/2026-08-14-phase3-cost-benchmark.json",
  validationReportPath: "docs/reports/2026-08-14-phase3-p3-validation-report.json",
} as const;

export interface StepOutcome {
  ok: boolean;
  detail: string;
}

/** 来源模式（ADR-0011 §7）：由入口 options 决定，不由事件内自报字段升级。 */
export type GateSourceMode = "formal_real_store" | "evaluation_fixture";

export interface GateEvidenceRecord {
  evidenceClass: "static_review" | "owner_attested";
  gateIds: readonly string[];
  status: "pass";
  /** static review 使用 reviewer identity；owner attestation 使用证据所有者角色标识。 */
  recordedBy: string;
  /** 冻结日期，不使用运行时 now，保持 runner 可回放。 */
  recordedOn: string;
  evidenceRefs: readonly string[];
}

/** 非 automated gate 的显式证据记录；不再以无来源裸 boolean 冒充自动验证。 */
export const P3_GATE_EVIDENCE_RECORDS: readonly GateEvidenceRecord[] = [
  {
    evidenceClass: "static_review",
    gateIds: ["artifact_safety", "verifier_independence", "scope_conformance"],
    status: "pass",
    recordedBy: "leader:codex",
    recordedOn: "2026-08-16",
    evidenceRefs: [
      "src/procedures/phase3/detector.ts",
      "src/evaluation/phase3/verifier.ts",
      "docs/adr/0008-practice-evidence-and-procedure-promotion.md",
    ],
  },
  {
    evidenceClass: "owner_attested",
    gateIds: ["practice_evidence", "evidence_independence", "real_cost_evidence"],
    status: "pass",
    recordedBy: "role:p3-evidence-owner",
    recordedOn: "2026-08-15",
    evidenceRefs: [
      "docs/reports/2026-08-14-phase3-p3-validation-report.json",
      "docs/reports/2026-08-14-phase3-cost-benchmark.json",
    ],
  },
] as const;

function hasRecordedEvidence(
  gateId: string,
  evidenceClass: GateEvidenceRecord["evidenceClass"],
): boolean {
  return P3_GATE_EVIDENCE_RECORDS.some(
    (record) => record.evidenceClass === evidenceClass && record.status === "pass" && record.gateIds.includes(gateId),
  );
}

export interface P3GateResult {
  frozen: typeof P3_GATE_FROZEN;
  measuredAt: string;
  /** 来源模式：formal_real_store（完全无 override 的默认 store）或 evaluation_fixture（任一注入）。 */
  sourceMode: GateSourceMode;
  /** static_review / owner_attested 的显式身份、日期与引用；automated 门由 gates 自身重算。 */
  gateEvidenceRecords: readonly GateEvidenceRecord[];
  steps: {
    readRealEvents: StepOutcome;
    inductionBinding: StepOutcome;
    resolvePracticeEvidence: StepOutcome;
    costEvidence: StepOutcome;
    heldoutReplay: StepOutcome;
    sourceBindingCheck: StepOutcome;
  };
  /** 前置步骤全部 ok 才进入 judgePromotion。 */
  allPreconditionsOk: boolean;
  draft?: Phase3ProcedureDraft;
  evidenceAssessment?: PracticeEvidenceAssessment;
  heldoutMetrics?: Metrics;
  realCostEvidence?: RealCostEvidence;
  gates?: GateResult[];
  /** judgePromotion 结构结果（evaluation_fixture 下仍可能 validated，但不晋升）。 */
  assessmentDecision: "validated" | "draft";
  /** 公开 final decision：仅 formal_real_store + assessment validated 才 validated，否则恒 draft（fail-closed）。 */
  decision: "validated" | "draft";
  validatedProcedure?: Phase3ValidatedProcedure;
  /** assessment validated 但 sourceMode=evaluation_fixture 时的阻塞原因（未阻塞时不出现）。 */
  transitionBlockedReason?: "non_formal_source";
  validationReportId?: string;
}

function okStep(detail: string): StepOutcome {
  return { ok: true, detail };
}

function failStep(detail: string): StepOutcome {
  return { ok: false, detail };
}

export interface P3GateRunOptions {
  storeRootDir?: string;
  costBenchmarkReportPath?: string;
  /** 注入 PracticeStore（如临时目录测试 store）；缺省从 storeRootDir 构造。 */
  store?: PracticeStore;
  /** 覆盖冻结 tenantScope。 */
  tenantScope?: string;
  /** 覆盖冻结 eventIds。 */
  eventIds?: readonly string[];
}

/**
 * 来源模式判定（纯函数，不读盘）：完全无 override（含空对象）→ formal_real_store；
 * 任一 override（store/storeRootDir/costBenchmarkReportPath/tenantScope/eventIds）出现即
 * evaluation_fixture。npm test 可安全测试默认 formal 判定，不会触碰真实 .skill-cortex。
 */
export function sourceModeOf(options: P3GateRunOptions | undefined): GateSourceMode {
  if (options === undefined) return "formal_real_store";
  if (
    options.store !== undefined ||
    options.storeRootDir !== undefined ||
    options.costBenchmarkReportPath !== undefined ||
    options.tenantScope !== undefined ||
    options.eventIds !== undefined
  ) {
    return "evaluation_fixture";
  }
  return "formal_real_store";
}

/** 报告写入门槛（纯函数）：仅 formal_real_store 允许写 validation report（ADR-0011 §7）。 */
export function allowFormalReportWrite(result: Pick<P3GateResult, "sourceMode">): boolean {
  return result.sourceMode === "formal_real_store";
}

/**
 * 正式闭环：真实事件 → induction → evidence → cost → replay → bindings → judgePromotion
 * → transition。确定性（同一 store 状态 + 冻结输入 → 同一结果）；任何前置失败 → draft。
 *
 * 来源隔离（ADR-0011 §7）：完全无 override → formal_real_store；任一 override →
 * evaluation_fixture。仅 formal_real_store 且 assessment validated 时执行 draft→validated
 * transition；evaluation_fixture 下公开 decision 恒 draft（transitionBlockedReason=
 * non_formal_source）。可注入（测试/隔离用）：传入 `store`/`tenantScope`/`eventIds` 时
 * 覆盖冻结值并强制进入 evaluation_fixture；CLI --write-report 无 options，是唯一正式入口。
 */
export async function runP3GateValidation(options?: P3GateRunOptions): Promise<P3GateResult> {
  const sourceMode = sourceModeOf(options);
  const tenantScope = options?.tenantScope ?? P3_GATE_FROZEN.tenantScope;
  const eventIds = options?.eventIds ?? P3_GATE_FROZEN.eventIds;
  const store =
    options?.store ??
    new PracticeStore({
      rootDir: path.resolve(PROJECT_ROOT, options?.storeRootDir ?? P3_GATE_FROZEN.storeRootDir),
      projectRoot: PROJECT_ROOT,
    });
  const costReportPath = path.resolve(
    PROJECT_ROOT,
    options?.costBenchmarkReportPath ?? P3_GATE_FROZEN.costBenchmarkReportPath,
  );

  // 1. 读 2 条真实事件。
  const events: PracticeEvent[] = [];
  const missingIds: string[] = [];
  for (const eventId of eventIds) {
    const event = await store.getEvent(tenantScope, eventId);
    if (event === undefined) {
      missingIds.push(eventId);
    } else {
      events.push(event);
    }
  }
  const readRealEvents: StepOutcome =
    missingIds.length === 0
      ? okStep(`读取 ${events.length} 条事件（${eventIds.join(", ")}）`)
      : failStep(`事件缺失: ${missingIds.join(", ")}`);

  // 2. induction + 冻结绑定确认。
  let draft: Phase3ProcedureDraft | undefined;
  let inductionBinding: StepOutcome = failStep("induction 未执行（事件缺失）");
  if (readRealEvents.ok) {
    const induced = inducePhase3ProcedureDraft(events, {
      selectedReferenceHash: P3_GATE_FROZEN.selectedReferenceHash,
    });
    if (!induced.ok) {
      inductionBinding = failStep(`inducePhase3ProcedureDraft 失败: ${induced.reason}`);
    } else {
      draft = induced.procedure;
      const mismatches: string[] = [];
      if (draft.parentSkillId !== P3_GATE_FROZEN.parentSkillId) mismatches.push("parentSkillId");
      if (draft.parentSkillRevision !== P3_GATE_FROZEN.parentSkillRevision) {
        mismatches.push("parentSkillRevision");
      }
      if (draft.sourceBindings.skillMdHash !== P3_GATE_FROZEN.sourceHash) mismatches.push("skillMdHash");
      if (draft.sourceBindings.selectedReferenceHash !== P3_GATE_FROZEN.selectedReferenceHash) {
        mismatches.push("selectedReferenceHash");
      }
      inductionBinding =
        mismatches.length === 0
          ? okStep("draft 绑定冻结父身份/revision/sourceHash/reference 全部一致")
          : failStep(`draft 绑定失配: ${mismatches.join(", ")}`);
    }
  }

  // 3. resolvePracticeEvidence（真实绑定）。
  let evidenceAssessment: PracticeEvidenceAssessment | undefined;
  let resolvePracticeEvidenceStep: StepOutcome = failStep("evidence 未解析（事件缺失）");
  if (readRealEvents.ok) {
    evidenceAssessment = await resolvePracticeEvidence({
      store,
      tenantScope,
      eventIds,
      expectedParentSkillId: P3_GATE_FROZEN.parentSkillId,
      expectedParentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
      expectedSourceHash: P3_GATE_FROZEN.sourceHash,
      requiredOperationClass: P3_GATE_FROZEN.requiredOperationClass,
      requiredVerifierId: P3_GATE_FROZEN.requiredVerifierId,
    });
    resolvePracticeEvidenceStep = evidenceAssessment.ok
      ? okStep(`distinct store-verified real events = ${evidenceAssessment.distinctRealCount} ≥ 2`)
      : failStep(`resolvePracticeEvidence 未通过: ${evidenceAssessment.reason}`);
  }

  // 4. 读 cost benchmark 的 realCostEvidence（结构验证）。
  let realCostEvidence: RealCostEvidence | undefined;
  let costEvidence: StepOutcome;
  try {
    const raw = readFileSync(costReportPath, "utf8");
    const parsed = JSON.parse(raw) as { realCostEvidence?: unknown };
    const candidate = parsed.realCostEvidence;
    const validation = validateRealCostEvidence(candidate);
    if (!validation.ok) {
      costEvidence = failStep(`realCostEvidence 无效: ${(validation as { reasons: string[] }).reasons.join(",")}`);
    } else {
      realCostEvidence = candidate as RealCostEvidence;
      costEvidence = okStep(
        `realCostEvidence 验证 PASS（unit=latency_ms; nBreakEven=${realCostEvidence.nBreakEven.toFixed(6)}; sampleSize=${realCostEvidence.sampleSize}）`,
      );
    }
  } catch (error) {
    costEvidence = failStep(`cost benchmark 报告不可读: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 5. held-out replay → metrics。
  let heldoutMetrics: Metrics | undefined;
  let heldoutReplay: StepOutcome;
  try {
    heldoutMetrics = replayHeldoutPagination().report.metrics;
    const c = heldoutMetrics.counts;
    heldoutReplay = okStep(
      `held-out ${c.total} 例: accuracy=${heldoutMetrics.accuracy}; offsetRecall=${heldoutMetrics.offsetRecall}; offsetFpr=${heldoutMetrics.offsetFpr}; abstainRate=${heldoutMetrics.abstainRate}`,
    );
  } catch (error) {
    heldoutReplay = failStep(`held-out replay 失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 6. source/dependency binding check（真实冻结值，非裸 boolean）。
  let sourceBindingCheck: StepOutcome;
  if (draft !== undefined) {
    const binding = checkPhase3ProcedureBindings(draft, {
      parentSkillId: P3_GATE_FROZEN.parentSkillId,
      parentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
      skillMdHash: P3_GATE_FROZEN.sourceHash,
      selectedReferenceHash: P3_GATE_FROZEN.selectedReferenceHash,
      detectorSchemaVersion: PAGINATION_DETECTOR_SCHEMA_VERSION,
      detectorVersion: PAGINATION_DETECTOR_VERSION,
    });
    sourceBindingCheck = binding.ok
      ? okStep("source/dependency binding check ok")
      : failStep(`binding mismatch: ${(binding as { mismatches: string[] }).mismatches.join(", ")}`);
  } else {
    sourceBindingCheck = failStep("binding 未执行（无 draft）");
  }

  const allPreconditionsOk =
    readRealEvents.ok &&
    inductionBinding.ok &&
    resolvePracticeEvidenceStep.ok &&
    costEvidence.ok &&
    heldoutReplay.ok &&
    sourceBindingCheck.ok;

  const gates: GateResult[] = [];
  let assessmentDecision: "validated" | "draft" = "draft";
  let validatedProcedure: Phase3ValidatedProcedure | undefined;
  let transitionBlockedReason: "non_formal_source" | undefined;

  if (allPreconditionsOk && draft !== undefined && evidenceAssessment !== undefined && heldoutMetrics !== undefined && realCostEvidence !== undefined) {
    const promotion = judgePromotion({
      metrics: heldoutMetrics,
      practiceEvidence: evidenceAssessment,
      practiceEvidenceBinding: {
        parentSkillId: P3_GATE_FROZEN.parentSkillId,
        parentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
        sourceHash: P3_GATE_FROZEN.sourceHash,
        requiredOperationClass: P3_GATE_FROZEN.requiredOperationClass,
        requiredVerifierId: P3_GATE_FROZEN.requiredVerifierId,
      },
      realCostEvidence,
      artifactSafetyOk: hasRecordedEvidence("artifact_safety", "static_review"),
      sourceBindingOk: sourceBindingCheck.ok,
      evidenceIndependenceOk: hasRecordedEvidence("evidence_independence", "owner_attested"),
      verifierIndependenceOk: hasRecordedEvidence("verifier_independence", "static_review"),
      scopeConformanceOk: hasRecordedEvidence("scope_conformance", "static_review"),
    });
    gates.push(...promotion.gates);
    assessmentDecision = promotion.decision;
    if (assessmentDecision === "validated" && sourceMode === "formal_real_store") {
      // 仅 formal_real_store 可执行 draft→validated transition（ADR-0011 §7）。
      validatedProcedure = transitionPhase3ProcedureValidation(draft, {
        decision: "validated",
        validationReportId: P3_GATE_FROZEN.validationReportId,
      });
    } else if (assessmentDecision === "validated") {
      // evaluation_fixture 结构测试可达成 assessment validated，但不得晋升。
      transitionBlockedReason = "non_formal_source";
    }
  }
  // fail-closed：公开 final decision 只在 formal + assessment validated 时为 validated。
  const decision: "validated" | "draft" =
    sourceMode === "formal_real_store" && assessmentDecision === "validated" ? "validated" : "draft";

  const result: P3GateResult = {
    frozen: P3_GATE_FROZEN,
    measuredAt: new Date().toISOString(),
    sourceMode,
    gateEvidenceRecords: P3_GATE_EVIDENCE_RECORDS,
    steps: {
      readRealEvents,
      inductionBinding,
      resolvePracticeEvidence: resolvePracticeEvidenceStep,
      costEvidence,
      heldoutReplay,
      sourceBindingCheck,
    },
    allPreconditionsOk,
    draft,
    evidenceAssessment,
    heldoutMetrics,
    realCostEvidence,
    gates: gates.length > 0 ? gates : undefined,
    assessmentDecision,
    decision,
    validatedProcedure,
    ...(transitionBlockedReason !== undefined ? { transitionBlockedReason } : {}),
    validationReportId:
      validatedProcedure !== undefined ? validatedProcedure.validationReportId : undefined,
  };
  return result;
}

export function formatP3GateResult(result: P3GateResult): string {
  const lines = [
    "=== Phase 3 Gate P3 formal closure ===",
    `sourceMode: ${result.sourceMode}`,
    `preconditions: ${result.allPreconditionsOk ? "ALL PASS" : "FAILED"}`,
    ...Object.entries(result.steps).map(
      ([key, step]) => `  ${key}: ${step.ok ? "PASS" : "FAIL"} — ${step.detail}`,
    ),
  ];
  if (result.gates !== undefined) {
    lines.push(`gates: ${result.gates.length}/11`);
    for (const gate of result.gates) {
      lines.push(
        `  [${gate.gateId}] ${gate.status} [${gate.evidenceClasses.join("+")}] — ${gate.detail}`,
      );
    }
  }
  lines.push(`assessmentDecision: ${result.assessmentDecision}`);
  lines.push(`decision: ${result.decision}`);
  if (result.transitionBlockedReason !== undefined) {
    lines.push(`transitionBlocked: ${result.transitionBlockedReason}`);
  }
  if (result.validatedProcedure !== undefined) {
    lines.push(`validated: procedureId=${result.validatedProcedure.procedureId}`);
    lines.push(`validationReportId=${result.validatedProcedure.validationReportId}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI 入口：node src/evaluation/phase3/p3-gate-runner.ts [--write-report]
// ---------------------------------------------------------------------------
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isMain) {
  const writeReport = process.argv.includes("--write-report");
  // CLI 无 options ⇒ sourceMode=formal_real_store（唯一正式入口；ADR-0011 §7）。
  const result = await runP3GateValidation();
  process.stdout.write(`${formatP3GateResult(result)}\n`);
  if (writeReport) {
    if (!allowFormalReportWrite(result)) {
      // 防御：非 formal 来源绝不写报告；无文件副作用并失败退出。
      process.stdout.write("ERROR: report write refused（sourceMode ≠ formal_real_store）\n");
      process.exitCode = 1;
    } else {
      const reportPath = path.resolve(PROJECT_ROOT, P3_GATE_FROZEN.validationReportPath);
      writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      process.stdout.write(`validation report written: ${reportPath}\n`);
    }
  }
  if (!result.allPreconditionsOk || result.decision !== "validated") {
    process.exitCode = 1;
  }
}
