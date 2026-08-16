/**
 * Phase 5 host pipeline —— procedure 生命周期 store（project-local）。
 *
 * 职责（数据合同 §3/§6 + 实施计划 §10）：
 * - 持久化 CompiledProcedure 当前状态（按 procedureId）+ 修订历史（按 procedureRevision，
 *   供 rollback 的 stableLookup 查上一稳定版）+ 可审计事件日志（transition event：
 *   from/to status、reason、reportId 引用、时间戳、触发来源），不丢历史；
 * - 查询：getProcedure / getByRevision / listByStatus / listByEvidenceId（供 cascade 查找）
 *   / listCurrent（供 diff current 查找） / listEvents（审计）；
 * - 写操作：save（首次）/ transition（状态机推进，非法转换拒绝落盘）/ remove（级联删除，
 *   事件历史随同清理）。store 不内嵌 transition 纯函数逻辑——纯函数（draft.ts）返回新对象，
 *   调用方经 transition 落盘；store 只持久化 + 校验 from→to 边合法性（fail-closed）。
 *
 * 安全约束（仿 PracticeStore）：
 * - project-local 强制：rootDir 必须位于 projectRoot 内，词法 + realpath 双校验；
 * - tenantScope 目录名用稳定 SHA-256（防 path traversal），不拼接原始字符串；
 * - procedureId/procedureRevision 含冒号，文件名用 SHA-256 前缀，body 存完整值，
 *   读取校验 body 与文件名 hash 一致（fail-closed）；
 * - 持久化显式白名单复制（CompiledProcedure 合同字段全集，不 spread 未知键）；
 * - 读取 fail-closed：JSON.parse / 字段类型 / 状态枚举 / id 一致性逐一校验，损坏抛固定
 *   错误码（不含原始内容/路径）；不落 SKILL.md 正文/路径/未脱敏工具输出（procedure 只含
 *   派生字段与条款引用，事件只含受控 reason/trigger）。
 *
 * 边界：不实现 transition 纯函数（draft.ts）；不接 host 事件（下一 slice）；不写用户环境。
 *
 * crash consistency（记录，real-host deployment 前 blocker / tech debt）：
 * transition 的 current 覆盖写入与 event append 之间无原子性——进程中途崩溃可能留下
 * “current 已更新但事件未追加”（或反之）的不一致状态。本 slice 不做 WAL/事务（最小修复
 * 控制 scope）；真实宿主部署前必须引入原子提交（如事件先写、current 以 rename 替换，
 * 或 WAL），届时再处理回放/修复。
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CompiledProcedure } from "../../core/contracts/index.ts";

export const PROCEDURE_SCHEMA_VERSION = 1;
export const PROCEDURE_STORE_DIRNAME = ".skill-cortex/procedures";

/** 事件触发来源（数据合同事件 actor 枚举：agent/procedure/tool/user）。 */
export type TriggerSource = "agent" | "procedure" | "tool" | "user";

/** 状态机合法边（Phase 5 slice 1/2 冻结：draft→validated→canary→active⇄suspended；active/suspended→retired；validated/canary→suspended）。 */
const LEGAL_TRANSITIONS: Readonly<Record<CompiledProcedure["status"], readonly CompiledProcedure["status"][]>> = {
  draft: ["validated"],
  validated: ["canary", "suspended"],
  canary: ["active", "suspended"],
  active: ["suspended", "retired"],
  suspended: ["active", "retired"],
  retired: [],
};

const PROCEDURE_STATUSES: readonly CompiledProcedure["status"][] = [
  "draft",
  "validated",
  "canary",
  "active",
  "suspended",
  "retired",
];

/** 事件日志 toStatus 扩展：物理删除（终态之外的特殊审计值）。 */
export type EventToStatus = CompiledProcedure["status"] | "deleted";

/**
 * revision 的 release/lifecycle state（HIGH 2）：记录某 procedureRevision 实际到达过的
 * 发布状态（非 immutable artifact 内容）。rollback 的 stable lookup 只认此记录。
 * - 与 immutable artifact snapshot（history）分离：history 不覆盖，release 可更新；
 * - suspended 时带 suspendedFrom（自动派生，曾发布为 active 才可作 stable 目标）与
 *   suspendKind（drift/cascade 需重验，rollback 的 requires_revalidation 门依赖）。
 */
export interface ReleaseStateRecord {
  schemaVersion: typeof PROCEDURE_SCHEMA_VERSION;
  procedureId: string;
  procedureRevision: string;
  status: CompiledProcedure["status"];
  /** 到达该 release 状态时的报告引用（validated→validationReportId；canary→canaryReportId；active→activeReportId）。 */
  reportId?: string;
  suspendedFrom?: "validated" | "canary" | "active";
  suspendKind?: "manual" | "dependency_drift" | "evidence_cascade";
  lifecycleReason?: string;
  updatedAt: string;
}

/** 可审计 transition 事件（append-only；不丢历史）。 */
export interface ProcedureTransitionEvent {
  schemaVersion: typeof PROCEDURE_SCHEMA_VERSION;
  eventId: string;
  /** 事件序号（procedure 内递增；审计顺序标识）。 */
  seq: number;
  procedureId: string;
  procedureRevision: string;
  /** 事件后状态对应的 procedureRevision；undefined = 首次写入。 */
  fromStatus: CompiledProcedure["status"] | undefined;
  toStatus: EventToStatus;
  /** lifecycleReason（suspended/retired/删除）；其余状态省略。 */
  reason?: string;
  /** 晋升/验证报告引用（validated→validationReportId；canary→canaryReportId；active→activeReportId）。 */
  reportId?: string;
  trigger: TriggerSource;
  occurredAt: string;
}

export interface ProcedureStoreOptions {
  /** store 根目录（project-local，如 <project>/.skill-cortex/procedures）。 */
  rootDir: string;
  /** 项目根（project-local 强制基准）：默认 process.cwd()。 */
  projectRoot?: string;
  /** tenantScope（默认 "project:" + 规范化 projectRoot 的 SHA-256 前 32，防路径泄漏）。 */
  tenantScope?: string;
  now?: () => Date;
}

export interface TransitionMeta {
  trigger: TriggerSource;
}

function hash(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

function tenantHashOf(tenantScope: string): string {
  return hash(tenantScope, 32);
}

function procedureIdFileHash(procedureId: string): string {
  return hash(procedureId, 40);
}

function revisionFileHash(procedureRevision: string): string {
  return hash(procedureRevision, 40);
}

function isErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as NodeJS.ErrnoException).code === code;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function corrupt(code: string): never {
  throw new Error(`procedure_store_corrupt: ${code}`);
}

function assertValidStatus(value: unknown): asserts value is CompiledProcedure["status"] {
  if (typeof value !== "string" || !(PROCEDURE_STATUSES as readonly string[]).includes(value)) {
    corrupt("invalid_status");
  }
}

/** 持久化白名单复制（CompiledProcedure 合同字段全集；不 spread 未知键，防类型外字段落盘）。 */
function toStoredProcedure(procedure: CompiledProcedure): CompiledProcedure {
  return {
    schemaVersion: procedure.schemaVersion,
    procedureId: procedure.procedureId,
    parentSkillId: procedure.parentSkillId,
    parentSkillRevision: procedure.parentSkillRevision,
    procedureRevision: procedure.procedureRevision,
    status: procedure.status,
    dependencyFingerprint: { ...procedure.dependencyFingerprint },
    inputSchema: procedure.inputSchema as CompiledProcedure["inputSchema"],
    preconditions: procedure.preconditions.map((p) => ({ ...p })),
    coveredSteps: procedure.coveredSteps.map((s) => ({ ...s })),
    forbiddenAutomationSteps: [...procedure.forbiddenAutomationSteps],
    runtimeGuards: procedure.runtimeGuards.map((g) => ({ ...g })),
    llmHoles: procedure.llmHoles.map((h) => ({ ...h })),
    declaredEffects: [...procedure.declaredEffects],
    requiredPermissions: [...procedure.requiredPermissions],
    postconditions: procedure.postconditions.map((p) => ({ ...p })),
    artifactLocator: procedure.artifactLocator,
    artifactHash: procedure.artifactHash,
    evidenceIds: [...procedure.evidenceIds],
    validationReportId: procedure.validationReportId,
    createdAt: procedure.createdAt,
    ...(procedure.canaryReportId !== undefined ? { canaryReportId: procedure.canaryReportId } : {}),
    ...(procedure.activeReportId !== undefined ? { activeReportId: procedure.activeReportId } : {}),
    ...(procedure.lifecycleReason !== undefined ? { lifecycleReason: procedure.lifecycleReason } : {}),
    ...(procedure.suspendedFrom !== undefined ? { suspendedFrom: procedure.suspendedFrom } : {}),
    ...(procedure.suspendKind !== undefined ? { suspendKind: procedure.suspendKind } : {}),
    ...(procedure.previousStableRevision !== undefined
      ? { previousStableRevision: procedure.previousStableRevision }
      : {}),
    ...(procedure.suspendedFrom !== undefined ? { suspendedFrom: procedure.suspendedFrom } : {}),
    ...(procedure.suspendKind !== undefined ? { suspendKind: procedure.suspendKind } : {}),
  };
}

/** 读取 fail-closed：必填字段 + 状态枚举 + 文件名 hash 一致性。 */
function parseStoredProcedure(raw: unknown, expectedProcedureIdHash: string): CompiledProcedure {
  if (typeof raw !== "object" || raw === null) corrupt("not_object");
  const procedure = raw as Record<string, unknown>;
  if (procedure.schemaVersion !== PROCEDURE_SCHEMA_VERSION) corrupt("schema_version");
  if (typeof procedure.procedureId !== "string" || procedure.procedureId === "") corrupt("procedure_id");
  if (procedureIdFileHash(procedure.procedureId) !== expectedProcedureIdHash) corrupt("procedure_id_mismatch");
  if (typeof procedure.parentSkillId !== "string" || procedure.parentSkillId === "") corrupt("parent_skill_id");
  if (typeof procedure.parentSkillRevision !== "string" || procedure.parentSkillRevision === "") corrupt("parent_skill_revision");
  if (typeof procedure.procedureRevision !== "string" || procedure.procedureRevision === "") corrupt("procedure_revision");
  assertValidStatus(procedure.status);
  if (typeof procedure.artifactHash !== "string" || procedure.artifactHash === "") corrupt("artifact_hash");
  if (!Array.isArray(procedure.evidenceIds)) corrupt("evidence_ids");
  return procedure as unknown as CompiledProcedure;
}

function parseStoredEvent(raw: unknown, expectedProcedureIdHash: string, expectedSeq: number): ProcedureTransitionEvent {
  if (typeof raw !== "object" || raw === null) corrupt("event_not_object");
  const event = raw as Record<string, unknown>;
  if (event.schemaVersion !== PROCEDURE_SCHEMA_VERSION) corrupt("event_schema_version");
  if (typeof event.procedureId !== "string" || procedureIdFileHash(event.procedureId) !== expectedProcedureIdHash) {
    corrupt("event_procedure_id_mismatch");
  }
  if (typeof event.eventId !== "string" || event.eventId === "") corrupt("event_id");
  if (event.fromStatus !== undefined) assertValidStatus(event.fromStatus);
  if (event.toStatus !== "deleted") assertValidStatus(event.toStatus);
  if (event.trigger !== "agent" && event.trigger !== "procedure" && event.trigger !== "tool" && event.trigger !== "user") {
    corrupt("event_trigger");
  }
  if (typeof event.occurredAt !== "string" || event.occurredAt === "") corrupt("event_occurred_at");
  if (typeof event.procedureRevision !== "string" || event.procedureRevision === "") corrupt("event_procedure_revision");
  if (typeof event.seq !== "number" || event.seq !== expectedSeq) corrupt("event_seq_mismatch");
  return event as unknown as ProcedureTransitionEvent;
}

/** 从 next 对象提取受控审计元数据（reportId 引用 + lifecycleReason）。 */
function auditMetaOf(next: CompiledProcedure): { reportId?: string; reason?: string } {
  if (next.status === "validated" && next.validationReportId !== "pending:phase3-pagination-validation") {
    return { reportId: next.validationReportId };
  }
  if (next.status === "canary" && next.canaryReportId !== undefined) {
    return { reportId: next.canaryReportId };
  }
  if (next.status === "active" && next.activeReportId !== undefined) {
    return { reportId: next.activeReportId };
  }
  if (next.lifecycleReason !== undefined) {
    return { reason: next.lifecycleReason };
  }
  return {};
}

/** 默认 tenantScope：project 前缀 + 规范化 projectRoot 的 SHA-256 前 32 hex（不含原始路径）。 */
export function defaultTenantScope(projectRoot: string): string {
  const normalized = path
    .resolve(projectRoot)
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("\\", "/");
  return `project:${hash(normalized, 32)}`;
}

export class ProcedureStore {
  readonly rootDir: string;
  readonly projectRoot: string;
  readonly tenantScope: string;
  #initialized = false;

  constructor(options: ProcedureStoreOptions) {
    const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    const rootDir = path.resolve(options.rootDir);
    if (!isPathInside(projectRoot, rootDir)) {
      throw new Error("procedure_store_root_must_be_inside_project_root");
    }
    this.projectRoot = projectRoot;
    this.rootDir = rootDir;
    this.tenantScope = options.tenantScope ?? defaultTenantScope(projectRoot);
    this.#now = options.now ?? (() => new Date());
  }

  /** tenant 分区目录（rootDir/<tenantHash>；只读路径，审计/测试用）。 */
  get tenantDir(): string {
    return this.#tenantDir();
  }

  #now: () => Date;

  async #ensureInit(): Promise<void> {
    if (this.#initialized) return;
    // realpath 校验：rootDir 不得经 symlink/junction 逃逸出 projectRoot。
    const realRoot = await realpath(this.projectRoot);
    const realStore = await realpath(this.rootDir).catch(() => undefined);
    if (realStore !== undefined && !isPathInside(realRoot, realStore)) {
      throw new Error("procedure_store_root_must_be_inside_project_root");
    }
    await mkdir(this.rootDir, { recursive: true });
    this.#initialized = true;
  }

  #tenantDir(): string {
    return path.join(this.rootDir, tenantHashOf(this.tenantScope));
  }

  #currentDir(): string {
    return path.join(this.#tenantDir(), "current");
  }

  #historyDir(procedureId: string): string {
    return path.join(this.#tenantDir(), "history", procedureIdFileHash(procedureId));
  }

  #eventsDir(procedureId: string): string {
    return path.join(this.#tenantDir(), "events", procedureIdFileHash(procedureId));
  }

  #releaseDir(procedureId: string): string {
    return path.join(this.#tenantDir(), "release", procedureIdFileHash(procedureId));
  }

  #releasePath(procedureId: string, procedureRevision: string): string {
    return path.join(this.#releaseDir(procedureId), `${revisionFileHash(procedureRevision)}.json`);
  }

  #currentPath(procedureId: string): string {
    return path.join(this.#currentDir(), `${procedureIdFileHash(procedureId)}.json`);
  }

  #historyPath(procedureId: string, procedureRevision: string): string {
    return path.join(this.#historyDir(procedureId), `${revisionFileHash(procedureRevision)}.json`);
  }

  #eventPath(procedureId: string, seq: number): string {
    return path.join(this.#eventsDir(procedureId), `${String(seq).padStart(6, "0")}.json`);
  }

  async #nextEventSeq(procedureId: string): Promise<number> {
    const dir = this.#eventsDir(procedureId);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return 1;
      throw error;
    }
    let max = 0;
    for (const name of names) {
      const seq = Number(name.replace(/\.json$/u, ""));
      if (Number.isFinite(seq) && seq > max) max = seq;
    }
    return max + 1;
  }

  /** 断言 from→to 是状态机合法边（fail-closed：非法转换拒绝落盘）。 */
  #assertLegalTransition(from: CompiledProcedure["status"], to: CompiledProcedure["status"]): void {
    if (!(LEGAL_TRANSITIONS[from] as readonly string[]).includes(to)) {
      throw new Error(
        `procedure_store_illegal_transition: ${from} -> ${to}`,
      );
    }
  }

  async #writeProcedureFile(
    filePath: string,
    procedure: CompiledProcedure,
    options: { exclusive: boolean },
  ): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const body = JSON.stringify(toStoredProcedure(procedure));
    if (options.exclusive) {
      await writeFile(filePath, body, { encoding: "utf8", flag: "wx" });
    } else {
      await writeFile(filePath, body, { encoding: "utf8", flag: "w" });
    }
  }

  /** 从 transition/save 后的 procedure 提取 release 状态记录（覆盖写：该 revision 的当前 release 状态）。 */
  async #writeReleaseState(procedure: CompiledProcedure): Promise<void> {
    const reportId = auditMetaOf(procedure).reportId;
    const record: ReleaseStateRecord = {
      schemaVersion: PROCEDURE_SCHEMA_VERSION,
      procedureId: procedure.procedureId,
      procedureRevision: procedure.procedureRevision,
      status: procedure.status,
      ...(reportId !== undefined ? { reportId } : {}),
      ...(procedure.suspendedFrom !== undefined ? { suspendedFrom: procedure.suspendedFrom } : {}),
      ...(procedure.suspendKind !== undefined ? { suspendKind: procedure.suspendKind } : {}),
      ...(procedure.lifecycleReason !== undefined ? { lifecycleReason: procedure.lifecycleReason } : {}),
      updatedAt: this.#now().toISOString(),
    };
    const filePath = this.#releasePath(procedure.procedureId, procedure.procedureRevision);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(record), { encoding: "utf8", flag: "w" });
  }

  async #findReleaseByRevision(procedureRevision: string): Promise<ReleaseStateRecord | undefined> {
    const revisionHash = revisionFileHash(procedureRevision);
    const releaseRoot = path.join(this.#tenantDir(), "release");
    let procedureDirs: string[] = [];
    try {
      procedureDirs = await readdir(releaseRoot);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    }
    for (const dir of procedureDirs) {
      const filePath = path.join(releaseRoot, dir, `${revisionHash}.json`);
      const raw = await readFile(filePath, "utf8").catch((error: unknown) => {
        if (isErrnoCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (raw === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        corrupt("json_parse");
      }
      const record = parsed as Record<string, unknown>;
      if (record.schemaVersion !== PROCEDURE_SCHEMA_VERSION) corrupt("release_schema_version");
      if (typeof record.procedureRevision !== "string") corrupt("release_procedure_revision");
      if (record.procedureRevision !== procedureRevision) continue;
      assertValidStatus(record.status);
      if (typeof record.procedureId !== "string") corrupt("release_procedure_id");
      return record as unknown as ReleaseStateRecord;
    }
    return undefined;
  }

  async #findHistorySnapshot(procedureId: string, procedureRevision: string): Promise<CompiledProcedure | undefined> {
    const filePath = this.#historyPath(procedureId, procedureRevision);
    const raw = await readFile(filePath, "utf8").catch((error: unknown) => {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      corrupt("json_parse");
    }
    return parseStoredProcedure(parsed, procedureIdFileHash(procedureId));
  }

  /** 从 immutable artifact 快照 + release 记录合成 stable 候选（content 取 history，状态取 release）。 */
  async #composeStableCandidate(release: ReleaseStateRecord): Promise<CompiledProcedure | undefined> {
    const snapshot = await this.#findHistorySnapshot(release.procedureId, release.procedureRevision);
    if (snapshot === undefined) return undefined; // release 存在但 artifact 快照缺失 ⇒ fail-closed
    return {
      ...snapshot,
      status: release.status,
      ...(release.status === "validated" && release.reportId !== undefined
        ? { validationReportId: release.reportId }
        : {}),
      ...(release.status === "canary" && release.reportId !== undefined
        ? { canaryReportId: release.reportId }
        : {}),
      ...(release.status === "active" && release.reportId !== undefined
        ? { activeReportId: release.reportId }
        : {}),
      ...(release.suspendedFrom !== undefined ? { suspendedFrom: release.suspendedFrom } : {}),
      ...(release.suspendKind !== undefined ? { suspendKind: release.suspendKind } : {}),
      ...(release.lifecycleReason !== undefined ? { lifecycleReason: release.lifecycleReason } : {}),
    } as CompiledProcedure;
  }

  async #appendEvent(
    procedureId: string,
    procedureRevision: string,
    fromStatus: CompiledProcedure["status"] | undefined,
    toStatus: EventToStatus,
    trigger: TriggerSource,
    meta: { reason?: string; reportId?: string },
  ): Promise<void> {
    const seq = await this.#nextEventSeq(procedureId);
    const event: ProcedureTransitionEvent = {
      schemaVersion: PROCEDURE_SCHEMA_VERSION,
      eventId: `evt-${hash(`${procedureId}\u0000${seq}`, 40)}`,
      procedureId,
      procedureRevision,
      fromStatus,
      toStatus,
      ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
      ...(meta.reportId !== undefined ? { reportId: meta.reportId } : {}),
      trigger,
      occurredAt: this.#now().toISOString(),
      seq,
    };
    const filePath = this.#eventPath(procedureId, seq);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(event), { encoding: "utf8", flag: "wx" });
  }

  /**
   * 首次写入（导入/构建落盘）。prior 已存在 ⇒ 拒绝（不覆盖当前状态；更新走 transition）。
   * 写 current（wx）+ history（wx，按 procedureRevision）+ release 状态 + 首条事件（fromStatus=undefined）。
   */
  async save(procedure: CompiledProcedure, meta: TransitionMeta): Promise<void> {
    await this.#ensureInit();
    assertValidStatus(procedure.status);
    if (procedure.procedureId === "" || procedure.procedureRevision === "") {
      throw new Error("procedure_store_invalid_identity");
    }
    const currentPath = this.#currentPath(procedure.procedureId);
    if (await this.#fileExists(currentPath)) {
      throw new Error("procedure_store_already_exists");
    }
    await this.#writeProcedureFile(currentPath, procedure, { exclusive: true });
    await this.#writeProcedureFile(
      this.#historyPath(procedure.procedureId, procedure.procedureRevision),
      procedure,
      { exclusive: true },
    );
    await this.#writeReleaseState(procedure);
    const meta_ = auditMetaOf(procedure);
    await this.#appendEvent(
      procedure.procedureId,
      procedure.procedureRevision,
      undefined,
      procedure.status,
      meta.trigger,
      meta_,
    );
  }

  /**
   * 状态机推进：prior → next。校验（fail-closed，HIGH 1：不信任调用者传入的 prior）：
   * - next.procedureId 必须与 prior 一致；
   * - prior.status → next.status 必须 ∈ 合法边（非法转换拒绝落盘）；
   * - 读取 store 当前落盘 stored：stored.procedureId / procedureRevision / status 必须
   *   与 prior 完全一致——stale/伪造 prior（旧 status、错 revision）一律拒绝，且
   *   不得修改 current/history/release/events；
   * - next 写 current（覆盖当前状态）；procedureRevision 变化 ⇒ 追加 history + release；
   *   events append-only（不丢历史）。
   */
  async transition(
    prior: CompiledProcedure,
    next: CompiledProcedure,
    meta: TransitionMeta,
  ): Promise<void> {
    await this.#ensureInit();
    assertValidStatus(prior.status);
    assertValidStatus(next.status);
    if (prior.procedureId !== next.procedureId) {
      throw new Error("procedure_store_transition_procedure_id_mismatch");
    }
    this.#assertLegalTransition(prior.status, next.status);
    // HIGH 1：读取真实落盘状态，校验 prior 一致（stale/伪造 prior 拒绝）。
    const stored = await this.getProcedure(prior.procedureId);
    if (stored === undefined) {
      throw new Error("procedure_store_missing_prior");
    }
    if (
      stored.procedureId !== prior.procedureId ||
      stored.procedureRevision !== prior.procedureRevision ||
      stored.status !== prior.status
    ) {
      throw new Error("procedure_store_stale_prior");
    }
    const currentPath = this.#currentPath(next.procedureId);
    await this.#writeProcedureFile(currentPath, next, { exclusive: false });
    if (next.procedureRevision !== prior.procedureRevision) {
      await this.#writeProcedureFile(
        this.#historyPath(next.procedureId, next.procedureRevision),
        next,
        { exclusive: true },
      );
    }
    await this.#writeReleaseState(next);
    const meta_ = auditMetaOf(next);
    await this.#appendEvent(
      next.procedureId,
      next.procedureRevision,
      prior.status,
      next.status,
      meta.trigger,
      meta_,
    );
  }

  /**
   * 级联删除入口：prior 存在 ⇒ 先写删除事件（审计先于清理，toStatus="deleted"）→
   * 再删 current/history/release/events 目录（事件历史随同清理）。prior 不存在 ⇒ 幂等（0 操作）。
   */
  async remove(procedureId: string, meta: TransitionMeta): Promise<void> {
    await this.#ensureInit();
    const currentPath = this.#currentPath(procedureId);
    const prior = await this.getProcedure(procedureId);
    if (prior === undefined) return; // 幂等：不存在无操作
    const reason = prior.lifecycleReason;
    await this.#appendEvent(
      prior.procedureId,
      prior.procedureRevision,
      prior.status,
      "deleted",
      meta.trigger,
      { reason },
    );
    await rm(currentPath, { force: true });
    await rm(this.#historyDir(procedureId), { recursive: true, force: true });
    await rm(this.#releaseDir(procedureId), { recursive: true, force: true });
    await rm(this.#eventsDir(procedureId), { recursive: true, force: true });
  }

  async #fileExists(filePath: string): Promise<boolean> {
    try {
      const stat = await lstat(filePath);
      return stat.isFile();
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  /** 当前状态（按 procedureId）；不存在 ⇒ undefined。 */
  async getProcedure(procedureId: string): Promise<CompiledProcedure | undefined> {
    await this.#ensureInit();
    const filePath = this.#currentPath(procedureId);
    const raw = await readFile(filePath, "utf8").catch((error: unknown) => {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      corrupt("json_parse");
    }
    return parseStoredProcedure(parsed, procedureIdFileHash(procedureId));
  }

  /** 按 procedureRevision 查修订历史（rollback stableLookup 注入用）；未找到 ⇒ undefined。 */
  async getByRevision(procedureRevision: string): Promise<CompiledProcedure | undefined> {
    await this.#ensureInit();
    const revisionHash = revisionFileHash(procedureRevision);
    const historyRoot = path.join(this.#tenantDir(), "history");
    let procedureDirs: string[] = [];
    try {
      procedureDirs = await readdir(historyRoot);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    }
    for (const dir of procedureDirs) {
      const filePath = path.join(historyRoot, dir, `${revisionHash}.json`);
      const raw = await readFile(filePath, "utf8").catch((error: unknown) => {
        if (isErrnoCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (raw === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        corrupt("json_parse");
      }
      const procedure = parseStoredProcedure(parsed, dir);
      if (procedure.procedureRevision === procedureRevision) return procedure;
    }
    return undefined;
  }

  /**
   * rollback stable lookup seam（HIGH 2）：只返回该 procedureRevision 已真实到达合法
   * stable 发布状态的记录——active，或 suspended 且 suspendedFrom="active"（曾发布为
   * active；drift/cascade 的 revalidation 资格由 rollbackProcedure 的 suspendKind 门另判）。
   * 从未 active 的 draft/validated/canary（含 suspendedFrom≠active）与 retired revision
   * ⇒ undefined（不可作 stable 目标）。
   * 返回对象 = immutable artifact 快照（history 内容）+ release 状态（status/reportId/
   * suspendedFrom/suspendKind/lifecycleReason），供 rollbackProcedure 的既有
   * revision/procedureId/parentSkillId lineage 校验与稳定状态判定直接消费。
   */
  async getStableByRevision(procedureRevision: string): Promise<CompiledProcedure | undefined> {
    await this.#ensureInit();
    const release = await this.#findReleaseByRevision(procedureRevision);
    if (release === undefined) return undefined;
    if (release.status === "active") return this.#composeStableCandidate(release);
    if (release.status === "suspended" && release.suspendedFrom === "active") {
      return this.#composeStableCandidate(release);
    }
    return undefined;
  }

  async #listCurrentRaw(): Promise<Array<{ procedureId: string; parsed: CompiledProcedure }>> {
    await this.#ensureInit();
    const dir = this.#currentDir();
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return [];
      throw error;
    }
    const results: Array<{ procedureId: string; parsed: CompiledProcedure }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(dir, name);
      const stat = await lstat(filePath).catch((error: unknown) => {
        if (isErrnoCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (stat === undefined || !stat.isFile()) continue; // 目录/链接继续忽略（仿 PracticeStore）
      const raw = await readFile(filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        corrupt("json_parse");
      }
      results.push({
        procedureId: (parsed as { procedureId?: unknown }).procedureId as string,
        parsed: parseStoredProcedure(parsed, name.slice(0, -".json".length)),
      });
    }
    return results;
  }

  /** 全部当前 procedure（供 diff/cascade 依赖查找注入）。 */
  async listCurrent(): Promise<CompiledProcedure[]> {
    const results = await this.#listCurrentRaw();
    return results.map((r) => r.parsed);
  }

  /** 按状态过滤当前 procedure。 */
  async listByStatus(status: CompiledProcedure["status"]): Promise<CompiledProcedure[]> {
    assertValidStatus(status);
    const results = await this.#listCurrentRaw();
    return results.filter((r) => r.parsed.status === status).map((r) => r.parsed);
  }

  /** 按 evidenceId 过滤当前 procedure（cascade 查找注入用）。 */
  async listByEvidenceId(evidenceId: string): Promise<CompiledProcedure[]> {
    const results = await this.#listCurrentRaw();
    return results.filter((r) => r.parsed.evidenceIds.includes(evidenceId)).map((r) => r.parsed);
  }

  /** 某 procedure 的事件日志（seq 升序，审计可追溯）。 */
  async listEvents(procedureId: string): Promise<ProcedureTransitionEvent[]> {
    await this.#ensureInit();
    const dir = this.#eventsDir(procedureId);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return [];
      throw error;
    }
    const events: Array<{ seq: number; event: ProcedureTransitionEvent }> = [];
    for (const name of names) {
      const seq = Number(name.replace(/\.json$/u, ""));
      if (!Number.isFinite(seq)) continue;
      const filePath = path.join(dir, name);
      const stat = await lstat(filePath).catch((error: unknown) => {
        if (isErrnoCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (stat === undefined || !stat.isFile()) continue;
      const raw = await readFile(filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        corrupt("json_parse");
      }
      events.push({ seq, event: parseStoredEvent(parsed, procedureIdFileHash(procedureId), seq) });
    }
    events.sort((a, b) => a.seq - b.seq);
    return events.map((e) => e.event);
  }
}
