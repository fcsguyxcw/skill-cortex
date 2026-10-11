/**
 * Gate P3 正式闭环单测：使用【deliberate spoof adversarial fixture】（构造事件），
 * 不依赖 gitignored 真实事件（.skill-cortex/practice）。clean clone 下 npm test 全绿。
 *
 * adversarial fixture 故意把构造事件自标 provenance="real"、attribution="verified_skill_effect"，
 * 满足冻结契约并通过 validatePracticeEvent（policy）——用于证明：即使事件自报字段全真、
 * judgePromotion 11/11 全 PASS，evaluation_fixture 注入路径也不能 formal 晋升
 * （ADR-0011 §7：来源模式由入口决定，不由事件内自报字段升级）。它不是真实证据，不得
 * 描述为真实 PracticeEvent 或真实晋升依据。
 *
 * 覆盖：
 * - 注入 store/tenantScope/eventIds（任一 override ⇒ sourceMode=evaluation_fixture）；
 *   整链 gates 11/11 PASS + assessmentDecision=validated，但公开 decision=draft、
 *   validatedProcedure=undefined、transitionBlockedReason=non_formal_source；
 * - draft 绑定冻结值、evidenceIds=注入事件 ID、coveredSteps 引用 detect-offset-pagination；
 * - ADR-0011：effectless pilot 省略 permissionPolicyHash（sourceBindings 与 fingerprint）；
 * - evidence assessment = 2 distinct store-verified real（机器结果，不代表可晋升）；
 * - cost evidence 来自冻结 cost benchmark 报告（已提交，非 gitignored）且 validate PASS；
 * - 确定性可回放（两次运行剥离 measuredAt 深度相等）；
 * - sourceModeOf / allowFormalReportWrite 纯函数：无 override ⇒ formal_real_store；任一
 *   override ⇒ evaluation_fixture；报告写入仅 formal 允许（不读取真实 .skill-cortex）；
 * - 注入空 store（clean-clone 模拟）⇒ 前置如实失败、decision=draft、不伪造。
 *
 * 真实事件整链不属于 npm test：由 `node src/evaluation/phase3/p3-gate-runner.ts
 * --write-report` 显式运行（CLI 无 options ⇒ formal_real_store；依赖本工作区 runtime
 * 生成的 .skill-cortex 事件）。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import { PAGINATION_DETECTOR_SCHEMA_VERSION, PAGINATION_DETECTOR_VERSION } from "../../procedures/phase3/detector.ts";
import { validatePracticeEvent } from "../../practice/policy/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import {
  allowFormalReportWrite,
  P3_GATE_FROZEN,
  runP3GateValidation,
  sourceModeOf,
  type P3GateResult,
  type P3GateRunOptions,
} from "./p3-gate-runner.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

/** 故意伪造（spoof）真实来源字段的构造事件 eventId（不同于真实事件，证明注入生效）。 */
const ADVERSARIAL_EVENT_IDS = ["obs-adversarial-spoof-1", "obs-adversarial-spoof-2"];
const ADVERSARIAL_TENANT = "project:adversarial0abcdef0123456789abcdef0123456789";

/**
 * deliberate spoof adversarial fixture：构造一条满足冻结契约、自标 provenance="real" +
 * attribution="verified_skill_effect" 且通过 policy 的事件。它冒充真实证据的全部自报字段，
 * 用于证明 evaluation_fixture 注入路径即使 11/11 全 PASS 也不能 formal 晋升。
 * 它【不是】真实 PracticeEvent，不构成晋升证据。
 */
function makeAdversarialSpoofEvent(id: string, stepId: string): PracticeEvent {
  return {
    schemaVersion: 1,
    eventId: id,
    occurredAt: "2026-08-15T08:00:00.000Z",
    tenantScope: ADVERSARIAL_TENANT,
    provenance: "real", // 故意伪造：自报 real（ADR-0011 §7：不得因此升级来源模式）。
    parentSkillId: P3_GATE_FROZEN.parentSkillId,
    parentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
    sourceHash: P3_GATE_FROZEN.sourceHash,
    routeDecisionId: "route:00000000000000000000000000000000",
    candidateSkillIds: [P3_GATE_FROZEN.parentSkillId],
    selectedSkillIds: [P3_GATE_FROZEN.parentSkillId],
    executionMode: "skill_md",
    redactedTaskFeatures: ["prompt-hash:00000000000000000000000000000000"],
    environmentFingerprint: "pi:0.84.1",
    dependencyFingerprint: { sourceHash: P3_GATE_FROZEN.sourceHash, environmentClass: "pi-0.84.1" },
    // 全部步骤 ok（含冻结 covered operation），满足 verified_skill_effect 的 policy 一致性。
    stepSummaries: [
      { stepId: `${stepId}-load`, actor: "tool", operationClass: "tool:load_skill", outcome: "ok" },
      { stepId: `${stepId}-detect`, actor: "procedure", operationClass: "detect-offset-pagination", outcome: "ok" },
    ],
    authorizationResults: [],
    guardResults: [],
    verifierResults: [{ verifierId: "phase3-pagination-structured-finding", result: "pass" }],
    attribution: "verified_skill_effect", // 故意伪造：自报 verified（policy 会重算一致性）。
    sensitivity: "none",
    retentionClass: "project_manual",
  };
}

/** 临时 store：写入 2 条 adversarial spoof 事件后返回（事件必须通过 policy，append 会校验）。 */
async function makeAdversarialSpoofStore(): Promise<PracticeStore> {
  const root = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-p3-gate-test-"));
  tempDirs.push(root);
  const store = new PracticeStore({
    rootDir: path.join(root, "practice"),
    projectRoot: root,
  });
  for (let index = 0; index < ADVERSARIAL_EVENT_IDS.length; index += 1) {
    const event = makeAdversarialSpoofEvent(ADVERSARIAL_EVENT_IDS[index]!, `step-${index + 1}`);
    const policy = validatePracticeEvent(event);
    assert.equal(policy.ok, true, `adversarial 事件必须通过 policy: ${JSON.stringify(policy.issues)}`);
    await store.append(event);
  }
  return store;
}

function withoutTimestamp(result: P3GateResult): Omit<P3GateResult, "measuredAt"> {
  const { measuredAt: _measuredAt, ...rest } = result;
  return rest;
}

describe("P3 Gate 正式闭环（adversarial spoof fixture + 注入 store，无真实 .skill-cortex 依赖）", () => {
  it("adversarial 注入全链：gates 11/11 PASS + assessmentDecision=validated，但 final decision=draft、无 transition", async () => {
    const store = await makeAdversarialSpoofStore();
    const result = await runP3GateValidation({
      store,
      tenantScope: ADVERSARIAL_TENANT,
      eventIds: ADVERSARIAL_EVENT_IDS,
    });
    // 任一 override ⇒ evaluation_fixture；来源模式不信任事件自报字段。
    assert.equal(result.sourceMode, "evaluation_fixture");
    assert.ok(result.gateEvidenceRecords.some((record) => record.evidenceClass === "static_review" && record.recordedBy === "leader:codex"));
    assert.ok(result.gateEvidenceRecords.some((record) => record.evidenceClass === "owner_attested" && record.recordedBy === "role:p3-evidence-owner"));
    assert.equal(result.allPreconditionsOk, true, JSON.stringify(result.steps));
    for (const [key, step] of Object.entries(result.steps)) {
      assert.equal(step.ok, true, `${key}: ${step.detail}`);
    }
    assert.equal(result.gates?.length, 11, "judgePromotion 必须输出 11 门");
    for (const gate of result.gates!) {
      assert.equal(gate.status, "pass", `[${gate.gateId}] ${gate.detail}`);
    }
    // 结构测试允许 assessment validated，但注入来源不得晋升（ADR-0011 §7）。
    assert.equal(result.assessmentDecision, "validated");
    assert.equal(result.decision, "draft", "evaluation_fixture 下公开 decision 必须保持 draft");
    assert.equal(result.validatedProcedure, undefined, "evaluation_fixture 不得执行 transition");
    assert.equal(result.transitionBlockedReason, "non_formal_source");
  });

  it("adversarial 事件绑定冻结值：draft evidenceIds=注入事件 ID；coveredSteps 引用 detect-offset-pagination", async () => {
    const store = await makeAdversarialSpoofStore();
    const result = await runP3GateValidation({
      store,
      tenantScope: ADVERSARIAL_TENANT,
      eventIds: ADVERSARIAL_EVENT_IDS,
    });
    assert.equal(result.sourceMode, "evaluation_fixture");
    assert.equal(result.allPreconditionsOk, true);
    assert.ok(result.draft);
    const draft = result.draft!;
    assert.equal(draft.parentSkillId, P3_GATE_FROZEN.parentSkillId);
    assert.equal(draft.parentSkillRevision, P3_GATE_FROZEN.parentSkillRevision);
    assert.equal(draft.sourceBindings.skillMdHash, P3_GATE_FROZEN.sourceHash);
    assert.equal(draft.sourceBindings.selectedReferenceHash, P3_GATE_FROZEN.selectedReferenceHash);
    // ADR-0011：effectless pilot 整链省略 permissionPolicyHash（sourceBindings 与 fingerprint）。
    assert.equal(draft.sourceBindings.permissionPolicyHash, undefined);
    assert.equal(draft.dependencyFingerprint.permissionPolicyHash, undefined);
    assert.deepEqual(draft.evidenceIds, [...ADVERSARIAL_EVENT_IDS].sort());
    assert.equal(draft.coveredSteps[0]!.stepId, P3_GATE_FROZEN.requiredOperationClass);
    assert.equal(
      draft.sourceBindings.detectorSchemaVersion,
      PAGINATION_DETECTOR_SCHEMA_VERSION,
    );
    assert.equal(draft.sourceBindings.detectorVersion, PAGINATION_DETECTOR_VERSION);
  });

  it("evidence assessment：2 条 distinct store-verified real 构造事件（机器结果，不代表可晋升）", async () => {
    const store = await makeAdversarialSpoofStore();
    const result = await runP3GateValidation({
      store,
      tenantScope: ADVERSARIAL_TENANT,
      eventIds: ADVERSARIAL_EVENT_IDS,
    });
    assert.equal(result.allPreconditionsOk, true);
    assert.ok(result.evidenceAssessment);
    assert.equal(result.evidenceAssessment!.ok, true);
    assert.equal(result.evidenceAssessment!.distinctRealCount, 2);
    assert.deepEqual(
      [...result.evidenceAssessment!.eventIds].sort(),
      [...ADVERSARIAL_EVENT_IDS].sort(),
    );
  });

  it("cost evidence 来自冻结 cost benchmark 报告（已提交，非 gitignored）且 validate PASS", async () => {
    const store = await makeAdversarialSpoofStore();
    const result = await runP3GateValidation({
      store,
      tenantScope: ADVERSARIAL_TENANT,
      eventIds: ADVERSARIAL_EVENT_IDS,
    });
    assert.equal(result.allPreconditionsOk, true);
    assert.ok(result.realCostEvidence);
    assert.equal(result.realCostEvidence!.unit, "latency_ms");
    assert.equal(result.realCostEvidence!.sampleSize, 45);
    assert.ok(result.realCostEvidence!.nBreakEven > 0 && result.realCostEvidence!.nBreakEven <= 10);
  });

  it("确定性可回放：两次运行（剥离 measuredAt）深度相等", async () => {
    const store = await makeAdversarialSpoofStore();
    const run = () =>
      runP3GateValidation({
        store,
        tenantScope: ADVERSARIAL_TENANT,
        eventIds: ADVERSARIAL_EVENT_IDS,
      });
    const first = withoutTimestamp(await run());
    const second = withoutTimestamp(await run());
    assert.deepEqual(second, first, "同一 store 状态 + 冻结输入 → 同一结果");
  });

  it("evaluation 下无 transition：validatedProcedure 必须 undefined；draft 结构完整", async () => {
    const store = await makeAdversarialSpoofStore();
    const result = await runP3GateValidation({
      store,
      tenantScope: ADVERSARIAL_TENANT,
      eventIds: ADVERSARIAL_EVENT_IDS,
    });
    assert.equal(result.allPreconditionsOk, true);
    // 结构测试不得产生可晋升的 validated procedure（transition 仅 formal_real_store 执行）。
    assert.equal(result.validatedProcedure, undefined);
    assert.equal(result.validationReportId, undefined);
    const draft = result.draft!;
    assert.ok(draft.procedureId.startsWith("procedure:phase3-pagination:"));
    assert.ok(draft.procedureRevision.startsWith("rev:"));
    assert.deepEqual(draft.evidenceIds, [...ADVERSARIAL_EVENT_IDS].sort());
    assert.deepEqual(draft.coveredSteps.map((s) => s.stepId), [
      P3_GATE_FROZEN.requiredOperationClass,
    ]);
    // transition 纯函数本身由 procedures/phase3 的单元测试覆盖；本 runner 只在 formal 下调用它。
  });

  it("sourceModeOf 纯函数：完全无 override ⇒ formal_real_store；任一 override ⇒ evaluation_fixture", () => {
    // 默认 formal 判定用纯函数测试；npm test 不读取真实 .skill-cortex。
    assert.equal(sourceModeOf(undefined), "formal_real_store");
    assert.equal(sourceModeOf({}), "formal_real_store");
    const overrideCases: P3GateRunOptions[] = [
      { storeRootDir: ".tmp-src-mode-x" },
      { costBenchmarkReportPath: "docs/reports/x.json" },
      { tenantScope: "project:overridetenant0000000000000000000000000000000000" },
      { eventIds: ["obs-x"] },
    ];
    for (const opts of overrideCases) {
      assert.equal(sourceModeOf(opts), "evaluation_fixture", JSON.stringify(opts));
    }
    // store 注入 ⇒ evaluation_fixture（不触发 I/O，仅构造；adversarial 全链测试已覆盖读路径）。
    const storeOnly = sourceModeOf({ store: new PracticeStore({ rootDir: path.join(PROJECT_ROOT, ".tmp-src-mode-store"), projectRoot: PROJECT_ROOT }) });
    assert.equal(storeOnly, "evaluation_fixture");
  });

  it("allowFormalReportWrite：仅 formal_real_store 允许写 validation report", () => {
    assert.equal(allowFormalReportWrite({ sourceMode: "formal_real_store" }), true);
    assert.equal(allowFormalReportWrite({ sourceMode: "evaluation_fixture" }), false);
  });

  it("注入空 store（clean-clone 模拟）：前置如实失败、decision=draft、不伪造", async () => {
    // 注入不存在的空目录模拟 clean clone：事件缺失必须如实失败，不伪造。
    const result = await runP3GateValidation({ storeRootDir: ".tmp-p3-gate-empty-nonexistent" });
    assert.equal(result.sourceMode, "evaluation_fixture");
    assert.equal(result.allPreconditionsOk, false);
    assert.equal(result.steps.readRealEvents.ok, false);
    assert.equal(result.assessmentDecision, "draft");
    assert.equal(result.decision, "draft");
    assert.equal(result.validatedProcedure, undefined);
    assert.equal(result.transitionBlockedReason, undefined);
  });
});
