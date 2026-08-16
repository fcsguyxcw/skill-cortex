/**
 * Phase 5 host lifecycle wiring（project-local；依赖注入，不持有 registry）。
 *
 * 把真实事件源喂给 lifecycle seams：
 * - 完整 installed/discovered Skill identity snapshot（deriveDiscoverySourceHashes 的
 *   keySet，非 Top-K 候选）→ suspendProceduresForMissingSkills；
 * - 当次 current DependencyFingerprint（sourceHash 来自 derive 真实内容指纹，其余维度
 *   保持 procedure 绑定——宿主无独立当次来源时 self-match）→ suspendDriftedProcedures；
 * - PracticeStore.invalidate 的真实 invalidatedEventIds → applyEvidenceCascade；
 * - rollback 复用 lifecycle.rollbackToPreviousStable（已闭环：判定 + store.rollbackTo 落盘）。
 *
 * 边界：不改 .pi 生产入口；不启动 canary/active；不持有 registry；project-local only。
 */
import type { CompiledProcedure, DependencyFingerprint } from "../../core/contracts/index.ts";
import type { HostSkillLike } from "../../adapters/pi/host.ts";
import { deriveDiscoverySourceHashes } from "../../adapters/pi/core.ts";
import { ProcedureStore, type TriggerSource } from "../store/index.ts";
import {
  applyEvidenceCascade,
  suspendDriftedProcedures,
  suspendProceduresForMissingSkills,
  type CascadeOutcome,
  type DriftOutcome,
  type MissingSkillOutcome,
} from "./index.ts";

export type {
  CascadeOutcome,
  DriftOutcome,
  MissingSkillOutcome,
  RollbackPipelineOptions,
  RollbackPipelineResult,
} from "./index.ts";
export { rollbackToPreviousStable } from "./index.ts";

/** 一次 host lifecycle 收敛的全部真实输入（由真实事件源构造）。 */
export interface HostLifecycleSources {
  /** 完整 installed/discovered Skill identity snapshot（全部 skillId，非 Top-K）。 */
  installedSkillIds: ReadonlySet<string>;
  /** 当次 current fingerprint（按 procedure；返回 undefined ⇒ current 缺失，fail-closed）。 */
  currentFingerprintFor: (procedure: CompiledProcedure) => DependencyFingerprint | undefined;
  /** practice 证据删除的真实 invalidatedEventIds（PracticeStore.invalidate 结果）。 */
  invalidatedEventIds?: readonly string[];
  trigger: TriggerSource;
}

export interface HostLifecycleResult {
  /** dependency drift 处理结果（命中 ⇒ suspended）。 */
  drift: DriftOutcome[];
  /** evidence cascade 处理结果（命中 ⇒ suspended / already_terminal）。 */
  cascade: CascadeOutcome[];
  /** uninstall / scope / move-rename 处理结果（旧 parent ⇒ suspended）。 */
  missingSkills: MissingSkillOutcome[];
}

/**
 * 真实事件源的一次 lifecycle 收敛（最小接线）：
 * 1. dependency drift（current 指纹 diff → suspend 命中者）；
 * 2. skill identity（完整 installed 快照 → 旧 parent suspend）；
 * 3. evidence cascade（真实 invalidatedEventIds → 依赖者 suspend）。
 * 各步骤独立 fail-closed；无相关变化 ⇒ 无影响。
 */
export async function runHostLifecycle(options: {
  store: ProcedureStore;
  sources: HostLifecycleSources;
}): Promise<HostLifecycleResult> {
  const { store, sources } = options;
  const drift = await suspendDriftedProcedures({
    store,
    currentFor: sources.currentFingerprintFor,
    trigger: sources.trigger,
  });
  const missingSkills = await suspendProceduresForMissingSkills({
    store,
    currentInstalledSkillIds: sources.installedSkillIds,
    trigger: sources.trigger,
  });
  const cascade =
    sources.invalidatedEventIds !== undefined && sources.invalidatedEventIds.length > 0
      ? await applyEvidenceCascade({
          store,
          invalidatedEventIds: sources.invalidatedEventIds,
          trigger: sources.trigger,
        })
      : [];
  return { drift, cascade, missingSkills };
}

/**
 * 完整 installed snapshot：从当次宿主 skills 派生（deriveDiscoverySourceHashes 的真实
 * 内容指纹表 keySet——与 catalog 摄入同一 buildSkillRecord 逻辑，键与候选卡一致；
 * disabled 项不在内）。不是当前任务 Top-K 候选。
 */
export async function installedSkillIdsFromSkills(
  skills: readonly HostSkillLike[],
): Promise<ReadonlySet<string>> {
  const hashes = await deriveDiscoverySourceHashes(skills);
  return new Set(hashes.keys());
}

/**
 * 当次 current fingerprint（最小接线）：
 * - sourceHash 来自 derive 表（当次 SKILL.md 真实内容指纹，非 procedure 自身）；
 * - 其余维度（toolSchemaHash/permissionPolicyHash/environmentClass/modelId/promptHash）
 *   保持 procedure 绑定（宿主无独立当次来源时 self-match；tool/permission 的真实当次
 *   值由宿主验证来源提供时可覆盖 currentFingerprintFor）。
 * 当前 skill 不在 derive 表（uninstall 等）⇒ undefined（调用方 fail-closed）。
 */
export function currentFingerprintFromSourceHashes(
  sourceHashes: ReadonlyMap<string, string>,
  procedure: CompiledProcedure,
): DependencyFingerprint | undefined {
  const sourceHash = sourceHashes.get(procedure.parentSkillId);
  if (sourceHash === undefined) return undefined;
  const fingerprint: DependencyFingerprint = { sourceHash };
  const target = fingerprint as unknown as Record<string, unknown>;
  for (const field of [
    "toolSchemaHash",
    "permissionPolicyHash",
    "environmentClass",
    "modelId",
    "promptHash",
  ] as const) {
    const value = procedure.dependencyFingerprint[field];
    if (value !== undefined) target[field] = value;
  }
  return fingerprint;
}
