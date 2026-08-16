/**
 * Phase 5 slice 1 —— 完整状态机测试（draft/validated/canary/active/suspended/retired）。
 *
 * 合法边（显式发布/降级动作，纯函数不可变）：
 *   draft → validated → canary → active ⇄ suspended；active/suspended → retired（终态）。
 *
 * 覆盖：
 * - 完整生命周期链逐步走通（审计字段随转换写入/清除）；
 * - 每个转换的输入状态/decision/报告/证据/reason 校验（fail-closed）；
 * - 非法转换矩阵：29 条非法边逐条 throw（含 retired 复活、draft/validated 直接 active、
 *   canary 直接 retired 等）。
 * - shadow_replay 不进入状态机（transition 签名无 executionContext）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompiledProcedure } from "../../core/contracts/index.ts";
import {
  buildPhase3ProcedureDraft,
  transitionPhase3ProcedureActive,
  transitionPhase3ProcedureCanary,
  transitionPhase3ProcedureResume,
  transitionPhase3ProcedureRetire,
  transitionPhase3ProcedureSuspend,
  transitionPhase3ProcedureValidation,
  type Phase3CanaryProcedure,
} from "./index.ts";

const SKILL_HASH = "8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830";
const REFERENCE_HASH = "73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const PARENT_SKILL_ID = "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2";
const PARENT_SKILL_REVISION = "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec";
const VALIDATION_REPORT = "validation:phase3-pagination-p3-gate-2026-08-15";
const CANARY_REPORT = "canary:phase3-pagination-p4-gate-2026-08-16";
const ACTIVE_REPORT = "active:phase3-pagination-p4-canary-2026-08-16";
const REASON = "source dependency drift";

type Status = CompiledProcedure["status"];

function draftOf(): ReturnType<typeof buildPhase3ProcedureDraft> {
  return buildPhase3ProcedureDraft({
    parentSkillId: PARENT_SKILL_ID,
    parentSkillRevision: PARENT_SKILL_REVISION,
    skillMdHash: SKILL_HASH,
    selectedReferenceHash: REFERENCE_HASH,
    createdAt: "2026-08-14T00:00:00.000Z",
    evidenceIds: ["practice:offset-1", "practice:keyset-1"],
  });
}

function validatedOf() {
  return transitionPhase3ProcedureValidation(draftOf(), {
    decision: "validated",
    validationReportId: VALIDATION_REPORT,
  });
}

function canaryOf(): Phase3CanaryProcedure {
  return transitionPhase3ProcedureCanary(validatedOf(), {
    decision: "canary",
    canaryReportId: CANARY_REPORT,
  });
}

function activeOf() {
  return transitionPhase3ProcedureActive(canaryOf(), {
    decision: "active",
    activeReportId: ACTIVE_REPORT,
  });
}

function suspendedOf() {
  return transitionPhase3ProcedureSuspend(activeOf(), {
    decision: "suspended",
    reason: REASON,
  });
}

function retiredOf() {
  return transitionPhase3ProcedureRetire(suspendedOf(), {
    decision: "retired",
    reason: REASON,
  });
}

function instanceOf(status: Status): CompiledProcedure {
  switch (status) {
    case "draft":
      return draftOf();
    case "validated":
      return validatedOf();
    case "canary":
      return canaryOf();
    case "active":
      return activeOf();
    case "suspended":
      return suspendedOf();
    case "retired":
      return retiredOf();
  }
}

/** 按目标状态 dispatch 到对应 transition 入口（合法 from 走各自入口；非法 from 也会被拒绝）。 */
function dispatch(from: Status, to: Status, instance: CompiledProcedure): CompiledProcedure {
  switch (to) {
    case "validated":
      return transitionPhase3ProcedureValidation(instance as never, {
        decision: "validated",
        validationReportId: VALIDATION_REPORT,
      });
    case "canary":
      return transitionPhase3ProcedureCanary(instance as never, {
        decision: "canary",
        canaryReportId: CANARY_REPORT,
      });
    case "active":
      // 合法入口：canary→active（active transition）/ suspended→active（resume）。
      return from === "suspended"
        ? transitionPhase3ProcedureResume(instance as never, { decision: "active" })
        : transitionPhase3ProcedureActive(instance as never, {
            decision: "active",
            activeReportId: ACTIVE_REPORT,
          });
    case "suspended":
      return transitionPhase3ProcedureSuspend(instance as never, {
        decision: "suspended",
        reason: REASON,
      });
    case "retired":
      return transitionPhase3ProcedureRetire(instance as never, {
        decision: "retired",
        reason: REASON,
      });
    default:
      throw new Error(`no transition dispatch for ${to}`);
  }
}

const STATUSES: readonly Status[] = [
  "draft",
  "validated",
  "canary",
  "active",
  "suspended",
  "retired",
];

/** 合法边（7 条）；其余 36-7=29 条全部非法。 */
const LEGAL_EDGES = new Set<string>([
  "draft->validated",
  "validated->canary",
  "canary->active",
  "active->suspended",
  "suspended->active",
  "active->retired",
  "suspended->retired",
]);

describe("Phase 5 状态机：合法转换", () => {
  it("完整生命周期链：draft→validated→canary→active→suspended→active→retired", () => {
    const chain = [
      dispatch("draft", "validated", draftOf()),
      dispatch("validated", "canary", validatedOf()),
      dispatch("canary", "active", canaryOf()),
      dispatch("active", "suspended", activeOf()),
      dispatch("suspended", "active", suspendedOf()),
      dispatch("active", "retired", activeOf()),
    ];
    assert.deepEqual(
      chain.map((p) => p.status),
      ["validated", "canary", "active", "suspended", "active", "retired"],
    );
    // 每条转换都不可变：输入实例不被修改。
    const draft = draftOf();
    const validated = dispatch("draft", "validated", draft);
    assert.equal(draft.status, "draft", "输入实例必须保持 draft");
    assert.equal(validated.status, "validated");
  });

  it("审计字段随转换写入/保留/清除", () => {
    const validated = validatedOf();
    assert.equal(validated.validationReportId, VALIDATION_REPORT);
    assert.equal(validated.canaryReportId, undefined);

    const canary = canaryOf();
    assert.equal(canary.canaryReportId, CANARY_REPORT);
    assert.equal(canary.validationReportId, VALIDATION_REPORT, "validated 报告保留");

    const active = activeOf();
    assert.equal(active.activeReportId, ACTIVE_REPORT);
    assert.equal(active.canaryReportId, CANARY_REPORT, "canary 报告保留（证据链可追溯）");

    const suspended = suspendedOf();
    assert.equal(suspended.status, "suspended");
    assert.equal(suspended.lifecycleReason, REASON);
    assert.equal(suspended.activeReportId, ACTIVE_REPORT, "active 报告保留");

    const resumed = transitionPhase3ProcedureResume(suspended, { decision: "active" });
    assert.equal(resumed.status, "active");
    assert.equal(resumed.lifecycleReason, undefined, "resume 清除失效原因");
    assert.equal(resumed.activeReportId, ACTIVE_REPORT, "resume 保留 active 发布报告");

    const retired = retiredOf();
    assert.equal(retired.status, "retired");
    assert.equal(retired.lifecycleReason, REASON);
    assert.equal(retired.canaryReportId, CANARY_REPORT, "终态保留完整证据链");
  });

  it("转换不改变 artifact/revision/证据：procedureRevision/artifactHash/evidenceIds 原样保留", () => {
    const active = activeOf();
    const suspended = suspendedOf();
    assert.equal(suspended.procedureRevision, active.procedureRevision);
    assert.equal(suspended.artifactHash, active.artifactHash);
    assert.deepEqual(suspended.evidenceIds, active.evidenceIds);
    assert.deepEqual(active.evidenceIds, ["practice:offset-1", "practice:keyset-1"]);
  });
});

describe("Phase 5 状态机：单转换 fail-closed", () => {
  it("canary→active：非 canary 输入拒绝（draft/validated/active/suspended/retired）", () => {
    for (const from of ["draft", "validated", "active", "suspended", "retired"] as const) {
      assert.throws(
        () =>
          transitionPhase3ProcedureActive(instanceOf(from) as never, {
            decision: "active",
            activeReportId: ACTIVE_REPORT,
          }),
        /active_transition_requires_canary_procedure/,
        `from=${from} 必须拒绝`,
      );
    }
  });

  it("canary→active：缺 canary 报告/证据/decision 错/报告非法 ⇒ 拒绝", () => {
    const canary = canaryOf();
    // 伪造 canary（缺 canaryReportId）：
    const forged = { ...canary, canaryReportId: undefined } as Phase3CanaryProcedure;
    assert.throws(
      () =>
        transitionPhase3ProcedureActive(forged, { decision: "active", activeReportId: ACTIVE_REPORT }),
      /active_transition_requires_canary_evidence/,
    );
    // 无证据 canary：
    const noEvidence = { ...canary, evidenceIds: [] } as Phase3CanaryProcedure;
    assert.throws(
      () =>
        transitionPhase3ProcedureActive(noEvidence, { decision: "active", activeReportId: ACTIVE_REPORT }),
      /active_transition_requires_evidence/,
    );
    // decision 错：
    assert.throws(
      () =>
        transitionPhase3ProcedureActive(canary, {
          decision: "suspended",
          activeReportId: ACTIVE_REPORT,
        } as never),
      /active_transition_requires_active_decision/,
    );
    // 报告非法：
    for (const bad of ["", "canary:phase3-pagination-p4-gate-2026-08-16", "active:", "active:has space"]) {
      assert.throws(
        () => transitionPhase3ProcedureActive(canary, { decision: "active", activeReportId: bad }),
        /active_report_id_invalid/,
        `report=${JSON.stringify(bad)} 必须拒绝`,
      );
    }
  });

  it("active→suspended：非 active 输入 / decision 错 / reason 空或超长 ⇒ 拒绝", () => {
    for (const from of ["draft", "validated", "canary", "suspended", "retired"] as const) {
      assert.throws(
        () =>
          transitionPhase3ProcedureSuspend(instanceOf(from) as never, {
            decision: "suspended",
            reason: REASON,
          }),
        /suspend_transition_requires_active_procedure/,
        `from=${from} 必须拒绝`,
      );
    }
    const active = activeOf();
    assert.throws(
      () => transitionPhase3ProcedureSuspend(active, { decision: "retired", reason: REASON } as never),
      /suspend_transition_requires_suspended_decision/,
    );
    for (const bad of ["", "   ", "x".repeat(201)]) {
      assert.throws(
        () => transitionPhase3ProcedureSuspend(active, { decision: "suspended", reason: bad }),
        /lifecycle_reason_/,
        `reason=${JSON.stringify(bad.slice(0, 12))}… 必须拒绝`,
      );
    }
  });

  it("suspended→active：非 suspended 输入 / decision 错 ⇒ 拒绝", () => {
    for (const from of ["draft", "validated", "canary", "active", "retired"] as const) {
      assert.throws(
        () => transitionPhase3ProcedureResume(instanceOf(from) as never, { decision: "active" }),
        /resume_transition_requires_suspended_procedure/,
        `from=${from} 必须拒绝`,
      );
    }
    assert.throws(
      () => transitionPhase3ProcedureResume(suspendedOf(), { decision: "retired" } as never),
      /resume_transition_requires_active_decision/,
    );
  });

  it("active|suspended→retired：draft/validated/canary/retired 输入拒绝；reason 必填", () => {
    for (const from of ["draft", "validated", "canary", "retired"] as const) {
      assert.throws(
        () =>
          transitionPhase3ProcedureRetire(instanceOf(from) as never, {
            decision: "retired",
            reason: REASON,
          }),
        /retire_transition_requires_active_or_suspended_procedure/,
        `from=${from} 必须拒绝（canary 不能直接废弃）`,
      );
    }
    for (const bad of ["", "   "]) {
      assert.throws(
        () => transitionPhase3ProcedureRetire(activeOf(), { decision: "retired", reason: bad }),
        /lifecycle_reason_/,
      );
    }
  });

  it("validation 转换运行期防御：非 draft 输入拒绝（retired 复活 / active 降级回 validated）", () => {
    for (const from of ["validated", "canary", "active", "suspended", "retired"] as const) {
      assert.throws(
        () =>
          transitionPhase3ProcedureValidation(instanceOf(from) as never, {
            decision: "validated",
            validationReportId: VALIDATION_REPORT,
          }),
        /validation_transition_requires_draft_procedure/,
        `from=${from} 必须拒绝`,
      );
    }
  });

  it("确定性：同输入同输出（可回放）", () => {
    assert.deepEqual(
      transitionPhase3ProcedureActive(canaryOf(), { decision: "active", activeReportId: ACTIVE_REPORT }),
      transitionPhase3ProcedureActive(canaryOf(), { decision: "active", activeReportId: ACTIVE_REPORT }),
    );
    assert.deepEqual(
      transitionPhase3ProcedureSuspend(activeOf(), { decision: "suspended", reason: REASON }),
      transitionPhase3ProcedureSuspend(activeOf(), { decision: "suspended", reason: REASON }),
    );
  });
});

describe("Phase 5 状态机：非法转换矩阵（36 边中 29 条全部拒绝）", () => {
  it("每条非法边 throw，每条合法边成功", () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const edge = `${from}->${to}`;
        if (LEGAL_EDGES.has(edge)) {
          const result = dispatch(from, to, instanceOf(from));
          assert.equal(result.status, to, `${edge} 必须成功`);
        } else {
          assert.throws(
            () => dispatch(from, to, instanceOf(from)),
            /.*/,
            `${edge} 必须被拒绝（fail-closed）`,
          );
        }
      }
    }
  });

  it("关键非法边显式核验（消息可读）", () => {
    // draft 直接 active / validated 直接 active：跳过 canary 发布动作。
    assert.throws(
      () =>
        transitionPhase3ProcedureActive(draftOf() as never, {
          decision: "active",
          activeReportId: ACTIVE_REPORT,
        }),
      /active_transition_requires_canary_procedure/,
    );
    assert.throws(
      () =>
        transitionPhase3ProcedureActive(validatedOf() as never, {
          decision: "active",
          activeReportId: ACTIVE_REPORT,
        }),
      /active_transition_requires_canary_procedure/,
    );
    // canary 直接 retired：必须经 active/suspended 受控路径。
    assert.throws(
      () => transitionPhase3ProcedureRetire(canaryOf() as never, { decision: "retired", reason: REASON }),
      /retire_transition_requires_active_or_suspended_procedure/,
    );
    // retired 复活：任何出口都拒绝。
    assert.throws(
      () =>
        transitionPhase3ProcedureValidation(retiredOf() as never, {
          decision: "validated",
          validationReportId: VALIDATION_REPORT,
        }),
      /validation_transition_requires_draft_procedure/,
    );
    assert.throws(
      () =>
        transitionPhase3ProcedureCanary(retiredOf() as never, {
          decision: "canary",
          canaryReportId: CANARY_REPORT,
        }),
      /canary_transition_requires_validated_procedure/,
    );
    assert.throws(
      () =>
        transitionPhase3ProcedureResume(retiredOf() as never, { decision: "active" }),
      /resume_transition_requires_suspended_procedure/,
    );
  });
});
