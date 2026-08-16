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
 * crash consistency（tech debt，与 ProcedureStore 一致）：current 覆盖写与 event append
 * 无原子性；real-host 部署前必须引入 WAL/rename 原子提交。
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ActivationProfile } from "../core/contracts/index.ts";
import {
  PROFILE_SUSPEND_REASON_EVIDENCE_CASCADE,
  suspendProfilesForEvidenceDeletion,
} from "./cascade.ts";
import type { OverlayEvaluationReport } from "./evaluate.ts";
import { evaluateProfilePromotion } from "./promotion.ts";
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
   * evidence（支撑报告 + 受控报告 ID）；store 内部自行重算 verdict，不信任 caller 传入的
   * ok。缺省 ⇒ 该边拒绝零写入；caller 无法只凭伪造 promotionReportId 通过。
   */
  promotion?: PromotionVerdictEvidence;
}

/** 结构化 promotion evidence（BLOCKER 2 收口：不信任 caller 的 verdict，store 自行重算）。 */
export interface PromotionVerdictEvidence {
  /** 支撑判定的评估报告（store 内部重新调用 evaluateProfilePromotion 判定）。 */
  report: OverlayEvaluationReport;
  /** promotion 报告 ID（受控格式，与 report 一起绑定）。 */
  promotionReportId: string;
}

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

  async #writeProfileFile(filePath: string, profile: ActivationProfile, exclusive: boolean): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const body = JSON.stringify(toStoredProfile(profile));
    await writeFile(filePath, body, { encoding: "utf8", flag: exclusive ? "wx" : "w" });
  }

  async #appendEvent(
    profileId: string,
    fromStatus: ActivationStatus | undefined,
    toStatus: EventToStatus,
    meta: TransitionMeta,
  ): Promise<void> {
    const seq = await this.#nextEventSeq(profileId);
    const event: ActivationTransitionEvent = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      eventId: `evt-${hash(`${profileId}\u0000${seq}`, 40)}`,
      seq,
      profileId,
      fromStatus,
      toStatus,
      ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
      ...(meta.reportId !== undefined ? { reportId: meta.reportId } : {}),
      trigger: meta.trigger,
      occurredAt: this.#now().toISOString(),
    };
    const filePath = this.#eventPath(profileId, seq);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(event), { encoding: "utf8", flag: "wx" });
  }

  /**
   * 首次写入（draft induction 落盘）。prior 已存在 ⇒ 拒绝（不覆盖；更新走 transition）。
   * BLOCKER 2：save 只允许初始 status="draft"——非 draft（直接 save active/shadow 等）
   * 拒绝零写入（发布状态必须经状态机 transition，不能绕过）。
   * 写 current（wx）+ 首条事件（fromStatus=undefined）。
   */
  async save(profile: ActivationProfile, meta: TransitionMeta): Promise<void> {
    await this.#ensureInit();
    assertValidStatus(profile.status);
    if (profile.status !== "draft") {
      throw new Error("activation_store_save_requires_draft");
    }
    if (profile.profileId === "") throw new Error("activation_store_invalid_identity");
    const currentPath = this.#currentPath(profile.profileId);
    if (await this.#fileExists(currentPath)) {
      throw new Error("activation_store_already_exists");
    }
    await this.#writeProfileFile(currentPath, profile, true);
    await this.#appendEvent(profile.profileId, undefined, profile.status, meta);
  }

  /**
   * BLOCKER 2（收口）：shadow→active 边必须携带结构化 promotion evidence（report +
   * 受控报告 ID）；store 内部重新调用 evaluateProfilePromotion(report) 判定（四栏覆盖 +
   * 冻结门槛 + nonInferior），不信任 caller 的 verdict.ok。缺省/不满足 ⇒ 拒绝零写入。
   */
  #assertPromotionVerdict(meta: TransitionMeta): void {
    const evidence = meta.promotion;
    if (evidence === undefined) {
      throw new Error("activation_store_promotion_verdict_required");
    }
    if (!PROMOTION_REPORT_ID_PATTERN.test(evidence.promotionReportId)) {
      throw new Error("activation_store_promotion_report_id_invalid");
    }
    // 不信任 caller 的 verdict.ok：store 根据 report 自己重新调用 evaluateProfilePromotion
    // （四栏覆盖 + 冻结门槛 + nonInferior 一并判定）。
    const recomputed = evaluateProfilePromotion(evidence.report);
    if (!recomputed.ok) {
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
    // BLOCKER 2：promotion 边（shadow→active）的结构化 evidence 校验先于落盘。
    const isPromotionEdge = prior.status === "shadow" && next.status === "active";
    if (isPromotionEdge) {
      this.#assertPromotionVerdict(meta);
    }
    const stored = await this.getProfile(prior.profileId);
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
    // immutable 内容以落盘 stored 为权威（不信任调用方 prior/next 双伪造）。
    assertImmutableContentUnchanged(stored, next);
    const currentPath = this.#currentPath(next.profileId);
    await this.#writeProfileFile(currentPath, next, false);
    // promotion 边的事件 reportId 绑定结构化 promotionReportId（不信任裸 reportId）。
    const eventMeta: TransitionMeta = isPromotionEdge
      ? {
          trigger: meta.trigger,
          reportId: meta.promotion!.promotionReportId,
        }
      : meta;
    await this.#appendEvent(next.profileId, prior.status, next.status, eventMeta);
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

  /** 当前状态（按 profileId）；不存在 ⇒ undefined。 */
  async getProfile(profileId: string): Promise<ActivationProfile | undefined> {
    await this.#ensureInit();
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
    const results = await this.#listCurrentRaw();
    return results.map((r) => r.parsed);
  }

  /** 按状态过滤当前 profile。 */
  async listByStatus(status: ActivationStatus): Promise<ActivationProfile[]> {
    assertValidStatus(status);
    const results = await this.#listCurrentRaw();
    return results.filter((r) => r.parsed.status === status).map((r) => r.parsed);
  }

  /** 按 evidenceId 过滤当前 profile（cascade 查找注入用）。 */
  async listByEvidenceId(evidenceId: string): Promise<ActivationProfile[]> {
    const results = await this.#listCurrentRaw();
    return results.filter((r) =>
      [
        ...r.parsed.learnedAliases,
        ...r.parsed.positiveExamples,
        ...r.parsed.nearMissExamples,
        ...r.parsed.environmentCues,
      ].some((cue) => cue.evidenceIds.includes(evidenceId)),
    ).map((r) => r.parsed);
  }

  /** 某 profile 的事件日志（seq 升序，审计可追溯）。 */
  async listEvents(profileId: string): Promise<ActivationTransitionEvent[]> {
    await this.#ensureInit();
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
