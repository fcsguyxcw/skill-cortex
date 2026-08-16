/**
 * Phase 5 host lifecycle pipeline（project-local；可调用 seams，不持有 registry）。
 *
 * 把既有纯函数（dependency-diff / evidence-cascade / draft 状态机与 rollback）与
 * ProcedureStore 串成真实 lifecycle 动作。每个 seam 依赖注入 store 与当次 current/
 * discovery 输入，不持有 registry、不接生产入口。
 *
 * seams：
 * - applyDependencyDrift / suspendDriftedProcedures：当次 current fingerprint → diff →
 *   命中则 suspend（suspendKind="dependency_drift"）。missing/malformed current fail-closed
 *   （不得当作无漂移）；mismatch 不执行 artifact（本模块只 diff + suspend，无执行路径）。
 * - applyEvidenceCascade：PracticeStore.invalidate 的真实 invalidatedEventIds → 命中则
 *   suspend（suspendKind="evidence_cascade"）；终态不非法重复 transition。
 * - rollbackToPreviousStable：previousStableRevision → getStableByRevision → 对 stable
 *   candidate 做真实 current dependency diff，匹配才派生 dependencyRevalidated（硬约束：
 *   rollbackProcedure 的 dependencyRevalidated=true 只可能来自本模块内部的真实 diff，
 *   外部无任何 seam 可自行声明重验通过）→ rollbackProcedure → store.rollbackTo 落盘。
 * - suspendProceduresForMissingSkills：完整 installed/discovered Skill identity snapshot
 *   （非 Top-K 候选）→ 旧 parent uninstall/scope 改变/move-rename 的 procedure fail-closed
 *   suspend（不得把新安装实例当旧 parent）。
 *
 * 边界：不做 WAL/crash consistency（real-host 前 blocker）；不启动 canary/active；
 * 不因测试全绿宣称 Gate P5 PASS；不接 resolver/executor/.pi 生产入口。
 */
import type { CompiledProcedure, DependencyFingerprint } from "../../core/contracts/index.ts";
import {
  SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX,
  SUSPEND_REASON_EVIDENCE_CASCADE,
  rollbackProcedure,
  transitionPhase3ProcedureSuspend,
  type Phase3InvalidatableProcedure,
  type RollbackFailureReason,
} from "../phase3/index.ts";
import { diffProcedureDependencies } from "../phase3/dependency-diff.ts";
import { findAffectedByEvidenceDeletion } from "../phase3/evidence-cascade.ts";
import { ProcedureStore, type TriggerSource } from "../store/index.ts";

// ---------------------------------------------------------------------------
// current fingerprint fail-closed
// ---------------------------------------------------------------------------

const SHA256_HASH_RE = /^(?:sha256:)?[0-9a-f]{64}$/u;

/**
 * current fingerprint 完整性（fail-closed）：sourceHash 必须存在且为 sha256。
 * missing/malformed ⇒ throw（接线错误），绝不当作“无漂移”。
 */
function assertCurrentFingerprint(current: DependencyFingerprint): void {
  if (typeof current !== "object" || current === null || current === undefined) {
    throw new Error("lifecycle_pipeline_current_fingerprint_required");
  }
  if (typeof current.sourceHash !== "string" || !SHA256_HASH_RE.test(current.sourceHash)) {
    throw new Error("lifecycle_pipeline_current_source_hash_invalid");
  }
}

function isInvalidatable(procedure: CompiledProcedure): boolean {
  return procedure.status === "validated" || procedure.status === "canary" || procedure.status === "active";
}

// ---------------------------------------------------------------------------
// 1. Dependency Drift
// ---------------------------------------------------------------------------

export interface DriftOutcome {
  procedureId: string;
  status: "unchanged" | "suspended";
  impactedDimensions: readonly string[];
  /** suspended 时的受控失效原因（审计）。 */
  reason?: string;
}

/**
 * 单 procedure dependency drift（mismatch 时不得先执行一次——本函数不执行 artifact，
 * 只 diff + suspend）。suspendKind="dependency_drift"（rollback 的 requires_revalidation
 * 门依赖该枚举，不靠 reason 文本）。
 */
export async function applyDependencyDrift(
  procedure: Phase3InvalidatableProcedure,
  current: DependencyFingerprint,
  store: ProcedureStore,
  trigger: TriggerSource,
): Promise<DriftOutcome> {
  assertCurrentFingerprint(current);
  const diff = diffProcedureDependencies(procedure, current);
  if (!diff.shouldInvalidate) {
    return { procedureId: procedure.procedureId, status: "unchanged", impactedDimensions: [] };
  }
  const reason = `${SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX}${[...diff.impactedDimensions].join(",")}`;
  const suspended = transitionPhase3ProcedureSuspend(procedure, {
    decision: "suspended",
    reason,
    suspendKind: "dependency_drift",
  });
  await store.transition(procedure, suspended, { trigger });
  return {
    procedureId: procedure.procedureId,
    status: "suspended",
    impactedDimensions: [...diff.impactedDimensions],
    reason,
  };
}

/**
 * 批处理：遍历当前非终态 procedure，按 currentFor 取当次指纹并 suspend 命中者。
 * currentFor 返回 undefined（当次 current 不可取得）⇒ fail-closed suspend
 * （reason 标注 current_unavailable——缺失不得当作无漂移）。
 */
export async function suspendDriftedProcedures(options: {
  store: ProcedureStore;
  currentFor: (procedure: CompiledProcedure) => DependencyFingerprint | undefined;
  trigger: TriggerSource;
}): Promise<DriftOutcome[]> {
  const results: DriftOutcome[] = [];
  const procedures = await options.store.listCurrent();
  for (const procedure of procedures) {
    if (!isInvalidatable(procedure)) continue; // 终态跳过（已不可执行）
    const current = options.currentFor(procedure);
    if (current === undefined) {
      const reason = `${SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX}current_unavailable`;
      const suspended = transitionPhase3ProcedureSuspend(procedure as Phase3InvalidatableProcedure, {
        decision: "suspended",
        reason,
        suspendKind: "dependency_drift",
      });
      await options.store.transition(procedure, suspended, { trigger: options.trigger });
      results.push({ procedureId: procedure.procedureId, status: "suspended", impactedDimensions: [], reason });
      continue;
    }
    results.push(
      await applyDependencyDrift(
        procedure as Phase3InvalidatableProcedure,
        current,
        options.store,
        options.trigger,
      ),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2. Evidence Cascade
// ---------------------------------------------------------------------------

export interface CascadeOutcome {
  procedureId: string;
  status: "suspended" | "already_terminal";
  reason?: string;
}

/**
 * Evidence cascade：PracticeStore.invalidate 的真实 invalidatedEventIds →
 * findAffectedByEvidenceDeletion → 命中且非终态的 procedure suspend
 * （suspendKind="evidence_cascade"，reason=SUSPEND_REASON_EVIDENCE_CASCADE）。
 * 已 suspended/retired 的 procedure 跳过（不非法重复 transition）；
 * evidence 失效后 active procedure 必被 suspend（不得保持 executable）。
 */
export async function applyEvidenceCascade(options: {
  store: ProcedureStore;
  invalidatedEventIds: readonly string[];
  trigger: TriggerSource;
}): Promise<CascadeOutcome[]> {
  const procedures = await options.store.listCurrent();
  const affected = findAffectedByEvidenceDeletion(options.invalidatedEventIds, {
    procedures: procedures.map((p) => ({
      procedureId: p.procedureId,
      status: p.status,
      evidenceIds: p.evidenceIds,
    })),
  });
  const affectedIds = new Set(affected.affectedProcedureIds);
  const outcomes: CascadeOutcome[] = [];
  for (const procedure of procedures) {
    if (!affectedIds.has(procedure.procedureId)) continue;
    if (!isInvalidatable(procedure)) {
      outcomes.push({ procedureId: procedure.procedureId, status: "already_terminal" });
      continue;
    }
    const suspended = transitionPhase3ProcedureSuspend(procedure as Phase3InvalidatableProcedure, {
      decision: "suspended",
      reason: SUSPEND_REASON_EVIDENCE_CASCADE,
      suspendKind: "evidence_cascade",
    });
    await options.store.transition(procedure, suspended, { trigger: options.trigger });
    outcomes.push({
      procedureId: procedure.procedureId,
      status: "suspended",
      reason: SUSPEND_REASON_EVIDENCE_CASCADE,
    });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// 3. Rollback（dependencyRevalidated 硬约束封装）
// ---------------------------------------------------------------------------

/**
 * dependencyRevalidated 的唯一真实来源（硬约束）：stable candidate 在当次 current
 * fingerprint 下 diff 无命中（shouldInvalidate=false）才派生 true。本函数为模块私有，
 * 外部没有任何 seam 允许调用方自行声明重验通过（禁止配置注入/测试 shortcut 冒充）。
 */
function deriveRevalidationFromCurrent(stable: CompiledProcedure, current: DependencyFingerprint): boolean {
  return diffProcedureDependencies(stable, current).shouldInvalidate === false;
}

export type RollbackPipelineResult =
  | { ok: true; rollbackTo: CompiledProcedure & { status: "active" } }
  | { ok: false; reason: RollbackFailureReason; slowPath: true };

export interface RollbackPipelineOptions {
  store: ProcedureStore;
  /** 当前失效/需回滚的 procedure（suspended from drift/cascade/superseded）。 */
  failedProcedure: CompiledProcedure;
  /** 当次 current fingerprint（stable candidate 的真实 revalidation diff 来源）。 */
  current: DependencyFingerprint;
  trigger: TriggerSource;
}

/**
 * 一键回滚 pipeline（闭环：判定 + 落盘）：
 * - previousStableRevision → store.getStableByRevision()（release 记录，不猜任意历史 revision）；
 * - 对 stable candidate 做真实 current dependency diff → 匹配才派生 dependencyRevalidated；
 * - 硬约束：stable 在当次 current 下仍 dependency mismatch ⇒ 不落盘（requires_revalidation，
 *   slow path）。覆盖 active 与 suspended-from-active 两种 stable 形态——rollbackProcedure
 *   只对 suspended 目标强制 revalidation，active 目标此前被忽略，此处补齐 fail-closed；
 * - rollbackProcedure（既有 lineage/稳定状态/revalidation 校验）；
 * - ok ⇒ store.rollbackTo() 真正切回 stable revision（current 覆盖 + release + 可审计
 *   rollback 事件，store seam 内部再复核 stale-prior/lineage/stable 合法性）；
 * - fail ⇒ 明确 reason + slowPath=true（调用方走父 Skill 慢路径）。
 */
export async function rollbackToPreviousStable(
  options: RollbackPipelineOptions,
): Promise<RollbackPipelineResult> {
  assertCurrentFingerprint(options.current);
  const previous = options.failedProcedure.previousStableRevision;
  const stable =
    previous === undefined ? undefined : await options.store.getStableByRevision(previous);
  const revalidated =
    stable !== undefined ? deriveRevalidationFromCurrent(stable, options.current) : false;
  // 硬约束：stable 当前 dependency 仍 mismatch ⇒ 不落盘（慢路径）。active 稳定目标同样受此门
  // 约束（此前 rollbackProcedure 只对 suspended 目标强制，active 目标被忽略）。
  if (stable !== undefined && !revalidated) {
    return { ok: false, reason: "requires_revalidation", slowPath: true };
  }
  const result = rollbackProcedure({
    current: options.failedProcedure,
    stableLookup: (revision) => (stable !== undefined && revision === previous ? stable : undefined),
    dependencyRevalidated: revalidated,
  });
  if (!result.ok) {
    return { ...result, slowPath: true };
  }
  await options.store.rollbackTo(options.failedProcedure, previous!, {
    trigger: options.trigger,
  });
  return result;
}

// ---------------------------------------------------------------------------
// 4. Skill uninstall / scope / move-rename（identity snapshot 语义）
// ---------------------------------------------------------------------------

export interface MissingSkillOutcome {
  procedureId: string;
  parentSkillId: string;
  status: "suspended" | "already_terminal";
  reason?: string;
}

/**
 * 完整 installed/discovered Skill identity snapshot 失效矩阵（最小路径）：
 * currentInstalledSkillIds 是**完整 installed/discovered Skill identity snapshot**（当次摄入
 * 的全部 skillId，按 scope + baseDir 派生，含所有 scope），**不是**当前任务 Top-K 候选——
 * Top-K 只表达“与任务相关”，不能作为“skill 是否存在/是否同源”的判据。
 *
 * 身份语义（Phase 0 冻结，computeSkillId = sha256(scope + baseDir)）：
 * - uninstall：旧 skillId 不在完整快照 ⇒ 相关 procedure suspend；
 * - scope 改变（user→project 等）：产生新 skillId ⇒ 旧 procedure 不继承（suspend）；
 * - move/rename：baseDir 变化 ⇒ 按新安装实例处理（新 skillId），旧 procedure suspend；
 * - 同名不同 scope/path：skillId 不同 ⇒ 各自独立判定，互不误伤；
 * - 快照仍含 parentSkillId 的 procedure 保持原状态（unrelated 不变）。
 * 新安装实例（新 skillId）不会匹配旧 parent（lineage 由 rollback/diff 的
 * procedureId/parentSkillId/sourceHash 校验保证）。
 * currentInstalledSkillIds 必填（缺失 ⇒ throw：无法判定 identity 时不得当作无变化）。
 */
export async function suspendProceduresForMissingSkills(options: {
  store: ProcedureStore;
  /** 完整 installed/discovered Skill identity snapshot（全部 skillId，非 Top-K 候选）。 */
  currentInstalledSkillIds: ReadonlySet<string>;
  trigger: TriggerSource;
}): Promise<MissingSkillOutcome[]> {
  if (
    options.currentInstalledSkillIds === undefined ||
    options.currentInstalledSkillIds === null
  ) {
    throw new Error("lifecycle_pipeline_current_skill_ids_required");
  }
  const procedures = await options.store.listCurrent();
  const outcomes: MissingSkillOutcome[] = [];
  for (const procedure of procedures) {
    if (options.currentInstalledSkillIds.has(procedure.parentSkillId)) continue;
    if (!isInvalidatable(procedure)) {
      outcomes.push({ procedureId: procedure.procedureId, parentSkillId: procedure.parentSkillId, status: "already_terminal" });
      continue;
    }
    const reason = `${SUSPEND_REASON_DEPENDENCY_DRIFT_PREFIX}skill identity change`;
    const suspended = transitionPhase3ProcedureSuspend(procedure as Phase3InvalidatableProcedure, {
      decision: "suspended",
      reason,
      suspendKind: "dependency_drift",
    });
    await options.store.transition(procedure, suspended, { trigger: options.trigger });
    outcomes.push({
      procedureId: procedure.procedureId,
      parentSkillId: procedure.parentSkillId,
      status: "suspended",
      reason,
    });
  }
  return outcomes;
}
