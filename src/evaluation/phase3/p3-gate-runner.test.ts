/**
 * Gate P3 正式闭环单测：使用【构造事件】（临时目录 PracticeStore），不依赖 gitignored
 * 真实事件（.skill-cortex/practice）。clean clone 下 npm test 全绿。
 *
 * 构造事件必须满足冻结契约且通过 validatePracticeEvent（policy）：
 * - provenance="real"；绑定冻结 supabase 值（parentSkillId/parentSkillRevision/sourceHash）；
 * - stepSummaries 含 detect-offset-pagination + outcome=ok（全部步骤 ok，满足
 *   attribution=verified_skill_effect 的 policy 一致性）；
 * - verifierResults 含 phase3-pagination-structured-finding + result=pass；
 * - attribution="verified_skill_effect"；sensitivity=none；retentionClass=project_manual。
 *
 * 覆盖：
 * - 注入 store/tenantScope/eventIds 后整链 11/11 门 PASS + decision=validated + transition；
 * - draft 绑定冻结值、evidenceIds=注入事件 ID、coveredSteps 引用 detect-offset-pagination；
 * - evidence assessment = 2 distinct store-verified real；
 * - cost evidence 来自冻结 cost benchmark 报告（已提交，非 gitignored）且 validate PASS；
 * - 确定性可回放（两次运行剥离 measuredAt 深度相等）；
 * - validated procedure 结构（validationReportId 合法、evidenceIds 保留）。
 *
 * 真实事件整链不属于 npm test：由 `node src/evaluation/phase3/p3-gate-runner.ts
 * --write-report` 显式运行（依赖本工作区 runtime 生成的 .skill-cortex 事件）。
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
import { P3_GATE_FROZEN, runP3GateValidation, type P3GateResult } from "./p3-gate-runner.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

/** 构造事件 eventId（不同于真实事件，证明注入生效）。 */
const CONSTRUCTED_EVENT_IDS = ["obs-constructed-1", "obs-constructed-2"];
const CONSTRUCTED_TENANT = "project:constructed0abcdef0123456789abcdef0123456789";

/** 构造一条满足冻结契约且通过 policy 的 verified real 事件。 */
function makeConstructedEvent(id: string, stepId: string): PracticeEvent {
  return {
    schemaVersion: 1,
    eventId: id,
    occurredAt: "2026-08-15T08:00:00.000Z",
    tenantScope: CONSTRUCTED_TENANT,
    provenance: "real",
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
    attribution: "verified_skill_effect",
    sensitivity: "none",
    retentionClass: "project_manual",
  };
}

/** 临时 store：写入 2 条构造事件后返回（事件必须通过 policy，append 会校验）。 */
async function makeConstructedStore(): Promise<PracticeStore> {
  const root = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-p3-gate-test-"));
  tempDirs.push(root);
  const store = new PracticeStore({
    rootDir: path.join(root, "practice"),
    projectRoot: root,
  });
  for (let index = 0; index < CONSTRUCTED_EVENT_IDS.length; index += 1) {
    const event = makeConstructedEvent(CONSTRUCTED_EVENT_IDS[index]!, `step-${index + 1}`);
    const policy = validatePracticeEvent(event);
    assert.equal(policy.ok, true, `构造事件必须通过 policy: ${JSON.stringify(policy.issues)}`);
    await store.append(event);
  }
  return store;
}

function withoutTimestamp(result: P3GateResult): Omit<P3GateResult, "measuredAt"> {
  const { measuredAt: _measuredAt, ...rest } = result;
  return rest;
}

const VALIDATION_REPORT_ID_RE = /^validation:[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

describe("P3 Gate 正式闭环（构造事件 + 注入 store，无真实 .skill-cortex 依赖）", () => {
  it("注入后整链 11/11 门 PASS + decision=validated + transition draft→validated", async () => {
    const store = await makeConstructedStore();
    const result = await runP3GateValidation({
      store,
      tenantScope: CONSTRUCTED_TENANT,
      eventIds: CONSTRUCTED_EVENT_IDS,
    });
    assert.equal(result.allPreconditionsOk, true, JSON.stringify(result.steps));
    for (const [key, step] of Object.entries(result.steps)) {
      assert.equal(step.ok, true, `${key}: ${step.detail}`);
    }
    assert.equal(result.gates?.length, 11, "judgePromotion 必须输出 11 门");
    for (const gate of result.gates!) {
      assert.equal(gate.status, "pass", `[${gate.gateId}] ${gate.detail}`);
    }
    assert.equal(result.decision, "validated");
    assert.ok(result.validatedProcedure, "validated 时必须执行 transition");
    assert.equal(result.validatedProcedure!.status, "validated");
    assert.equal(
      result.validatedProcedure!.validationReportId,
      P3_GATE_FROZEN.validationReportId,
    );
  });

  it("构造事件绑定冻结值：draft evidenceIds=注入事件 ID；coveredSteps 引用 detect-offset-pagination", async () => {
    const store = await makeConstructedStore();
    const result = await runP3GateValidation({
      store,
      tenantScope: CONSTRUCTED_TENANT,
      eventIds: CONSTRUCTED_EVENT_IDS,
    });
    assert.equal(result.allPreconditionsOk, true);
    assert.ok(result.draft);
    const draft = result.draft!;
    assert.equal(draft.parentSkillId, P3_GATE_FROZEN.parentSkillId);
    assert.equal(draft.parentSkillRevision, P3_GATE_FROZEN.parentSkillRevision);
    assert.equal(draft.sourceBindings.skillMdHash, P3_GATE_FROZEN.sourceHash);
    assert.equal(draft.sourceBindings.selectedReferenceHash, P3_GATE_FROZEN.selectedReferenceHash);
    assert.deepEqual(draft.evidenceIds, [...CONSTRUCTED_EVENT_IDS].sort());
    assert.equal(draft.coveredSteps[0]!.stepId, P3_GATE_FROZEN.requiredOperationClass);
    assert.equal(
      draft.sourceBindings.detectorSchemaVersion,
      PAGINATION_DETECTOR_SCHEMA_VERSION,
    );
    assert.equal(draft.sourceBindings.detectorVersion, PAGINATION_DETECTOR_VERSION);
  });

  it("evidence assessment：2 条 distinct store-verified real 构造事件", async () => {
    const store = await makeConstructedStore();
    const result = await runP3GateValidation({
      store,
      tenantScope: CONSTRUCTED_TENANT,
      eventIds: CONSTRUCTED_EVENT_IDS,
    });
    assert.equal(result.allPreconditionsOk, true);
    assert.ok(result.evidenceAssessment);
    assert.equal(result.evidenceAssessment!.ok, true);
    assert.equal(result.evidenceAssessment!.distinctRealCount, 2);
    assert.deepEqual(
      [...result.evidenceAssessment!.eventIds].sort(),
      [...CONSTRUCTED_EVENT_IDS].sort(),
    );
  });

  it("cost evidence 来自冻结 cost benchmark 报告（已提交，非 gitignored）且 validate PASS", async () => {
    const store = await makeConstructedStore();
    const result = await runP3GateValidation({
      store,
      tenantScope: CONSTRUCTED_TENANT,
      eventIds: CONSTRUCTED_EVENT_IDS,
    });
    assert.equal(result.allPreconditionsOk, true);
    assert.ok(result.realCostEvidence);
    assert.equal(result.realCostEvidence!.unit, "latency_ms");
    assert.equal(result.realCostEvidence!.sampleSize, 45);
    assert.ok(result.realCostEvidence!.nBreakEven > 0 && result.realCostEvidence!.nBreakEven <= 10);
  });

  it("确定性可回放：两次运行（剥离 measuredAt）深度相等", async () => {
    const store = await makeConstructedStore();
    const run = () =>
      runP3GateValidation({
        store,
        tenantScope: CONSTRUCTED_TENANT,
        eventIds: CONSTRUCTED_EVENT_IDS,
      });
    const first = withoutTimestamp(await run());
    const second = withoutTimestamp(await run());
    assert.deepEqual(second, first, "同一 store 状态 + 冻结输入 → 同一结果");
  });

  it("validated procedure 结构：validationReportId 合法、evidenceIds 保留、coveredSteps 引用 operation", async () => {
    const store = await makeConstructedStore();
    const result = await runP3GateValidation({
      store,
      tenantScope: CONSTRUCTED_TENANT,
      eventIds: CONSTRUCTED_EVENT_IDS,
    });
    assert.equal(result.allPreconditionsOk, true);
    const validated = result.validatedProcedure!;
    assert.match(validated.validationReportId, VALIDATION_REPORT_ID_RE);
    assert.deepEqual(validated.evidenceIds, [...CONSTRUCTED_EVENT_IDS].sort());
    assert.deepEqual(validated.coveredSteps.map((s) => s.stepId), [
      P3_GATE_FROZEN.requiredOperationClass,
    ]);
    assert.equal(validated.status, "validated");
    assert.ok(validated.procedureId.startsWith("procedure:phase3-pagination:"));
    assert.ok(validated.procedureRevision.startsWith("rev:"));
  });

  it("不注入时读默认 store：clean clone（无 .skill-cortex）→ 前置如实失败、decision=draft", async () => {
    // 指向不存在的空目录模拟 clean clone：事件缺失必须如实失败，不伪造。
    const result = await runP3GateValidation({ storeRootDir: ".tmp-p3-gate-empty-nonexistent" });
    assert.equal(result.allPreconditionsOk, false);
    assert.equal(result.steps.readRealEvents.ok, false);
    assert.equal(result.decision, "draft");
    assert.equal(result.validatedProcedure, undefined);
  });
});
