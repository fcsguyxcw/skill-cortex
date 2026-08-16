/**
 * Phase 5 slice 1 —— active gate 测试（执行上下文 × 状态矩阵，isStatusEligibleInContext 既有语义）。
 *
 * 注意：任务描述「active 在 canary/shadow_replay 上下文亦合法」与 resolver/ADR-0012 §2 矩阵
 * 存在歧义——矩阵明确 canary 上下文只放行 canary 状态（active ∈ canary 上下文 ⇒
 * insufficient_evidence）。本测试以 isStatusEligibleInContext 既有语义（权威）为准：
 *   shadow_replay ∈ {validated, canary, active}；canary ∈ {canary}；active ∈ {active}。
 *
 * 覆盖：
 * - active + active 上下文 ⇒ fast_path（正式执行）；
 * - active + shadow_replay 上下文 ⇒ fast_path（shadow 可回放已发布状态）；
 * - active + canary 上下文 ⇒ insufficient_evidence（canary 是限量发布上下文，不放行 active）；
 * - active + 缺失/非法上下文 ⇒ unknown fail-closed；
 * - suspended + 任何上下文 ⇒ insufficient_evidence（挂起不可执行）；
 * - retired + 任何上下文 ⇒ insufficient_evidence（废弃不可执行）；
 * - 执行无状态副作用（execute 后 status 不变，不自我发布）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompiledProcedure } from "../../core/contracts/index.ts";
import { execute, type ExecuteInput } from "../../runtime/executor.ts";
import {
  buildPhase3ProcedureDraft,
  transitionPhase3ProcedureActive,
  transitionPhase3ProcedureCanary,
  transitionPhase3ProcedureResume,
  transitionPhase3ProcedureRetire,
  transitionPhase3ProcedureSuspend,
  transitionPhase3ProcedureValidation,
} from "../../procedures/phase3/index.ts";
import { P3_GATE_FROZEN } from "../phase3/p3-gate-runner.ts";
import { createCanaryServices } from "./canary.ts";

const OFFSET_SQL = "SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;";
const CANARY_REPORT = "canary:phase3-pagination-p4-gate-2026-08-16";
const ACTIVE_REPORT = "active:phase3-pagination-p4-canary-2026-08-16";
const SUSPEND_REASON = "source dependency drift";
const RETIRE_REASON = "skill uninstalled";

/** 冻结构造 active/suspended/retired procedure（P3_GATE_FROZEN 证据链，纯 transition）。 */
function procedureOf(status: "active" | "suspended" | "retired"): CompiledProcedure {
  const draft = buildPhase3ProcedureDraft({
    parentSkillId: P3_GATE_FROZEN.parentSkillId,
    parentSkillRevision: P3_GATE_FROZEN.parentSkillRevision,
    skillMdHash: P3_GATE_FROZEN.sourceHash,
    selectedReferenceHash: P3_GATE_FROZEN.selectedReferenceHash,
    createdAt: "2026-08-15T00:00:00.000Z",
    evidenceIds: [...P3_GATE_FROZEN.eventIds],
  });
  const validated = transitionPhase3ProcedureValidation(draft, {
    decision: "validated",
    validationReportId: P3_GATE_FROZEN.validationReportId,
  });
  const canary = transitionPhase3ProcedureCanary(validated, {
    decision: "canary",
    canaryReportId: CANARY_REPORT,
  });
  const active = transitionPhase3ProcedureActive(canary, {
    decision: "active",
    activeReportId: ACTIVE_REPORT,
  });
  if (status === "active") return active;
  const suspended = transitionPhase3ProcedureSuspend(active, {
    decision: "suspended",
    reason: SUSPEND_REASON,
  });
  if (status === "suspended") return suspended;
  return transitionPhase3ProcedureRetire(suspended, {
    decision: "retired",
    reason: RETIRE_REASON,
  });
}

function gateInput(executionContext: unknown, procedure: CompiledProcedure): ExecuteInput {
  return {
    selectedSkill: {
      skillId: procedure.parentSkillId,
      skillRevision: procedure.parentSkillRevision,
    },
    procedure,
    environment: {
      currentSkillRevision: procedure.parentSkillRevision,
      currentDependencyFingerprint: procedure.dependencyFingerprint,
      executionContext,
      preconditions: [
        { predicateId: "bounded-sql-input", result: true },
        { predicateId: "source-bindings-current", result: true },
      ],
      requestedEffects: [],
      authorizationRequired: false,
    },
    taskInput: { sql: OFFSET_SQL },
    guardObservations: [
      { predicateId: "bounded-supported-sql", phase: "runtime", result: true },
      { predicateId: "source-and-dependency-match", phase: "runtime", result: true },
    ],
    services: createCanaryServices(),
  };
}

describe("Phase 5 slice 1：active gate（执行上下文 × 状态矩阵）", () => {
  it("active + active 上下文 ⇒ fast_path（正式执行，executionContext=active 如实记录）", async () => {
    const outcome = await execute(gateInput("active", procedureOf("active")));
    assert.equal(outcome.outcome, "fast_path");
    if (outcome.outcome === "fast_path") {
      assert.equal(outcome.decision.reason, "eligible_procedure");
      assert.equal(outcome.decision.executionContext, "active");
      const finding = outcome.result as { class: string };
      assert.equal(finding.class, "uses_offset");
    }
  });

  it("active + shadow_replay 上下文 ⇒ fast_path（shadow 可回放已发布状态）", async () => {
    const outcome = await execute(gateInput("shadow_replay", procedureOf("active")));
    assert.equal(outcome.outcome, "fast_path");
    if (outcome.outcome === "fast_path") {
      assert.equal(outcome.decision.executionContext, "shadow_replay");
    }
  });

  it("active + canary 上下文 ⇒ insufficient_evidence（canary 限量上下文只放行 canary 状态）", async () => {
    const outcome = await execute(gateInput("canary", procedureOf("active")));
    assert.equal(outcome.outcome, "slow_path", "active 不得在 canary 上下文执行");
    if (outcome.outcome === "slow_path") {
      assert.equal(outcome.decision.reason, "insufficient_evidence");
      assert.equal(outcome.decision.executionContext, "canary", "合法上下文如实记录");
    }
  });

  it("active + 缺失/非法上下文 ⇒ unknown fail-closed", async () => {
    for (const context of [undefined, "bogus", ""]) {
      const outcome = await execute(gateInput(context, procedureOf("active")));
      assert.equal(outcome.outcome, "slow_path", `context=${String(context)} 必须 fail closed`);
      if (outcome.outcome === "slow_path") {
        assert.equal(outcome.decision.reason, "insufficient_evidence");
        assert.equal(outcome.decision.executionContext, "unknown");
      }
    }
  });

  it("suspended + 任何上下文 ⇒ insufficient_evidence（挂起不可执行）", async () => {
    for (const context of ["active", "canary", "shadow_replay", undefined, "bogus"]) {
      const outcome = await execute(gateInput(context, procedureOf("suspended")));
      assert.equal(outcome.outcome, "slow_path", `suspended + ${String(context)} 必须 fail closed`);
      if (outcome.outcome === "slow_path") {
        assert.equal(outcome.decision.reason, "insufficient_evidence");
      }
    }
  });

  it("retired + 任何上下文 ⇒ insufficient_evidence（废弃不可执行）", async () => {
    for (const context of ["active", "canary", "shadow_replay", undefined, "bogus"]) {
      const outcome = await execute(gateInput(context, procedureOf("retired")));
      assert.equal(outcome.outcome, "slow_path", `retired + ${String(context)} 必须 fail closed`);
      if (outcome.outcome === "slow_path") {
        assert.equal(outcome.decision.reason, "insufficient_evidence");
      }
    }
  });

  it("生命周期 + 执行闭环：active 可执行 → suspended 停用 → resume 恢复可执行 → retired 永久停用", async () => {
    const active = procedureOf("active");
    const activeOutcome = await execute(gateInput("active", active));
    assert.equal(activeOutcome.outcome, "fast_path");

    const suspended = transitionPhase3ProcedureSuspend(active as never, {
      decision: "suspended",
      reason: SUSPEND_REASON,
    });
    assert.equal((await execute(gateInput("active", suspended))).outcome, "slow_path", "挂起后不可执行");

    const resumed = transitionPhase3ProcedureResume(suspended as never, { decision: "active" });
    assert.equal(resumed.status, "active");
    assert.equal((await execute(gateInput("active", resumed))).outcome, "fast_path", "resume 后恢复可执行");

    const retired = transitionPhase3ProcedureRetire(resumed as never, {
      decision: "retired",
      reason: RETIRE_REASON,
    });
    assert.equal((await execute(gateInput("active", retired))).outcome, "slow_path", "retired 后永久停用");
  });

  it("执行不产生状态副作用：execute 后 procedure 状态不变（不自我发布/降级）", async () => {
    for (const status of ["active", "suspended", "retired"] as const) {
      const procedure = procedureOf(status);
      await execute(gateInput("active", procedure));
      await execute(gateInput(undefined, procedure));
      assert.equal(procedure.status, status, `${status} 执行后状态不得改变`);
    }
  });
});
