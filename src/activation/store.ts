/**
 * Phase 6 第四批 —— ActivationProfile store（project-local 持久化 + 删除级联落盘）。
 *
 * 仿 ProcedureStore（src/procedures/store/index.ts）范式，ActivationProfile 无 revision/
 * history/rollback，只需：
 * - current 快照（按 profileId）+ 可审计 append-only 事件日志（from/to status、reportId/
 *   reason、trigger、occurredAt、seq）；
 * - 查询：getProfile / listByStatus / listByEvidenceId（cascade 注入）/ listCurrent /
 *   listEvents；
 * - 写：save（首次 wx）/ transition（状态机推进，校验合法边 + stale-prior 三要素 +
 *   immutable 内容，非法拒绝落盘）。
 *
 * 安全约束（仿 ProcedureStore/PracticeStore）：
 * - project-local 强制：rootDir 必须位于 projectRoot 内，词法 + realpath 双校验；
 * - tenantScope 目录名 SHA-256（防 path traversal）；profileId 含冒号 ⇒ 文件名 SHA-256
 *   前缀，body 存完整值，读取校验一致性（fail-closed）；
 * - 持久化显式白名单复制（ActivationProfile 合同字段全集，不 spread 未知键）；事件只落
 *   受控 reason/reportId/trigger/时间戳（不落完整用户文本/路径）；
 * - 读取 fail-closed：JSON.parse / 字段类型 / 状态枚举 / id 一致性逐一校验，损坏抛固定
 *   错误码。
 *
 * store 不内嵌状态机纯函数：合法边表与 state.ts 语义一致（只持久化 + 校验），transition
 * 的 next 由调用方用 state.ts 纯函数产出。删除级联落盘组合 cascade.ts 纯函数 + 本 store。
 *
 * crash consistency（2026-08-18 收口，WAL + store 级文件锁，与 ProcedureStore 一致）：
 * - 每次写操作先原子落 txn（write/delete），再应用，最后清 txn；崩溃后 recoverAll 重放
 *   未清除 txn 幂等推进到一致终态（roll-forward），current 不再半提交；
 * - store 级文件锁（<root>/<tenantHash>.lock，wx 创建 + 租约 + 过期抢占）跨实例/进程
 *   single-writer，杜绝两个 Store 实例/进程并发写同一 root。
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ActivationProfile, SkillRecord } from "../core/contracts/index.ts";
import {
  PROFILE_SUSPEND_REASON_EVIDENCE_CASCADE,
  suspendProfilesForEvidenceDeletion,
} from "./cascade.ts";
import { evaluateOverlay } from "./evaluate.ts";
import {
  buildFrozenEvaluation,
  evaluateProfilePromotion,
  FROZEN_PROMOTION_OVERLAY,
  FROZEN_REQUIRED_COLUMNS,
} from "./promotion.ts";
import type { ActivationStatus, SuspendableProfile } from "./state.ts";

export const PROFILE_SCHEMA_VERSION = 1;
export const PROFILE_STORE_DIRNAME = ".skill-cortex/activation";

/** 事件触发来源（与 ProcedureStore 一致：agent/procedure/tool/user）。 */
export type TriggerSource = "agent" | "procedure" | "tool" | "user";

/** ActivationProfile 状态机合法边（与 state.ts 一致：draft|active|suspended→shadow；shadow→active；draft|shadow|active→suspended；active|suspended→retired）。 */
const LEGAL_TRANSITIONS: Readonly<Record<ActivationStatus, readonly ActivationStatus[]>> = {
  draft: ["shadow", "suspended"],
  shadow: ["active", "suspended"],
  active: ["shadow", "suspended", "retired"],
  suspended: ["shadow", "retired"],
  retired: [],
};

const PROFILE_STATUSES: readonly ActivationStatus[] = [
  "draft",
  "shadow",
  "active",
  "suspended",
  "retired",
];

/** 事件日志 toStatus 扩展：物理删除（终态之外的特殊审计值；本 slice 保留接口兼容）。 */
export type EventToStatus = ActivationStatus | "deleted";

/** 可审计 transition 事件（append-only；不丢历史）。 */
export interface ActivationTransitionEvent {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  eventId: string;
  /** 事件序号（profile 内递增；审计顺序标识）。 */
  seq: number;
  profileId: string;
  /** 事件后状态的 profile；undefined = 首次写入。 */
  fromStatus: ActivationStatus | undefined;
  toStatus: EventToStatus;
  /** 受控 reason（suspended/retired/删除）。 */
  reason?: string;
  /** 受控报告引用（shadow/promotion/revalidation 报告 ID）。 */
  reportId?: string;
  trigger: TriggerSource;
  occurredAt: string;
}

export interface ActivationProfileStoreOptions {
  /** store 根目录（project-local，如 <project>/.skill-cortex/activation）。 */
  rootDir: string;
  /** 项目根（project-local 强制基准）：默认 process.cwd()。 */
  projectRoot?: string;
  /** tenantScope（默认 "project:" + 规范化 projectRoot 的 SHA-256 前 32）。 */
  tenantScope?: string;
  now?: () => Date;
}

export interface TransitionMeta {
  trigger: TriggerSource;
  /** 受控审计：报告 ID（shadow/revalidation 边的报告引用）或 reason（suspended/retired）。 */
  reportId?: string;
  reason?: string;
  /**
   * BLOCKER 2（promotion trust boundary）：shadow→active 边必须携带结构化 promotion
   * evidence（当次 catalog records + 受控报告 ID）；store 用落盘 profile + records 自行
   * 重算 frozen 评估集与 verdict，不信任 caller。缺省 ⇒ 该边拒绝零写入。
   */
  promotion?: PromotionVerdictEvidence;
}

/** 结构化 promotion evidence（Issue 2：report/eval-input/binding 不可拆分——store 用落盘
 * profile + records 自行重算 frozen cases/report/verdict，不接受 caller 的 report/binding）。 */
export interface PromotionVerdictEvidence {
  /** 当次 discovery catalog（SkillRecord 全集）：store 据此 + 落盘 stored 重算 frozen 评估集。 */
  records: readonly SkillRecord[];
  /** promotion 报告 ID（受控格式）。 */
  promotionReportId: string;
}

/** WAL 事务（与 ProcedureStore 一致的 write/delete txn；write 携带完整 profile + event）。 */
export type ActivationTxn =
  | {
      kind: "write";
      seq: number;
      profileId: string;
      profile: ActivationProfile;
      event: ActivationTransitionEvent;
    }
  | { kind: "delete"; profileId: string };

/** 文件锁超时 / 重试 / 租约过期阈值（与 ProcedureStore 一致）。 */
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 30000;

/** promotion 报告 ID 受控格式（审计可追溯）。 */
const PROMOTION_REPORT_ID_PATTERN = /^promotion:[A-Za-z0-9._-]{1,95}$/u;

function hash(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

function tenantHashOf(tenantScope: string): string {
  return hash(tenantScope, 32);
}

function profileIdFileHash(profileId: string): string {
  return hash(profileId, 40);
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
  throw new Error(`activation_store_corrupt: ${code}`);
}

function assertValidStatus(value: unknown): asserts value is ActivationStatus {
  if (typeof value !== "string" || !(PROFILE_STATUSES as readonly string[]).includes(value)) {
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
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!deepEqual((a as Record<string, unknown>)[aKeys[i]!], (b as Record<string, unknown>)[bKeys[i]!])) {
      return false;
    }
  }
  return true;
}

/** transition 不可变字段：状态机只允许改 status/updatedAt；cue 数据/父绑定/profileId 冻结。 */
const IMMUTABLE_CONTENT_FIELDS: ReadonlyArray<keyof ActivationProfile> = [
  "schemaVersion",
  "profileId",
  "parentSkillId",
  "parentSkillRevision",
  "learnedAliases",
  "positiveExamples",
  "nearMissExamples",
  "environmentCues",
  "createdAt",
];

/** 断言 stored → next 未偷改 immutable 内容（fail-closed；以落盘 stored 为权威）。 */
function assertImmutableContentUnchanged(stored: ActivationProfile, next: ActivationProfile): void {
  for (const field of IMMUTABLE_CONTENT_FIELDS) {
    if (!deepEqual(stored[field], next[field])) {
      throw new Error(`activation_store_immutable_content_mutation: ${String(field)}`);
    }
  }
}

/** 持久化白名单复制（ActivationProfile 合同字段全集；不 spread 未知键）。 */
function toStoredProfile(profile: ActivationProfile): ActivationProfile {
  return {
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    parentSkillId: profile.parentSkillId,
    parentSkillRevision: profile.parentSkillRevision,
    status: profile.status,
    learnedAliases: profile.learnedAliases.map((alias) => ({
      ...alias,
      evidenceIds: [...alias.evidenceIds],
    })),
    positiveExamples: profile.positiveExamples.map((example) => ({
      ...example,
      features: [...example.features],
      evidenceIds: [...example.evidenceIds],
    })),
    nearMissExamples: profile.nearMissExamples.map((example) => ({
      ...example,
      features: [...example.features],
      evidenceIds: [...example.evidenceIds],
    })),
    environmentCues: profile.environmentCues.map((cue) => ({
      ...cue,
      evidenceIds: [...cue.evidenceIds],
    })),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

/** 读取 fail-closed：必填字段 + 状态枚举 + 文件名 hash 一致性。 */
function parseStoredProfile(raw: unknown, expectedProfileIdHash: string): ActivationProfile {
  if (typeof raw !== "object" || raw === null) corrupt("not_object");
  const profile = raw as Record<string, unknown>;
  if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION) corrupt("schema_version");
  if (typeof profile.profileId !== "string" || profile.profileId === "") corrupt("profile_id");
  if (profileIdFileHash(profile.profileId) !== expectedProfileIdHash) corrupt("profile_id_mismatch");
  if (typeof profile.parentSkillId !== "string" || profile.parentSkillId === "") corrupt("parent_skill_id");
  if (typeof profile.parentSkillRevision !== "string" || profile.parentSkillRevision === "") {
    corrupt("parent_skill_revision");
  }
  assertValidStatus(profile.status);
  if (!Array.isArray(profile.learnedAliases)) corrupt("learned_aliases");
  if (!Array.isArray(profile.positiveExamples)) corrupt("positive_examples");
  if (!Array.isArray(profile.nearMissExamples)) corrupt("near_miss_examples");
  if (!Array.isArray(profile.environmentCues)) corrupt("environment_cues");
  return profile as unknown as ActivationProfile;
}

function parseStoredEvent(
  raw: unknown,
  expectedProfileIdHash: string,
  expectedSeq: number,
): ActivationTransitionEvent {
  if (typeof raw !== "object" || raw === null) corrupt("event_not_object");
  const event = raw as Record<string, unknown>;
  if (event.schemaVersion !== PROFILE_SCHEMA_VERSION) corrupt("event_schema_version");
  if (typeof event.profileId !== "string" || profileIdFileHash(event.profileId) !== expectedProfileIdHash) {
    corrupt("event_profile_id_mismatch");
  }
  if (typeof event.eventId !== "string" || event.eventId === "") corrupt("event_id");
  if (event.fromStatus !== undefined) assertValidStatus(event.fromStatus);
  if (event.toStatus !== "deleted") assertValidStatus(event.toStatus);
  if (
    event.trigger !== "agent" &&
    event.trigger !== "procedure" &&
    event.trigger !== "tool" &&
    event.trigger !== "user"
  ) {
    corrupt("event_trigger");
  }
  if (typeof event.occurredAt !== "string" || event.occurredAt === "") corrupt("event_occurred_at");
  if (typeof event.seq !== "number" || event.seq !== expectedSeq) corrupt("event_seq_mismatch");
  return event as unknown as ActivationTransitionEvent;
}

/** 默认 tenantScope：project 前缀 + 规范化 projectRoot 的 SHA-256 前 32 hex。 */
export function defaultTenantScope(projectRoot: string): string {
  const normalized = path
    .resolve(projectRoot)
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("\\", "/");
  return `project:${hash(normalized, 32)}`;
}

export class ActivationProfileStore {
  readonly rootDir: string;
  readonly projectRoot: string;
  readonly tenantScope: string;
  #initialized = false;
  #now: () => Date;

  constructor(options: ActivationProfileStoreOptions) {
    const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    const rootDir = path.resolve(options.rootDir);
    if (!isPathInside(projectRoot, rootDir)) {
      throw new Error("activation_store_root_must_be_inside_project_root");
    }
    this.projectRoot = projectRoot;
    this.rootDir = rootDir;
    this.tenantScope = options.tenantScope ?? defaultTenantScope(projectRoot);
    this.#now = options.now ?? (() => new Date());
  }

  async #ensureInit(): Promise<void> {
    if (this.#initialized) return;
    const realRoot = await realpath(this.projectRoot);
    const realStore = await realpath(this.rootDir).catch(() => undefined);
    if (realStore !== undefined && !isPathInside(realRoot, realStore)) {
      throw new Error("activation_store_root_must_be_inside_project_root");
    }
    await mkdir(this.rootDir, { recursive: true });
    this.#initialized = true;
  }

  #storeLockPath(): string {
    return path.join(this.rootDir, `${tenantHashOf(this.tenantScope)}.lock`);
  }

  #txnDir(): string {
    return path.join(this.rootDir, tenantHashOf(this.tenantScope), "txn");
  }

  #txnPath(profileId: string): string {
    return path.join(this.#txnDir(), `${profileIdFileHash(profileId)}.txn.json`);
  }

  async #lockIsStale(lockPath: string): Promise<boolean> {
    const raw = await readFile(lockPath, "utf8").catch((error: unknown) => {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (raw === undefined) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return true;
    }
    const at = (parsed as { at?: unknown }).at;
    return typeof at !== "number" || Date.now() - at > LOCK_STALE_MS;
  }

  async #acquireStoreLock(): Promise<() => Promise<void>> {
    await mkdir(this.rootDir, { recursive: true });
    const lockPath = this.#storeLockPath();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), {
          encoding: "utf8",
          flag: "wx",
        });
        return async () => {
          await rm(lockPath, { force: true });
        };
      } catch (error) {
        if (!isErrnoCode(error, "EEXIST")) throw error;
        if (await this.#lockIsStale(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error("activation_store_locked");
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }

  async #withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.#acquireStoreLock();
    try {
      await this.#recoverAll();
      return await fn();
    } finally {
      await release();
    }
  }

  #parseTxnObject(obj: Record<string, unknown>): ActivationTxn {
    if (obj.kind === "delete") {
      if (typeof obj.profileId !== "string") corrupt("txn_delete_profile_id");
      return { kind: "delete", profileId: obj.profileId };
    }
    if (obj.kind === "write") {
      if (typeof obj.seq !== "number") corrupt("txn_write_seq");
      if (typeof obj.profileId !== "string") corrupt("txn_write_profile_id");
      const profile = parseStoredProfile(obj.profile, profileIdFileHash(obj.profileId));
      const event = parseStoredEvent(obj.event, profileIdFileHash(obj.profileId), obj.seq);
      return { kind: "write", seq: obj.seq, profileId: obj.profileId, profile, event };
    }
    corrupt("txn_kind");
  }

  async #writeTxn(profileId: string, txn: ActivationTxn): Promise<void> {
    await this.#writeFileAtomic(this.#txnPath(profileId), JSON.stringify(txn));
  }

  async #clearTxn(profileId: string): Promise<void> {
    await rm(this.#txnPath(profileId), { force: true });
  }

  /** 幂等重放 write txn：写 event + current。 */
  async #applyWriteTxn(txn: Extract<ActivationTxn, { kind: "write" }>): Promise<void> {
    await this.#appendEventAt(txn.profileId, txn.seq, txn.event);
    await this.#writeProfileFile(this.#currentPath(txn.profileId), txn.profile);
  }

  /** 幂等完成 delete：删 current + events 目录。 */
  async #completeDelete(profileId: string): Promise<void> {
    await rm(this.#currentPath(profileId), { force: true });
    await rm(this.#eventsDir(profileId), { recursive: true, force: true });
  }

  /** 崩溃恢复（store 级，锁内调用）：重放所有未清除 txn，幂等推进到一致终态。 */
  async #recoverAll(): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.#txnDir());
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".txn.json")) continue;
      const txnPath = path.join(this.#txnDir(), name);
      const raw = await readFile(txnPath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        corrupt("txn_json_parse");
      }
      const txn = this.#parseTxnObject(parsed as Record<string, unknown>);
      if (txn.kind === "delete") await this.#completeDelete(txn.profileId);
      else await this.#applyWriteTxn(txn);
      await rm(txnPath, { force: true });
    }
  }

  /** 原子写：先写 <path>.tmp 再 rename（同卷 rename 原子，崩溃不留截断文件）。 */
  async #writeFileAtomic(filePath: string, body: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, body, { encoding: "utf8", flag: "w" });
    await rename(tmp, filePath);
  }

  #currentDir(): string {
    return path.join(this.rootDir, tenantHashOf(this.tenantScope), "current");
  }

  #eventsDir(profileId: string): string {
    return path.join(this.rootDir, tenantHashOf(this.tenantScope), "events", profileIdFileHash(profileId));
  }

  #currentPath(profileId: string): string {
    return path.join(this.#currentDir(), `${profileIdFileHash(profileId)}.json`);
  }

  #eventPath(profileId: string, seq: number): string {
    return path.join(this.#eventsDir(profileId), `${String(seq).padStart(6, "0")}.json`);
  }

  async #nextEventSeq(profileId: string): Promise<number> {
    const dir = this.#eventsDir(profileId);
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

  /** 断言 from→to 是状态机合法边（fail-closed：非法转换拒绝落盘；与 state.ts 语义一致）。 */
  #assertLegalTransition(from: ActivationStatus, to: ActivationStatus): void {
    if (!(LEGAL_TRANSITIONS[from] as readonly string[]).includes(to)) {
      throw new Error(`activation_store_illegal_transition: ${from} -> ${to}`);
    }
  }

  async #writeProfileFile(filePath: string, profile: ActivationProfile): Promise<void> {
    const body = JSON.stringify(toStoredProfile(profile));
    await this.#writeFileAtomic(filePath, body);
  }

  /** 构造可审计 transition 事件（seq 由调用方在锁内用 #nextEventSeq 确定）。 */
  #buildEvent(
    seq: number,
    profileId: string,
    fromStatus: ActivationStatus | undefined,
    toStatus: EventToStatus,
    meta: TransitionMeta,
  ): ActivationTransitionEvent {
    return {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      eventId: `evt-${hash(`${profileId}#${seq}`, 40)}`,
      seq,
      profileId,
      fromStatus,
      toStatus,
      ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
      ...(meta.reportId !== undefined ? { reportId: meta.reportId } : {}),
      trigger: meta.trigger,
      occurredAt: this.#now().toISOString(),
    };
  }

  /** 原子写事件文件（seq 由 txn 确定，幂等覆盖）。 */
  async #appendEventAt(profileId: string, seq: number, event: ActivationTransitionEvent): Promise<void> {
    await this.#writeFileAtomic(this.#eventPath(profileId, seq), JSON.stringify(event));
  }

  /**
   * 首次写入（draft induction 落盘）。prior 已存在 ⇒ 拒绝（不覆盖；更新走 transition）。
   * BLOCKER 2：save 只允许初始 status="draft"——非 draft（直接 save active/shadow 等）
   * 拒绝零写入（发布状态必须经状态机 transition，不能绕过）。
   * WAL：写 write txn → 应用（event + current）→ 清 txn。
   */
  async save(profile: ActivationProfile, meta: TransitionMeta): Promise<void> {
    await this.#ensureInit();
    assertValidStatus(profile.status);
    if (profile.status !== "draft") {
      throw new Error("activation_store_save_requires_draft");
    }
    if (profile.profileId === "") throw new Error("activation_store_invalid_identity");
    await this.#withStoreLock(async () => {
      if (await this.#fileExists(this.#currentPath(profile.profileId))) {
        throw new Error("activation_store_already_exists");
      }
      // WAL：写 txn（意图）→ 应用（event + current）→ 清 txn。
      const seq = await this.#nextEventSeq(profile.profileId);
      const event = this.#buildEvent(seq, profile.profileId, undefined, profile.status, meta);
      const txn: ActivationTxn = { kind: "write", seq, profileId: profile.profileId, profile, event };
      await this.#writeTxn(profile.profileId, txn);
      await this.#applyWriteTxn(txn);
      await this.#clearTxn(profile.profileId);
    });
  }

  /**
   * BLOCKER 2 + Issue 2（收口）：shadow→active 边必须携带 records（当次 discovery catalog）；
   * store 用落盘 stored + records 确定性重算 frozen cases → report → verdict，不接受 caller
   * 的 report/binding——report/eval-input/binding 由同一重算构成，不可拼接绕过（A 的 report
   * 无法用于 B）。缺省/不满足 ⇒ 拒绝零写入。
   */
  #assertPromotionVerdict(meta: TransitionMeta, stored: ActivationProfile): void {
    const evidence = meta.promotion;
    if (evidence === undefined) {
      throw new Error("activation_store_promotion_verdict_required");
    }
    if (!PROMOTION_REPORT_ID_PATTERN.test(evidence.promotionReportId)) {
      throw new Error("activation_store_promotion_report_id_invalid");
    }
    const { cases } = buildFrozenEvaluation(stored, evidence.records);
    if (cases.length === 0) {
      throw new Error("activation_store_promotion_parent_not_in_evaluation_set");
    }
    const report = evaluateOverlay(cases, evidence.records, stored, FROZEN_PROMOTION_OVERLAY);
    const verdict = evaluateProfilePromotion(report, { requiredColumns: FROZEN_REQUIRED_COLUMNS });
    if (!verdict.ok) {
      throw new Error("activation_store_promotion_verdict_not_passed");
    }
  }

  /**
   * 状态机推进：prior → next。校验（fail-closed，HIGH 1 仿 ProcedureStore）：
   * - next.profileId === prior.profileId；prior.status → next.status ∈ 合法边；
   * - stale-prior 三要素：读取落盘 stored 的 profileId + parentSkillRevision + status
   *   必须与 prior 完全一致（旧/伪造 prior 拒绝，不落盘）；
   * - immutable 内容（cue 数据/父绑定）以落盘 stored 为权威，next 只允许改 status/updatedAt；
   * - BLOCKER 2：shadow→active 边必须携带通过的结构化 promotion verdict（见
   *   #assertPromotionVerdict）；事件 reportId 用 promotionReportId（受控）；
   * - 通过后写 current（覆盖）+ append 事件（不丢历史）。
   */
  async transition(
    prior: ActivationProfile,
    next: ActivationProfile,
    meta: TransitionMeta,
  ): Promise<void> {
    await this.#ensureInit();
    assertValidStatus(prior.status);
    assertValidStatus(next.status);
    if (prior.profileId !== next.profileId) {
      throw new Error("activation_store_transition_profile_id_mismatch");
    }
    this.#assertLegalTransition(prior.status, next.status);
    const isPromotionEdge = prior.status === "shadow" && next.status === "active";
    await this.#withStoreLock(async () => {
      const stored = await this.#readCurrentLocked(prior.profileId);
      if (stored === undefined) {
        throw new Error("activation_store_missing_prior");
      }
      // stale-prior 三要素：profileId + parentSkillRevision + status 必须与落盘一致。
      if (
        stored.profileId !== prior.profileId ||
        stored.parentSkillRevision !== prior.parentSkillRevision ||
        stored.status !== prior.status
      ) {
        throw new Error("activation_store_stale_prior");
      }
      // BLOCKER 2 + Issue 2：promotion 边（shadow→active）用落盘 stored 自行重算 verdict
      // （不信任 caller 的 report/binding）。
      if (isPromotionEdge) {
        this.#assertPromotionVerdict(meta, stored);
      }
      // immutable 内容以落盘 stored 为权威（不信任调用方 prior/next 双伪造）。
      assertImmutableContentUnchanged(stored, next);
      // promotion 边的事件 reportId 绑定结构化 promotionReportId（不信任裸 reportId）。
      const eventMeta: TransitionMeta = isPromotionEdge
        ? {
            trigger: meta.trigger,
            reportId: meta.promotion!.promotionReportId,
          }
        : meta;
      // WAL：写 txn（意图）→ 应用（event + current）→ 清 txn。
      const seq = await this.#nextEventSeq(next.profileId);
      const event = this.#buildEvent(seq, next.profileId, prior.status, next.status, eventMeta);
      const txn: ActivationTxn = { kind: "write", seq, profileId: next.profileId, profile: next, event };
      await this.#writeTxn(next.profileId, txn);
      await this.#applyWriteTxn(txn);
      await this.#clearTxn(next.profileId);
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
  async #readCurrentLocked(profileId: string): Promise<ActivationProfile | undefined> {
    const filePath = this.#currentPath(profileId);
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
    return parseStoredProfile(parsed, profileIdFileHash(profileId));
  }

  /** 读取事件日志（raw；seq 升序，不加锁不恢复）。 */
  async #readEventsLocked(profileId: string): Promise<ActivationTransitionEvent[]> {
    const dir = this.#eventsDir(profileId);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return [];
      throw error;
    }
    const events: Array<{ seq: number; event: ActivationTransitionEvent }> = [];
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
      events.push({ seq, event: parseStoredEvent(parsed, profileIdFileHash(profileId), seq) });
    }
    events.sort((a, b) => a.seq - b.seq);
    return events.map((e) => e.event);
  }

  /** 当前状态（按 profileId）；不存在 ⇒ undefined。 */
  async getProfile(profileId: string): Promise<ActivationProfile | undefined> {
    await this.#ensureInit();
    return this.#withStoreLock(() => this.#readCurrentLocked(profileId));
  }

  async #listCurrentRaw(): Promise<Array<{ profileId: string; parsed: ActivationProfile }>> {
    await this.#ensureInit();
    const dir = this.#currentDir();
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return [];
      throw error;
    }
    const results: Array<{ profileId: string; parsed: ActivationProfile }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
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
      results.push({
        profileId: (parsed as { profileId?: unknown }).profileId as string,
        parsed: parseStoredProfile(parsed, name.slice(0, -".json".length)),
      });
    }
    return results;
  }

  /** 全部当前 profile。 */
  async listCurrent(): Promise<ActivationProfile[]> {
    await this.#ensureInit();
    return this.#withStoreLock(async () => {
      const results = await this.#listCurrentRaw();
      return results.map((r) => r.parsed);
    });
  }

  /** 按状态过滤当前 profile。 */
  async listByStatus(status: ActivationStatus): Promise<ActivationProfile[]> {
    assertValidStatus(status);
    await this.#ensureInit();
    return this.#withStoreLock(async () => {
      const results = await this.#listCurrentRaw();
      return results.filter((r) => r.parsed.status === status).map((r) => r.parsed);
    });
  }

  /** 按 evidenceId 过滤当前 profile（cascade 查找注入用）。 */
  async listByEvidenceId(evidenceId: string): Promise<ActivationProfile[]> {
    await this.#ensureInit();
    return this.#withStoreLock(async () => {
      const results = await this.#listCurrentRaw();
      return results.filter((r) =>
        [
          ...r.parsed.learnedAliases,
          ...r.parsed.positiveExamples,
          ...r.parsed.nearMissExamples,
          ...r.parsed.environmentCues,
        ].some((cue) => cue.evidenceIds.includes(evidenceId)),
      ).map((r) => r.parsed);
    });
  }

  /** 某 profile 的事件日志（seq 升序，审计可追溯）。 */
  async listEvents(profileId: string): Promise<ActivationTransitionEvent[]> {
    await this.#ensureInit();
    return this.#withStoreLock(() => this.#readEventsLocked(profileId));
  }
}

export interface EvidenceDeletionCascadeOutcome {
  /** 被 suspend 的 profileId（顺序 = 输入顺序）。 */
  suspended: readonly string[];
}

/**
 * 删除级联落盘（组合 cascade.ts 纯函数 + 本 store 持久化）：
 * - 从 store.listCurrent() 注入当前非终态 profiles；
 * - suspendProfilesForEvidenceDeletion 判定命中（任一 cue 的 evidenceIds 含被删 id）；
 * - 每个命中 profile 经 store.transition 落盘 suspended（受控 reason + trigger）；
 * - 未命中不变；transition 失败（stale/非法边）向上抛（fail-closed，不部分落盘）。
 */
export async function applyEvidenceDeletionCascade(
  store: ActivationProfileStore,
  invalidatedEventIds: readonly string[],
  trigger: TriggerSource,
): Promise<EvidenceDeletionCascadeOutcome> {
  const current = await store.listCurrent();
  const candidates = current.filter(
    (profile) =>
      profile.status === "draft" || profile.status === "shadow" || profile.status === "active",
  ) as readonly SuspendableProfile[];
  const suspendedList = suspendProfilesForEvidenceDeletion(candidates, invalidatedEventIds);
  const suspended: string[] = [];
  for (const { profileId, suspended: next } of suspendedList) {
    const prior = current.find((profile) => profile.profileId === profileId);
    if (prior === undefined) continue; // 防御：store 与注入集一致，理论不可达
    await store.transition(prior, next, {
      trigger,
      reason: PROFILE_SUSPEND_REASON_EVIDENCE_CASCADE,
    });
    suspended.push(profileId);
  }
  return { suspended };
}
