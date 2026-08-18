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
 * crash consistency（2026-08-18 收口）：
 * 提交协议 = 事件先写（意图，原子 rename）→ history（原子 rename，幂等）→ current（原子
 * rename）→ release（原子 rename）；每个文件经 <path>.tmp + rename 原子替换，崩溃不截断。
 * 唯一崩溃产物是「事件已 append 但 current 未提交」的悬挂事件尾；读/写路径在每 entity
 * 进程内互斥锁内调用 #recoverLocked，确定性回滚悬挂事件尾（见 #recoverLocked）。同一 entity
 * 的并发 writer 由锁串行化（后到者 re-read 后 stale-prior 拒绝），杜绝双 writer 双成功。
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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

/** 受控 rollback 事件 reason（审计：区分 rollback 与普通 resume/transition，不落自由文本）。 */
export const ROLLBACK_REASON = "rollback_to_stable" as const;

/**
 * revision 的 release/lifecycle state（HIGH 2/BLOCKER 1）：记录某 procedureRevision 实际到达过的
 * 发布状态（非 immutable artifact 内容）。rollback 的 stable lookup 只认此记录。
 * - 与 immutable artifact snapshot（history）分离：history 不覆盖，release 可更新；
 * - BLOCKER 1：累计保存完整 promotion evidence（validation/canary/active 三个独立字段，
 *   非仅当前状态对应那一个）——active→suspended 后三段报告引用必须继续保留；
 * - suspended 时带 suspendedFrom（自动派生，曾发布为 active 才可作 stable 目标）与
 *   suspendKind（drift/cascade 需重验，rollback 的 requires_revalidation 门依赖）。
 */
export interface ReleaseStateRecord {
  schemaVersion: typeof PROCEDURE_SCHEMA_VERSION;
  procedureId: string;
  procedureRevision: string;
  status: CompiledProcedure["status"];
  /** 完整 promotion evidence（累计保存；active/suspended-from-active 目标三段必须齐全）。 */
  validationReportId?: string;
  canaryReportId?: string;
  activeReportId?: string;
  /** MED：累计 evidenceIds（含 canary replayEvidenceIds；stable 重建时恢复，cascade 可查）。 */
  evidenceIds?: string[];
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

/** 递归深比较（对象 key 顺序无关；数组有序）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) return false;
    return a.every((value, index) => deepEqual(value, (b as unknown[])[index]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!deepEqual((a as Record<string, unknown>)[aKeys[i]!], (b as Record<string, unknown>)[bKeys[i]!])) {
      return false;
    }
  }
  return true;
}

/**
 * HIGH 2：immutable 内容投影字段（同 revision 下禁止变化——不允许 active artifact 原地修改，
 * 修订必须产生新 revision）。transition 只允许改：status / validationReportId / canaryReportId /
 * activeReportId / evidenceIds（canary replay 追加）/ suspendedFrom / suspendKind /
 * lifecycleReason / previousStableRevision。其余字段逐字段比较，任一 diff ⇒ 拒绝。
 */
const IMMUTABLE_CONTENT_FIELDS: ReadonlyArray<keyof CompiledProcedure> = [
  "schemaVersion",
  "procedureRevision",
  "parentSkillId",
  "parentSkillRevision",
  "dependencyFingerprint",
  "inputSchema",
  "preconditions",
  "coveredSteps",
  "forbiddenAutomationSteps",
  "runtimeGuards",
  "llmHoles",
  "declaredEffects",
  "requiredPermissions",
  "postconditions",
  "artifactLocator",
  "artifactHash",
  "createdAt",
];

/** 断言 prior → next 未偷改 immutable 内容（fail-closed；字段级错误码）。 */
function assertImmutableContentUnchanged(prior: CompiledProcedure, next: CompiledProcedure): void {
  for (const field of IMMUTABLE_CONTENT_FIELDS) {
    if (!deepEqual(prior[field], next[field])) {
      throw new Error(`procedure_store_immutable_content_mutation: ${String(field)}`);
    }
  }
}

/** 晋升锁定字段（仅其特定 promotion 边可设置；其余边必须与落盘 stored 一致）。 */
const PROMOTION_LOCKED_FIELDS = [
  "validationReportId",
  "canaryReportId",
  "activeReportId",
  "previousStableRevision",
] as const;

/** 各 promotion 边允许设置的报告字段。 */
const PROMOTION_SETTABLE: Readonly<Record<string, ReadonlyArray<string>>> = {
  "draft→validated": ["validationReportId"],
  "validated→canary": ["canaryReportId"],
  "canary→active": ["activeReportId", "previousStableRevision"],
};

/**
 * 断言 stored → next 的允许 delta（fail-closed）：
 * - immutable 内容（artifact/依赖/权限/guard 等）逐字段比较，以 store 落盘 stored 为权威
 *   （不信任调用方 prior——即使 prior+next 同时伪造也因与 stored 不一致而拒绝）；
 * - 晋升锁定字段（reportId / previousStableRevision）仅在其特定 promotion 边可设置，其余边
 *   必须与 stored 一致（防 active→suspended 偷改 activeReportId / previousStableRevision）；
 * - evidenceIds 仅在 validated→canary 可追加（replay evidence），且不得删除既有；其余边冻结。
 */
function assertAllowedDelta(stored: CompiledProcedure, next: CompiledProcedure): void {
  assertImmutableContentUnchanged(stored, next);
  const edge = `${stored.status}→${next.status}`;
  const settable = PROMOTION_SETTABLE[edge] ?? [];
  for (const field of PROMOTION_LOCKED_FIELDS) {
    if (settable.includes(field)) continue;
    if (next[field] !== stored[field]) {
      throw new Error(`procedure_store_field_change_not_allowed: ${String(field)}`);
    }
  }
  if (edge === "validated→canary") {
    for (const id of stored.evidenceIds) {
      if (!next.evidenceIds.includes(id)) {
        throw new Error("procedure_store_evidence_ids_deleted");
      }
    }
  } else if (!deepEqual(stored.evidenceIds, next.evidenceIds)) {
    throw new Error("procedure_store_evidence_ids_changed");
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
  #locks = new Map<string, Promise<void>>();

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

  /** 每 entity 进程内互斥（FIFO 异步链）：同一 procedure 的写/恢复串行化，杜绝并发 writer 双成功。 */
  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(key, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 原子写：先写 <path>.tmp 再 rename（同卷 rename 原子，崩溃不留截断文件）。 */
  async #writeFileAtomic(filePath: string, body: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, body, { encoding: "utf8", flag: "w" });
    await rename(tmp, filePath);
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

  async #writeProcedureFile(filePath: string, procedure: CompiledProcedure): Promise<void> {
    const body = JSON.stringify(toStoredProcedure(procedure));
    await this.#writeFileAtomic(filePath, body);
  }

  /** 从 transition/save 后的 procedure 提取 release 状态记录（覆盖写：该 revision 的当前 release 状态）。
   * BLOCKER 1：累计复制三个 promotion evidence 字段（procedure 对象经状态机 spread 恒保留
   * 全部已到达阶段的报告引用；pending 占位不是 evidence，跳过）。 */
  async #writeReleaseState(procedure: CompiledProcedure): Promise<void> {
    const record: ReleaseStateRecord = {
      schemaVersion: PROCEDURE_SCHEMA_VERSION,
      procedureId: procedure.procedureId,
      procedureRevision: procedure.procedureRevision,
      status: procedure.status,
      ...(procedure.validationReportId !== undefined &&
      procedure.validationReportId !== "pending:phase3-pagination-validation"
        ? { validationReportId: procedure.validationReportId }
        : {}),
      ...(procedure.canaryReportId !== undefined ? { canaryReportId: procedure.canaryReportId } : {}),
      ...(procedure.activeReportId !== undefined ? { activeReportId: procedure.activeReportId } : {}),
      ...(procedure.evidenceIds.length > 0 ? { evidenceIds: [...procedure.evidenceIds] } : {}),
      ...(procedure.suspendedFrom !== undefined ? { suspendedFrom: procedure.suspendedFrom } : {}),
      ...(procedure.suspendKind !== undefined ? { suspendKind: procedure.suspendKind } : {}),
      ...(procedure.lifecycleReason !== undefined ? { lifecycleReason: procedure.lifecycleReason } : {}),
      updatedAt: this.#now().toISOString(),
    };
    const filePath = this.#releasePath(procedure.procedureId, procedure.procedureRevision);
    await this.#writeFileAtomic(filePath, JSON.stringify(record));
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

  /** 从 immutable artifact 快照 + release 记录合成 stable 候选（content 取 history，状态取 release）。
   * BLOCKER 1：恢复完整 promotion evidence（validation/canary/active 三段）。 */
  async #composeStableCandidate(release: ReleaseStateRecord): Promise<CompiledProcedure | undefined> {
    const snapshot = await this.#findHistorySnapshot(release.procedureId, release.procedureRevision);
    if (snapshot === undefined) return undefined; // release 存在但 artifact 快照缺失 ⇒ fail-closed
    return {
      ...snapshot,
      status: release.status,
      ...(release.validationReportId !== undefined
        ? { validationReportId: release.validationReportId }
        : {}),
      ...(release.canaryReportId !== undefined ? { canaryReportId: release.canaryReportId } : {}),
      ...(release.activeReportId !== undefined ? { activeReportId: release.activeReportId } : {}),
      ...(release.evidenceIds !== undefined ? { evidenceIds: [...release.evidenceIds] } : {}),
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
    await this.#writeFileAtomic(filePath, JSON.stringify(event));
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
    await this.#withLock(procedure.procedureId, async () => {
      await this.#recoverLocked(procedure.procedureId);
      const currentPath = this.#currentPath(procedure.procedureId);
      if (await this.#fileExists(currentPath)) {
        throw new Error("procedure_store_already_exists");
      }
      // 提交顺序：事件先写（意图）→ history（幂等，原子）→ current（原子 rename）→ release（原子 rename）。
      const meta_ = auditMetaOf(procedure);
      await this.#appendEvent(
        procedure.procedureId,
        procedure.procedureRevision,
        undefined,
        procedure.status,
        meta.trigger,
        meta_,
      );
      await this.#writeProcedureFile(
        this.#historyPath(procedure.procedureId, procedure.procedureRevision),
        procedure,
      );
      await this.#writeProcedureFile(currentPath, procedure);
      await this.#writeReleaseState(procedure);
    });
  }

  /**
   * 状态机推进：prior → next。校验（fail-closed，HIGH 1：不信任调用者传入的 prior；
   * BLOCKER 2：禁止跨 procedureRevision 沿旧 lifecycle 晋升）：
   * - next.procedureId 必须与 prior 一致；
   * - prior.status → next.status 必须 ∈ 合法边（非法转换拒绝落盘）；
   * - next.procedureRevision 必须 === prior.procedureRevision——revision 变化不得经普通
   *   lifecycle transition（修订必须重新验证；新 revision 经独立 revision/save seam 进入）；
   * - 读取 store 当前落盘 stored：stored.procedureId / procedureRevision / status 必须
   *   与 prior 完全一致——stale/伪造 prior（旧 status、错 revision）一律拒绝，且
   *   不得修改 current/history/release/events；
   * - next 写 current（覆盖当前状态）+ release（该 revision 的 release 状态）；
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
    await this.#withLock(next.procedureId, async () => {
      await this.#recoverLocked(next.procedureId);
      // HIGH 1：读取真实落盘状态，校验 prior 一致（stale/伪造 prior 拒绝）。
      const stored = await this.#readCurrentLocked(prior.procedureId);
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
      // BLOCKER 2：revision 变化不得经普通 lifecycle transition（修订必须重新验证）。
      if (prior.procedureRevision !== next.procedureRevision) {
        throw new Error("procedure_store_revision_change_requires_revalidation");
      }
      // HIGH 2：同 revision 不得偷改 immutable 内容 + 晋升锁定字段（以落盘 stored 为权威，不信任 prior）。
      assertAllowedDelta(stored, next);
      const meta_ = auditMetaOf(next);
      // 提交顺序：事件先写（意图）→ current（原子 rename）→ release（原子 rename）。
      await this.#appendEvent(
        next.procedureId,
        next.procedureRevision,
        prior.status,
        next.status,
        meta.trigger,
        meta_,
      );
      await this.#writeProcedureFile(this.#currentPath(next.procedureId), next);
      await this.#writeReleaseState(next);
    });
  }

  /**
   * 专用 rollback 落盘 seam：把 current 真正切回 previousStableRevision（active stable）。
   *
   * 与普通 transition() 的边界（不放开 BLOCKER 2 的跨 revision 禁令）：
   * - 普通 transition() 仍拒绝任何 procedureRevision 变化；
   * - 本 seam 是唯一允许跨 revision 覆盖 current 的路径，且目标 revision 严格锁定
   *   failed.previousStableRevision（不得任意指定、不得经配置注入）。
   *
   * HIGH 3（API 变更）：不接收 caller 构造的 target——恢复来源只认 store 自身。
   * 调用方只传 stableRevision（严格 === failed.previousStableRevision），store 内部重新
   * getStableByRevision() 重读 stableNow，用其 immutable 内容构造 active 恢复版本并写入。
   * caller 无任何途径注入“身份像 stable 但内容被改”的对象。
   *
   * 校验（全部 fail-closed，任一失败不落盘、不追加事件）：
   * - failed.previousStableRevision 必须存在，且 stableRevision 严格等于它；
   * - HIGH 1 stale-prior：读取 store 落盘 current，procedureId + procedureRevision + status
   *   三要素必须与 failed 完全一致（调用方拿旧 failed 期间 current 已推进 ⇒ 拒绝）；
   * - idempotency：current 已回滚（同 revision + active）⇒ 拒绝（防重复事件）；
   * - stable 仍合法：getStableByRevision 重读命中且 procedureId 一致（防 revision hash 跨
   *   procedure 碰撞 / stable 已被 retire/remove）。
   *
   * 落盘（history 不可变，不覆盖失败 revision 的 immutable 快照）：
   * current 覆盖写 active 恢复版本（stableNow 内容 + status=active，清 suspended 元数据）
   * → release[stableRevision] 重写 active → append 可审计 rollback 事件（fromStatus=
   * failed.status，toStatus=active，reason=ROLLBACK_REASON）。append-only 不丢历史。
   */
  async rollbackTo(
    failed: CompiledProcedure,
    stableRevision: string,
    meta: TransitionMeta,
  ): Promise<void> {
    await this.#ensureInit();
    assertValidStatus(failed.status);
    await this.#withLock(failed.procedureId, async () => {
      await this.#recoverLocked(failed.procedureId);
      const stored = await this.#readCurrentLocked(failed.procedureId);
      if (stored === undefined) {
        throw new Error("procedure_store_missing_prior");
      }
      // idempotency（先于 stale-prior）：current 已回滚到 stable（active + revision === stableRevision）。
      if (stored.status === "active" && stored.procedureRevision === stableRevision) {
        throw new Error("procedure_store_rollback_already_applied");
      }
      // HIGH 1 stale-prior：真实落盘 current 三要素与 failed 完全一致（不信任调用者传入身份）。
      if (
        stored.procedureId !== failed.procedureId ||
        stored.procedureRevision !== failed.procedureRevision ||
        stored.status !== failed.status
      ) {
        throw new Error("procedure_store_rollback_stale_prior");
      }
      // 目标 revision 权威来源 = stored.previousStableRevision（不信任 failed.previousStableRevision）。
      const previous = stored.previousStableRevision;
      if (previous === undefined) {
        throw new Error("procedure_store_rollback_no_stable_version");
      }
      if (stableRevision !== previous) {
        throw new Error("procedure_store_rollback_target_revision_mismatch");
      }
      // HIGH 3：stable 恢复来源只认 store 自身重读（不接受 caller 内容）。
      const stableNow = await this.getStableByRevision(previous);
      if (stableNow === undefined || stableNow.procedureId !== failed.procedureId) {
        throw new Error("procedure_store_rollback_stable_unavailable");
      }
      // 用 stableNow 的 immutable 内容构造 active 恢复版本（清 suspended 元数据，与 rollback 语义一致）。
      const { lifecycleReason: _reason, suspendedFrom: _from, suspendKind: _kind, ...rest } = stableNow;
      void _reason;
      void _from;
      void _kind;
      const target = { ...rest, status: "active" as const } as CompiledProcedure;
      // 提交顺序：事件先写（意图）→ current（原子 rename）→ release（原子 rename）。
      await this.#appendEvent(
        target.procedureId,
        target.procedureRevision,
        failed.status,
        "active",
        meta.trigger,
        { reason: ROLLBACK_REASON },
      );
      await this.#writeProcedureFile(this.#currentPath(target.procedureId), target);
      await this.#writeReleaseState(target);
    });
  }

  /**
   * 级联删除入口：prior 存在 ⇒ 先写删除事件（审计先于清理，toStatus="deleted"）→
   * 再删 current/history/release/events 目录（事件历史随同清理）。prior 不存在 ⇒ 幂等（0 操作）。
   */
  async remove(procedureId: string, meta: TransitionMeta): Promise<void> {
    await this.#ensureInit();
    await this.#withLock(procedureId, async () => {
      await this.#recoverLocked(procedureId);
      const currentPath = this.#currentPath(procedureId);
      const prior = await this.#readCurrentLocked(procedureId);
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
    });
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

  /** 读取 current（raw；不加锁不恢复——由调用方在锁内保证）。 */
  async #readCurrentLocked(procedureId: string): Promise<CompiledProcedure | undefined> {
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

  /** 读取事件日志（raw；seq 升序，不加锁不恢复）。 */
  async #readEventsLocked(procedureId: string): Promise<ProcedureTransitionEvent[]> {
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

  /**
   * crash 恢复（fail-closed；必须在锁内调用）：事件先写 + current/release 原子 rename 的提交
   * 协议下，崩溃只可能留下「已 append 事件但 current 未提交」的悬挂事件尾。恢复 = 确定性回滚
   * 悬挂事件尾（不前滚、不补写）：current（原子 rename，永不截断）是权威，悬挂事件被删除。
   * - current 缺失但事件存在（save 崩溃）⇒ 删除全部悬挂事件（首次写入未提交）。
   * - 尾部事件 fromStatus == current.status 且 toStatus != current.status（transition/rollback
   *   从 current 出发但未提交）⇒ 逐个删除尾部悬挂事件。
   * - 尾部 "deleted" 事件但 current 仍在（remove 崩溃）⇒ 回滚删除意图（删除该事件，保留实体）。
   * 非上述情形（正常提交 / current 领先事件的测试直写 seam）不动作。
   */
  async #recoverLocked(procedureId: string): Promise<void> {
    const current = await this.#readCurrentLocked(procedureId);
    let events = await this.#readEventsLocked(procedureId);
    if (events.length === 0) return;
    if (current === undefined) {
      for (const event of events) await rm(this.#eventPath(procedureId, event.seq), { force: true });
      return;
    }
    while (events.length > 0) {
      const last = events[events.length - 1]!;
      if (last.toStatus === "deleted") {
        await rm(this.#eventPath(procedureId, last.seq), { force: true });
        events = await this.#readEventsLocked(procedureId);
        continue;
      }
      if (last.fromStatus === current.status && last.toStatus !== current.status) {
        await rm(this.#eventPath(procedureId, last.seq), { force: true });
        events = await this.#readEventsLocked(procedureId);
        continue;
      }
      break;
    }
  }

  /** 当前状态（按 procedureId）；不存在 ⇒ undefined。 */
  async getProcedure(procedureId: string): Promise<CompiledProcedure | undefined> {
    await this.#ensureInit();
    return this.#withLock(procedureId, async () => {
      await this.#recoverLocked(procedureId);
      return this.#readCurrentLocked(procedureId);
    });
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
   * rollback stable lookup seam（HIGH 2/BLOCKER 1）：只返回该 procedureRevision 已真实到达合法
   * stable 发布状态的记录——active，或 suspended 且 suspendedFrom="active"（曾发布为
   * active；drift/cascade 的 revalidation 资格由 rollbackProcedure 的 suspendKind 门另判）。
   * 从未 active 的 draft/validated/canary（含 suspendedFrom≠active）与 retired revision
   * ⇒ undefined（不可作 stable 目标）。
   * BLOCKER 1 fail-closed：声称曾 active 的 stable candidate 必须携带完整 promotion evidence
   * （canaryReportId + activeReportId）；缺任一 ⇒ undefined（不返回缺证据的 rollback target，
   * 防止恢复出缺发布证据链的 active procedure）。
   * 返回对象 = immutable artifact 快照（history 内容）+ release 状态（status/三段 report/
   * suspendedFrom/suspendKind/lifecycleReason），供 rollbackProcedure 的既有
   * revision/procedureId/parentSkillId lineage 校验与稳定状态判定直接消费。
   */
  async getStableByRevision(procedureRevision: string): Promise<CompiledProcedure | undefined> {
    await this.#ensureInit();
    const release = await this.#findReleaseByRevision(procedureRevision);
    if (release === undefined) return undefined;
    // BLOCKER 1 fail-closed：声称曾 active（active 或 suspended-from-active）的 stable
    // candidate 必须携带完整 promotion evidence（canaryReportId + activeReportId）；
    // 缺任一 ⇒ undefined（不返回缺证据的 rollback target）。
    if (release.status === "active") {
      if (release.canaryReportId === undefined || release.activeReportId === undefined) {
        return undefined;
      }
      return this.#composeStableCandidate(release);
    }
    if (release.status === "suspended" && release.suspendedFrom === "active") {
      if (release.canaryReportId === undefined || release.activeReportId === undefined) {
        return undefined;
      }
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
    return this.#withLock(procedureId, async () => {
      await this.#recoverLocked(procedureId);
      return this.#readEventsLocked(procedureId);
    });
  }
}
