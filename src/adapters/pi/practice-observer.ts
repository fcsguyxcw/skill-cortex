/**
 * B3 — project-local 真实 Pi Practice observer（最小可测版，消费式设计）。
 *
 * 职责（不自行计算任何 discovery 结果）：
 * - 只消费外部注入的显式 `RouteSnapshot`（当次 discovery 候选快照，来自 registerSkillCortex 的
 *   onDiscovery seam；未接线时 observer 处于 unwired 状态）；
 * - 通过 tool_call/tool_result 观察主 Agent 的 `load_skill` 调用作为“选中慢路径”证据；
 * - agent_settled 时用快照校验选中（skillId ∈ 候选、revision 精确匹配、details 若带
 *   source_hash 必须与快照一致），逐条合成 PracticeEvent 并经 policy gate append 进
 *   project-local PracticeStore。
 *
 * 严格失败边界（fail-closed / 报告未接线，绝不冒充）：
 * - 无 route snapshot（seam 未接线）⇒ 不产生任何事件，onStatus 报告 unwired；
 * - 候选快照不含该 skillId、revision 不匹配、load_skill 被拒绝、或 details source_hash
 *   与快照不一致 ⇒ 不产生事件（无法归因到当次 discovery 决策）；
 * - 无 verifier/guard/授权结果可观察 ⇒ 保持空/unknown，绝不把工具成功改写成
 *   verified_skill_effect；
 * - 原始 prompt 只落盘派生 hash（prompt-hash/candidate-count/selected-count），不落盘
 *   任务文本；任何观察/落盘错误 fail open（不阻断主 Agent，只交给 onError）；
 * - 不写 ~/.pi 或工作区外路径。
 *
 * 真实宿主证据（0.84.1，见 docs/research/2026-08-14-phase0-pi-api-inventory.md）：
 * - before_agent_start: event.prompt + event.systemPromptOptions.skills（仅用于 task hash）；
 * - tool_call: toolName/toolCallId/input（CustomToolCallEvent）；
 * - tool_result: toolName/toolCallId/isError/details（CustomToolResultEvent）；
 * - agent_settled: 确认无自动续跑后的唯一落盘点；
 * - ctx.sessionManager.getSessionId(): run 关联键。
 *
 * 当前集成状态：phase12 的共享 seam（registerSkillCortex 的 `onDiscovery` 回调 + load_skill
 * details.source_hash）已落地；接线方式见 `createDiscoverySnapshotSource` 与报告文档。
 * 本模块不修改 core.ts/index.ts。
 */
import { createHash } from "node:crypto";
import path from "node:path";

import type {
  ExtensionAPI,
  BeforeAgentStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import type { CandidateBudgetShadowObservation, CardProjectionShadowObservation, ExposureObservation, ExposureObservationRecord, PracticeEvent } from "../../core/contracts/index.ts";
import { sha256Hex } from "../../core/registry/index.ts";
import { resolveAttribution } from "../../practice/policy/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import type { DiscoveryResult } from "./core.ts";

/** eventId 前缀（配合 SAFE_EVENT_ID_RE 字符集）。 */
export const OBSERVER_EVENT_PREFIX = "obs-";

export type ObserverPhase = "ingest" | "capture" | "finalize";

/** 未接线/接线诊断。 */
export interface ObserverStatus {
  wired: boolean;
  reason?:
    | "no_route_snapshot_source"
    | "no_route_snapshot"
    | "not_exposed_to_agent"
    | "learning_paused"
    | "ok";
  /** 最近一次 finalize 成功落盘的事件数。 */
  appendedEvents?: number;
}

/** 候选快照中的单个 Skill（最小化：仅身份字段，不含 sourceHash/description/路径/正文）。 */
export interface RouteSnapshotSkill {
  skillId: string;
  skillRevision: string;
}

/**
 * compiled execution 证据（通用，不硬编码具体 procedure/工具名）。
 *
 * 由 options.compiledTool.decode(details) 从宿主 artifact 工具 tool_result.details
 * 严格解码产生；任何形状/身份/内容校验失败返回 undefined ⇒ fail closed（不产生事件）。
 * failureClass / firstAttributableFailureStepId 只在有证据时写入；attribution 由
 * policy resolveAttribution 规则在事件构建后重算，绝不硬写 unknown。
 */
export interface CompiledExecutionEvidence {
  procedureId: string;
  dependencyFingerprint?: PracticeEvent["dependencyFingerprint"];
  authorizationResults: PracticeEvent["authorizationResults"];
  guardResults: PracticeEvent["guardResults"];
  verifierResults: PracticeEvent["verifierResults"];
  stepSummaries: PracticeEvent["stepSummaries"];
  failureClass?: PracticeEvent["failureClass"];
  firstAttributableFailureStepId?: string;
}

/** compiled execution 证据 seam 配置（通用工具名 + 严格解码器）。 */
export interface CompiledToolOptions {
  /** 宿主 artifact 工具名（如 skill_cortex_pagination_detect）；observer 不硬编码任何具体工具。 */
  toolName: string;
  /**
   * 严格解码 tool_result.details → CompiledExecutionEvidence；
   * 任何形状/身份/内容校验失败返回 undefined（fail closed）。
   */
  decode(details: unknown): CompiledExecutionEvidence | undefined;
}

/**
 * 已通过快照校验 + 加载结果重验的选中项。sourceHash 来自对应 load_skill
 * tool_result.details.source_hash（snake_case，严格 sha256，缺失即排除）。
 */
export interface AttributableSelection {
  skillId: string;
  skillRevision: string;
  /** "sha256:" + 64 hex（phase12 后 load_skill 返回前重验的完整 revision 指纹）。 */
  sourceHash: string;
}

/**
 * 当次 discovery 决策的显式快照（协调纠偏：必须来自共享 seam，observer 不得独立重算）。
 * phase12 已落地的 onDiscovery 回调（inject/shadow 均触发）经 createDiscoverySnapshotSource
 * 注入到 RouteSnapshotSource。
 *
 * `exposedToAgent`：Main Agent 是否实际看到这些候选。只有 phase12 成功 inject 后的
 * 快照（true）才能作为 provenance=real 事件的候选依据；shadow 或 prompt rewrite
 * fail-open 的候选（false）一律不得生成 real 事件（fail-closed）。
 */
export interface RouteSnapshot {
  exposedToAgent: boolean;
  candidateSkills: readonly RouteSnapshotSkill[];
  exposure?: ExposureObservation;
  candidateBudget?: CandidateBudgetShadowObservation;
  cardProjection?: CardProjectionShadowObservation;
}

/**
 * 快照 seam（一次性消费）。phase12 契约：
 * - cortex 侧：每次 before_agent_start 开始时清空 pending，仅在成功 inject（exposedToAgent=true）
 *   后 push；rewrite 失败 / shadow 不留快照；
 * - observer 侧：在同一次 before_agent_start 中（cortex handler 先执行、observer handler 随后）
 *   takeRouteSnapshot() 一次性取走并绑定到当前 RunCollector；agent_settled 后 clear()，
 *   防止旧快照残留串到下一轮。
 * 未接线时（无 source）observer 处于 unwired 状态。
 */
export interface RouteSnapshotSource {
  /** 取走当前 pending 快照（一次性；无 pending 返回 undefined）。 */
  takeRouteSnapshot(): RouteSnapshot | undefined;
  /** 清空 pending（settled 后调用，防 stale 串轮）。 */
  clear(): void;
}

export interface PracticeObserverOptions {
  /** 已构造的 project-local PracticeStore（rootDir 必须位于 projectRoot 内）。 */
  store: PracticeStore;
  /** 项目根（tenantScope 派生基准）。 */
  projectRoot: string;
  /** 覆盖默认 tenantScope（"project:" + sha256(normalize(projectRoot)).slice(0,32)）。 */
  tenantScope?: string;
  /** 候选快照 seam。未提供 ⇒ observer unwired，不产生事件。 */
  routeSnapshotSource?: RouteSnapshotSource;
  /** 落盘前的结果校验（默认放行；source_hash 的严格 sha256 校验由 selectAttributableSkills 强制）。 */
  verifyLoadResult?: (details: unknown, snapshot: RouteSnapshotSkill) => boolean;
  /** 通用证据钩子（B4+）：注入 verifier/步骤证据；observer 不硬编码任何具体 verifier。 */
  evidenceHook?: EvidenceHook;
  /**
   * compiled execution 证据 seam（通用工具名 + 严格解码器）；未提供 ⇒ 无 compiled 事件，
   * 只观察 load_skill 慢路径。shadow_replay 快路径证据经此进入 provenance=shadow 事件。
   */
  compiledTool?: CompiledToolOptions;
  /** 观察/落盘错误回调（fail open，不阻断主 Agent）。 */
  onError?: (error: unknown, phase: ObserverPhase) => void;
  /** 每个成功落盘事件的观察回调（测试/审计）。 */
  onEvent?: (event: PracticeEvent) => void;
  /** 接线状态回调。 */
  onStatus?: (status: ObserverStatus) => void;
  /** 持久化前学习开关；false 时不保留 run、不写 PracticeEvent。缺省=true。 */
  learningEnabled?: () => boolean | Promise<boolean>;
  /** D2 shadow-only observation 落盘 seam；只接收脱敏检索事实与最终合法选择。 */
  onExposure?: (record: ExposureObservationRecord) => void | Promise<void>;
  now?: () => Date;
}

/** 默认 tenantScope：project 前缀 + 规范化项目根的 SHA-256 前 32 hex（不含原始路径）。 */
export function defaultTenantScope(projectRoot: string): string {
  const normalized = path
    .resolve(projectRoot)
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("\\", "/");
  return `project:${sha256Hex(normalized).slice(0, 32)}`;
}

/** eventId = "obs-" + sha256(runKey + "\0" + skillId) 前 40 hex。确定、有界、无路径字符。 */
export function deriveEventId(runKey: string, skillId: string): string {
  return OBSERVER_EVENT_PREFIX + sha256Hex(`${runKey}\u0000${skillId}`).slice(0, 40);
}

/** routeDecisionId = "route:" + sha256(runKey) 前 32 hex（关联同一 run 的事件）。 */
export function deriveRouteDecisionId(runKey: string): string {
  return `route:${sha256Hex(runKey).slice(0, 32)}`;
}

/** policy 受控文本字符集（[\p{L}\p{N} _.:@+\-]）之外一律替换为 "_"；空结果返回 ""。 */
const CONTROLLED_CHARS_RE = /[^\p{L}\p{N} _.:@+\-]/gu;
export function sanitizeOperationClass(value: string, maxLength = 128): string {
  return value.replace(CONTROLLED_CHARS_RE, "_").trim().slice(0, maxLength);
}

/** 任务特征派生 hash（原始 prompt 永不落盘）。 */
function sha256HexOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function getSessionId(ctx: unknown): string | undefined {
  const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => string } })
    ?.sessionManager;
  if (typeof sessionManager?.getSessionId !== "function") return undefined;
  try {
    const id = sessionManager.getSessionId();
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** 一次 load_skill 调用在 run 内的观察证据（含 tool_result details，供 settled 校验）。 */
export interface LoadEvidence {
  toolCallId: string;
  skillId?: string;
  skillRevision?: string;
  outcome: "ok" | "failed" | "unknown";
  /** load_skill tool_result 的 details（phase12 seam 后含 source_hash）。 */
  details?: unknown;
}

/** compiled 工具调用的观察证据（tool_call 记录，成功 tool_result 后才保存 evidence）。 */
interface CompiledCallEvidence {
  toolCallId: string;
  skillId?: string;
  skillRevision?: string;
  outcome: "ok" | "failed" | "unknown";
  /** 成功 tool_result 且严格解码通过后保存；blocked/解码失败/形状非法 ⇒ undefined（fail closed）。 */
  evidence?: CompiledExecutionEvidence;
  details?: unknown;
}

/** 脱敏工具步骤（只保留工具名类别与结果，不落盘 args/result）。 */
export interface ObservedStep {
  stepId: string;
  toolName: string;
  outcome: "ok" | "failed" | "unknown";
}

/**
 * 证据钩子注入的步骤（B4+：独立于宿主工具事件的步骤，如确定性 detector）。
 * actor 由注入方声明（合同枚举：agent/procedure/tool/user）；默认 procedure。
 */
export interface HookEvidenceStep {
  actor?: PracticeEvent["stepSummaries"][number]["actor"];
  operationClass: string;
  outcome: "ok" | "failed" | "unknown";
}

/**
 * 证据钩子的输出：额外的步骤与 verifier 结果。observer 不信任其格式，
 * 落盘前仍由 policy gate 校验（operationClass 受控文本、verifierId SAFE_ID 等）。
 */
export interface HookEvidence {
  steps: readonly HookEvidenceStep[];
  verifierResults: ReadonlyArray<{
    verifierId: string;
    result: "pass" | "fail" | "unknown";
    observedEffect?: string;
  }>;
}

/**
 * 通用证据钩子（observer 保持通用：不硬编码任何 verifier/operationClass）。
 * 注入方（如 B4 pagination harness）在 run 结束时对每个选中 Skill 收集额外
 * 步骤与 verifier 结果；返回 undefined 表示本次不注入（事件保持无 verifier）。
 */
export interface EvidenceHook {
  collect(
    run: RunCollector,
    selection: AttributableSelection,
  ): Promise<HookEvidence | undefined>;
}

/**
 * 单次 agent run 的采集器（纯内存、可测）。
 * 不自行摄入/重算候选；只聚合宿主事件，settled 时交由快照校验合成。
 */
export class RunCollector {
  readonly runKey: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly tenantScope: string;
  readonly taskHash: string;
  /** 原始用户 prompt（仅内存，用于 evidenceHook 输入；绝不落盘）。 */
  readonly prompt: string;
  /** 本次 run 消费到的候选快照（cortex 成功 inject 后由 observer 在 before_agent_start 绑定）。 */
  readonly snapshot: RouteSnapshot | undefined;
  /** 快照未绑定时的稳定原因（finalize 时上报，不泄漏内部细节）。 */
  readonly snapshotRejectReason: ObserverStatus["reason"] | undefined;
  readonly steps: ObservedStep[] = [];
  readonly loadEvidenceByCallId = new Map<string, LoadEvidence>();
  readonly loadedSkillIds = new Set<string>();
  /** compiled 工具调用证据（仅在对应成功 tool_result 后保存 evidence）。 */
  readonly compiledEvidenceByCallId = new Map<string, CompiledCallEvidence>();
  readonly compiledTool?: CompiledToolOptions;
  #stepSeq = 0;

  constructor(options: {
    runKey: string;
    sessionId: string;
    startedAt: string;
    tenantScope: string;
    taskHash: string;
    prompt: string;
    snapshot?: RouteSnapshot;
    snapshotRejectReason?: ObserverStatus["reason"];
    /** compiled execution 证据 seam（可选；未提供 ⇒ 不观察 compiled 工具）。 */
    compiledTool?: CompiledToolOptions;
  }) {
    this.runKey = options.runKey;
    this.sessionId = options.sessionId;
    this.startedAt = options.startedAt;
    this.tenantScope = options.tenantScope;
    this.taskHash = options.taskHash;
    this.prompt = options.prompt;
    this.snapshot = options.snapshot;
    this.snapshotRejectReason = options.snapshotRejectReason;
    this.compiledTool = options.compiledTool;
  }

  /** tool_call：记录 load_skill 与 compiled 工具调用（参数级证据；不判定候选性）。 */
  onToolCall(event: ToolCallEvent): void {
    if (event.toolName === "load_skill") {
      const input = event.input;
      const skillId = typeof input.skill_id === "string" ? input.skill_id : undefined;
      const skillRevision =
        typeof input.skill_revision === "string" ? input.skill_revision : undefined;
      if (skillId === undefined || skillRevision === undefined) return;
      this.loadEvidenceByCallId.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        skillId,
        skillRevision,
        outcome: "unknown",
      });
      return;
    }
    if (this.compiledTool !== undefined && event.toolName === this.compiledTool.toolName) {
      // compiled 工具名是注入字符串（非字面量），无法对宿主事件联合做字面量收窄；
      // 与 details 同型 cast（自定义工具 input 恒为 Record<string, unknown>）。
      const input = (event as { input: Record<string, unknown> }).input;
      const skillId = typeof input.skill_id === "string" ? input.skill_id : undefined;
      const skillRevision =
        typeof input.skill_revision === "string" ? input.skill_revision : undefined;
      if (skillId === undefined || skillRevision === undefined) return;
      this.compiledEvidenceByCallId.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        skillId,
        skillRevision,
        outcome: "unknown",
      });
      return;
    }
  }

  /** tool_result：确认工具结果并保存 details；compiled 证据只在成功 result 后解码保存。 */
  onToolResult(event: ToolResultEvent): void {
    const evidence = this.loadEvidenceByCallId.get(event.toolCallId);
    if (evidence !== undefined) {
      const ok = isLoadSkillOk(event);
      evidence.outcome = ok ? "ok" : event.isError ? "failed" : "unknown";
      evidence.details = (event as { details?: unknown }).details;
      this.#recordStep(event.toolName, evidence.outcome);
      if (ok && evidence.skillId !== undefined) {
        this.loadedSkillIds.add(evidence.skillId);
      }
      return;
    }
    const compiled = this.compiledEvidenceByCallId.get(event.toolCallId);
    if (compiled !== undefined) {
      const details = (event as { details?: unknown }).details;
      compiled.details = details;
      if (event.isError) {
        // 工具失败：不产证据（fail closed）。
        compiled.outcome = "failed";
        this.#recordStep(event.toolName, "failed");
        return;
      }
      // 成功 tool_result 后才解码；blocked（无 tool_result）自然不产证据。
      // 解码返回 undefined 或形状非法 ⇒ 不保存 evidence（fail closed）。
      compiled.outcome = "ok";
      const decoded = this.compiledTool?.decode(details);
      compiled.evidence =
        decoded !== undefined && isValidCompiledEvidence(decoded) ? decoded : undefined;
      this.#recordStep(event.toolName, "ok");
      return;
    }
    this.#recordStep(event.toolName, event.isError ? "failed" : "ok");
  }

  #recordStep(toolName: string, outcome: ObservedStep["outcome"]): void {
    this.#stepSeq += 1;
    this.steps.push({ stepId: `step-${this.#stepSeq}`, toolName, outcome });
  }
}

/**
 * 从 phase12 的 onDiscovery 回调适配出的快照 source（接线层使用）：
 *
 * ```ts
 * const source = createDiscoverySnapshotSource();
 * registerSkillCortex(pi, { mode: "inject", onDiscovery: (r) => source.push(r) });
 * registerPracticeObserver(pi, { store, projectRoot, routeSnapshotSource: source });
 * ```
 *
 * push 把 cortex 的当次候选（≤ topK）映射为最小 RouteSnapshot（id+revision），保留
 * exposedToAgent 语义；observer 在 before_agent_start take、settled 后 clear。
 */
export interface DiscoverySnapshotSource extends RouteSnapshotSource {
  /** 供 registerSkillCortex 的 onDiscovery 接线。 */
  push(result: DiscoveryResult): void;
}

export function createDiscoverySnapshotSource(): DiscoverySnapshotSource {
  let pending: RouteSnapshot | undefined;
  return {
    push(result: DiscoveryResult) {
      pending = {
        exposedToAgent: result.exposedToAgent,
        candidateSkills: result.candidates.map((candidate) => ({
          skillId: candidate.skillId,
          skillRevision: candidate.skillRevision,
        })),
        exposure: result.exposure,
        candidateBudget: result.candidateBudget,
        cardProjection: result.cardProjection,
      };
    },
    takeRouteSnapshot(): RouteSnapshot | undefined {
      const snapshot = pending;
      pending = undefined;
      return snapshot;
    },
    clear(): void {
      pending = undefined;
    },
  };
}

/** 与 policy 一致的严格 sha256 格式（可选 "sha256:" 前缀）。 */
const SOURCE_HASH_RE = /^(?:sha256:)?[0-9a-fA-F]{64}$/;

/**
 * 从 load_skill tool_result.details.source_hash 提取内容指纹（snake_case）。
 * 只接受严格 sha256；缺失/类型错/格式坏 ⇒ undefined（调用方 fail-closed）。
 * 不使用任何 camelCase 字段。
 */
export function extractSourceHash(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const value = (details as { source_hash?: unknown }).source_hash;
  if (typeof value !== "string" || !SOURCE_HASH_RE.test(value)) return undefined;
  return value;
}

/** 默认 load 结果校验：category 已在采集阶段确认；此处默认放行（source_hash 强制见 select）。 */
export function defaultVerifyLoadResult(
  _details: unknown,
  _snapshot: RouteSnapshotSkill,
): boolean {
  return true;
}

function isLoadSkillOk(event: ToolResultEvent): boolean {
  const details = (event as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return false;
  return (details as { category?: unknown }).category === "ok";
}

/**
 * 轻量防御校验：decoder 返回的 evidence 至少具备契约必需字段（procedureId + 五个数组）。
 * 任一缺失/类型错 ⇒ 视为解码失败（fail closed，不产生 compiled 事件）。
 * 细粒度字段（predicateId/verifierId/枚举/有界数组）由 policy gate 在 append 时兜底。
 */
function isValidCompiledEvidence(evidence: CompiledExecutionEvidence): boolean {
  if (typeof evidence.procedureId !== "string" || evidence.procedureId === "") return false;
  if (!Array.isArray(evidence.authorizationResults)) return false;
  if (!Array.isArray(evidence.guardResults)) return false;
  if (!Array.isArray(evidence.verifierResults)) return false;
  if (!Array.isArray(evidence.stepSummaries)) return false;
  return true;
}

/**
 * 用 run 采集结果 + 候选快照合成单个 PracticeEvent。
 * 无 verifier/guard/authorization 可观察 ⇒ 空/unknown（policy 会把 attribution 重算为
 * unknown，verified_skill_effect 永远不会由本路径产生）。
 */
export function buildPracticeEvent(
  run: RunCollector,
  selection: AttributableSelection,
  options: {
    now: () => Date;
    routeDecisionId: string;
    /** 当次 discovery 候选快照（主 Agent 实际看到的候选 skillId 列表，有界）。 */
    candidateSkillIds: string[];
    candidateCount: number;
    selectedCount: number;
    /** evidenceHook 注入的步骤/verifier（可选；无则保持无 verifier）。 */
    hookEvidence?: HookEvidence;
    /** compiled execution 证据（可选）；存在 ⇒ 生成 provenance=shadow 的 compiled_procedure 事件。 */
    compiledEvidence?: CompiledExecutionEvidence;
  },
): PracticeEvent {
  if (options.compiledEvidence !== undefined) {
    // 显式收窄：compiledEvidence 已在上方 if 判定为非 undefined。
    return buildCompiledPracticeEvent(run, selection, {
      now: options.now,
      routeDecisionId: options.routeDecisionId,
      candidateSkillIds: options.candidateSkillIds,
      candidateCount: options.candidateCount,
      selectedCount: options.selectedCount,
      compiledEvidence: options.compiledEvidence,
    });
  }
  // 统一 stepId 编号：宿主工具步骤在前，hook 注入步骤续后（stepId 全局唯一）。
  const stepSummaries: PracticeEvent["stepSummaries"] = [];
  for (const step of run.steps) {
    const operationClass = sanitizeOperationClass(`tool:${step.toolName}`);
    if (operationClass === "") continue;
    stepSummaries.push({
      stepId: `step-${stepSummaries.length + 1}`,
      actor: "tool",
      operationClass,
      outcome: step.outcome,
    });
  }
  for (const step of options.hookEvidence?.steps ?? []) {
    const operationClass = sanitizeOperationClass(step.operationClass);
    if (operationClass === "") continue;
    stepSummaries.push({
      stepId: `step-${stepSummaries.length + 1}`,
      actor: step.actor ?? "procedure",
      operationClass,
      outcome: step.outcome,
    });
  }
  const verifierResults: PracticeEvent["verifierResults"] = [];
  for (const result of options.hookEvidence?.verifierResults ?? []) {
    verifierResults.push({
      verifierId: result.verifierId,
      result: result.result,
      ...(result.observedEffect !== undefined
        ? { observedEffect: sanitizeOperationClass(result.observedEffect, 200) }
        : {}),
    });
  }

  return {
    schemaVersion: 1,
    eventId: deriveEventId(run.runKey, selection.skillId),
    occurredAt: options.now().toISOString(),
    tenantScope: run.tenantScope,
    provenance: "real",
    parentSkillId: selection.skillId,
    parentSkillRevision: selection.skillRevision,
    sourceHash: selection.sourceHash,
    routeDecisionId: options.routeDecisionId,
    candidateSkillIds: options.candidateSkillIds,
    selectedSkillIds: [selection.skillId],
    executionMode: "skill_md",
    redactedTaskFeatures: [
      `prompt-hash:${run.taskHash}`,
      `candidate-count:${options.candidateCount}`,
      `selected-count:${options.selectedCount}`,
    ],
    // host version 无法从已验证宿主 API 可靠取得，environmentFingerprint 省略（不硬编码）。
    dependencyFingerprint: {
      sourceHash: selection.sourceHash,
    },
    stepSummaries,
    authorizationResults: [],
    guardResults: [],
    verifierResults,
    attribution: "unknown",
    sensitivity: "none",
    retentionClass: "project_manual",
  };
}

/**
 * compiled execution 事件构建（通用；只消费已严格解码 + 快照身份校验的 evidence）。
 *
 * 合同字段：provenance=shadow（shadow_replay 观察式执行，仅靠 provenance 隔离生产证据）；
 * executionMode=compiled_procedure；procedureId/dependencyFingerprint/authorizationResults/
 * guardResults/verifierResults 全部来自 evidence；stepSummaries = 宿主工具步骤（tool-step-*
 * 独立前缀，避免与证据步骤 ID 冲突）+ 证据步骤（保留原 stepId，供 firstAttributableFailureStepId
 * 引用）；failureClass/firstAttributableFailureStepId 只在 evidence 提供时写入。
 * attribution 由 policy resolveAttribution 规则对构建后事件重算（绝不硬写 unknown 作为最终值）。
 */
function buildCompiledPracticeEvent(
  run: RunCollector,
  selection: AttributableSelection,
  options: {
    now: () => Date;
    routeDecisionId: string;
    candidateSkillIds: string[];
    candidateCount: number;
    selectedCount: number;
    compiledEvidence: CompiledExecutionEvidence;
  },
): PracticeEvent {
  const evidence = options.compiledEvidence;
  const stepSummaries: PracticeEvent["stepSummaries"] = [];
  for (const step of run.steps) {
    const operationClass = sanitizeOperationClass(`tool:${step.toolName}`);
    if (operationClass === "") continue;
    stepSummaries.push({
      stepId: `tool-step-${stepSummaries.length + 1}`,
      actor: "tool",
      operationClass,
      outcome: step.outcome,
    });
  }
  for (const step of evidence.stepSummaries) {
    const operationClass = sanitizeOperationClass(step.operationClass);
    if (operationClass === "") continue;
    stepSummaries.push({ ...step, operationClass });
  }

  const event: PracticeEvent = {
    schemaVersion: 1,
    eventId: deriveEventId(run.runKey, selection.skillId),
    occurredAt: options.now().toISOString(),
    tenantScope: run.tenantScope,
    provenance: "shadow",
    parentSkillId: selection.skillId,
    parentSkillRevision: selection.skillRevision,
    sourceHash: selection.sourceHash,
    routeDecisionId: options.routeDecisionId,
    candidateSkillIds: options.candidateSkillIds,
    selectedSkillIds: [selection.skillId],
    executionMode: "compiled_procedure",
    procedureId: evidence.procedureId,
    redactedTaskFeatures: [
      `prompt-hash:${run.taskHash}`,
      `candidate-count:${options.candidateCount}`,
      `selected-count:${options.selectedCount}`,
    ],
    dependencyFingerprint: evidence.dependencyFingerprint ?? { sourceHash: selection.sourceHash },
    stepSummaries,
    authorizationResults: evidence.authorizationResults,
    guardResults: evidence.guardResults,
    verifierResults: evidence.verifierResults,
    attribution: "unknown", // 占位；下方由 policy resolveAttribution 重算（不硬写 unknown 作为最终值）
    sensitivity: "none",
    retentionClass: "project_manual",
    ...(evidence.failureClass !== undefined ? { failureClass: evidence.failureClass } : {}),
    ...(evidence.firstAttributableFailureStepId !== undefined
      ? { firstAttributableFailureStepId: evidence.firstAttributableFailureStepId }
      : {}),
  };
  event.attribution = resolveAttribution(event);
  return event;
}

/**
 * 用快照过滤出本次 run 可归因的选中 Skill；任一校验失败即排除（不产生事件）：
 * 1. outcome 必须 ok；2. skillId ∈ 当次候选快照；3. revision 精确匹配；
 * 4. 自定义 verifyLoadResult（默认放行）；5. details.source_hash 必须存在且严格 sha256
 *   （缺失/格式坏 ⇒ fail-closed，不把无 source binding 的加载当作可用证据）。
 */
/** compiled 选中项：evidence 已严格解码 + 通过快照身份/sourceHash 校验。 */
export interface CompiledSelection extends AttributableSelection {
  evidence: CompiledExecutionEvidence;
}

/**
 * 用快照过滤出本次 run 可归因的 compiled 选中项（与 load 路径同规则，fail-closed）：
 * 1. outcome 必须 ok 且 evidence 已保存；2. skillId ∈ 当次候选快照；
 * 3. revision 精确匹配；4. details.source_hash 必须存在且严格 sha256。
 */
export function selectCompiledSelections(
  run: RunCollector,
  snapshot: RouteSnapshot,
): CompiledSelection[] {
  const bySkillId = new Map<string, RouteSnapshotSkill>();
  for (const skill of snapshot.candidateSkills) bySkillId.set(skill.skillId, skill);
  const seen = new Set<string>();
  const selected: CompiledSelection[] = [];
  for (const evidence of run.compiledEvidenceByCallId.values()) {
    if (evidence.outcome !== "ok" || evidence.evidence === undefined || evidence.skillId === undefined) {
      continue;
    }
    if (seen.has(evidence.skillId)) continue;
    const snapshotSkill = bySkillId.get(evidence.skillId);
    if (snapshotSkill === undefined) continue; // 不在当次候选快照 ⇒ 不可归因
    if (evidence.skillRevision !== snapshotSkill.skillRevision) continue; // 版本失配
    const sourceHash = extractSourceHash(evidence.details);
    if (sourceHash === undefined) continue; // 缺 source_hash ⇒ fail-closed
    seen.add(evidence.skillId);
    selected.push({
      skillId: evidence.skillId,
      skillRevision: snapshotSkill.skillRevision,
      sourceHash,
      evidence: evidence.evidence,
    });
  }
  return selected;
}

export function selectAttributableSkills(
  run: RunCollector,
  snapshot: RouteSnapshot,
  verifyLoadResult: (details: unknown, snapshot: RouteSnapshotSkill) => boolean,
): AttributableSelection[] {
  const bySkillId = new Map<string, RouteSnapshotSkill>();
  for (const skill of snapshot.candidateSkills) {
    bySkillId.set(skill.skillId, skill);
  }
  const seen = new Set<string>();
  const selected: AttributableSelection[] = [];
  for (const evidence of run.loadEvidenceByCallId.values()) {
    if (evidence.outcome !== "ok" || evidence.skillId === undefined) continue;
    if (seen.has(evidence.skillId)) continue;
    const snapshotSkill = bySkillId.get(evidence.skillId);
    if (snapshotSkill === undefined) continue; // 不在当次候选快照 ⇒ 不可归因
    if (evidence.skillRevision !== snapshotSkill.skillRevision) continue; // 版本失配
    if (!verifyLoadResult(evidence.details, snapshotSkill)) continue;
    const sourceHash = extractSourceHash(evidence.details);
    if (sourceHash === undefined) continue; // 缺 source_hash ⇒ fail-closed
    seen.add(evidence.skillId);
    selected.push({ ...snapshotSkill, sourceHash });
  }
  return selected;
}

/**
 * 注册 Practice observer。
 *
 * - before_agent_start：仅派生 task hash 并建立 run 采集器（不摄入、不重算候选）；
 * - tool_call/tool_result：聚合 load_skill 与工具步骤（脱敏）；
 * - agent_settled：用 before_agent_start 已绑定到 run 的快照校验选中并落盘；未接线
 *   （snapshot undefined）⇒ fail-closed（onStatus 报告 unwired，不产生事件）。
 *
 * 任何 handler 异常不向上抛出（不阻断主 Agent），只交给 onError。
 */
export function registerPracticeObserver(
  pi: ExtensionAPI,
  options: PracticeObserverOptions,
): void {
  const projectRoot = path.resolve(options.projectRoot);
  const tenantScope = options.tenantScope ?? defaultTenantScope(projectRoot);
  const now = options.now ?? (() => new Date());
  const onError = options.onError;
  const onEvent = options.onEvent;
  const onStatus = options.onStatus;
  const verifyLoadResult = options.verifyLoadResult ?? defaultVerifyLoadResult;
  const evidenceHook = options.evidenceHook;
  const runSeqBySession = new Map<string, number>();
  const currentRunBySession = new Map<string, RunCollector>();

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
    try {
      const sessionId = getSessionId(ctx);
      if (sessionId === undefined) return; // 无 session 关联 ⇒ 不采集（fail-closed）
      if ((await options.learningEnabled?.()) === false) {
        currentRunBySession.delete(sessionId);
        options.routeSnapshotSource?.clear();
        onStatus?.({ wired: true, reason: "learning_paused", appendedEvents: 0 });
        return;
      }
      const seq = (runSeqBySession.get(sessionId) ?? 0) + 1;
      runSeqBySession.set(sessionId, seq);
      const runKey = `${sessionId}:${seq}`;

      // 一次性消费当前 pending 快照并绑定到本次 run（cortex handler 成功 inject 后
      // 才 push；observer 后续执行 take）。无快照/exposedToAgent=false ⇒ 记录原因，
      // finalize 时 fail-closed，不把旧快照串到本轮。
      let snapshot: RouteSnapshot | undefined;
      let snapshotRejectReason: ObserverStatus["reason"] | undefined;
      const source = options.routeSnapshotSource;
      if (source === undefined) {
        snapshotRejectReason = "no_route_snapshot_source";
      } else {
        const pending = source.takeRouteSnapshot();
        if (pending === undefined) {
          snapshotRejectReason = "no_route_snapshot";
        } else if (pending.exposedToAgent !== true) {
          snapshotRejectReason = "not_exposed_to_agent";
        } else {
          snapshot = pending;
        }
      }

      const run = new RunCollector({
        runKey,
        sessionId,
        startedAt: now().toISOString(),
        tenantScope,
        taskHash: sha256HexOf(event.prompt).slice(0, 32),
        // prompt 仅内存持有（evidenceHook 输入），落盘只写派生 hash 与结构化结果。
        prompt: event.prompt,
        snapshot,
        snapshotRejectReason,
        compiledTool: options.compiledTool,
      });
      currentRunBySession.set(sessionId, run);
    } catch (error) {
      onError?.(error, "ingest");
    }
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    try {
      const sessionId = getSessionId(ctx);
      if (sessionId === undefined) return;
      currentRunBySession.get(sessionId)?.onToolCall(event);
    } catch (error) {
      onError?.(error, "capture");
    }
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    try {
      const sessionId = getSessionId(ctx);
      if (sessionId === undefined) return;
      currentRunBySession.get(sessionId)?.onToolResult(event);
    } catch (error) {
      onError?.(error, "capture");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const sessionId = getSessionId(ctx);
    if (sessionId === undefined) return;
    const run = currentRunBySession.get(sessionId);
    if (run === undefined) return;
    currentRunBySession.delete(sessionId);
    try {
      // settled 后清空 pending，防止旧快照残留串到下一轮（下一轮 cortex 会重新 push）。
      options.routeSnapshotSource?.clear();

      if ((await options.learningEnabled?.()) === false) {
        onStatus?.({ wired: true, reason: "learning_paused", appendedEvents: 0 });
        return;
      }

      const snapshot = run.snapshot;
      if (snapshot === undefined) {
        onStatus?.({
          wired: false,
          reason: run.snapshotRejectReason ?? "no_route_snapshot",
          appendedEvents: 0,
        });
        return; // 无快照/未暴露 ⇒ 不产生事件
      }

      const selected = selectAttributableSkills(run, snapshot, verifyLoadResult);
      const compiled = selectCompiledSelections(run, snapshot);
      // compiled 对同 skill 优先：被 compiled 覆盖的 load 选中不重复生成事件。
      const compiledBySkill = new Map(compiled.map((s) => [s.skillId, s] as const));
      const loadOnly = selected.filter((s) => !compiledBySkill.has(s.skillId));
      const routeDecisionId = deriveRouteDecisionId(run.runKey);
      if (snapshot.exposure !== undefined && options.onExposure !== undefined) {
        try {
          await options.onExposure({
            schemaVersion: 1,
            routeDecisionId,
            tenantScope: run.tenantScope,
            observedAt: run.startedAt,
            ...snapshot.exposure,
            selectedSkillIds: [...new Set([...compiled, ...loadOnly].map((item) => item.skillId))].sort(),
            ...(snapshot.candidateBudget !== undefined ? { candidateBudget: snapshot.candidateBudget } : {}),
            ...(snapshot.cardProjection !== undefined ? { cardProjection: snapshot.cardProjection } : {}),
          });
        } catch (error) {
          // Exposure telemetry 与 Practice evidence 是独立 seam；记录失败可见，但不吞掉合法 evidence。
          onError?.(error, "finalize");
        }
      }
      if (compiled.length === 0 && loadOnly.length === 0) {
        onStatus?.({ wired: true, reason: "ok", appendedEvents: 0 });
        return; // 无选中证据 ⇒ 不产生事件
      }

      const totalSelected = compiled.length + loadOnly.length;
      let appended = 0;
      for (const selection of compiled) {
        const event = buildPracticeEvent(run, selection, {
          now,
          routeDecisionId,
          candidateSkillIds: snapshot.candidateSkills.map((s) => s.skillId),
          candidateCount: snapshot.candidateSkills.length,
          selectedCount: totalSelected,
          compiledEvidence: selection.evidence,
        });
        await options.store.append(event);
        appended += 1;
        onEvent?.(event);
      }
      for (const selection of loadOnly) {
        // 通用证据钩子：注入额外步骤/verifier（B4+）；返回 undefined 则不注入。
        // 钩子抛错 ⇒ fail-closed：该事件不落盘，走 onError(finalize)。
        let hookEvidence: HookEvidence | undefined;
        if (evidenceHook !== undefined) {
          hookEvidence = await evidenceHook.collect(run, selection);
        }
        const event = buildPracticeEvent(run, selection, {
          now,
          routeDecisionId,
          candidateSkillIds: snapshot.candidateSkills.map((s) => s.skillId),
          candidateCount: snapshot.candidateSkills.length,
          selectedCount: totalSelected,
          hookEvidence,
        });
        await options.store.append(event);
        appended += 1;
        onEvent?.(event);
      }
      onStatus?.({ wired: true, reason: "ok", appendedEvents: appended });
    } catch (error) {
      onError?.(error, "finalize");
    }
  });
}
