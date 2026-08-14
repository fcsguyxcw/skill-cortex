/**
 * Phase 2 — 最小 project-local append-only Practice Store abstraction。
 *
 * 冻结语义（数据合同 §4.4、§7；实施计划 §7；ADR-0008；Leader 审查要求）：
 * - 只接受 schemaVersion=1、sensitivity="none"、retentionClass="project_manual" 的 PracticeEvent；
 * - provenance 四类（real/shadow/evaluation/synthetic）物理分区；
 * - tenantScope 隔离：目录名使用稳定 SHA-256（不拼接原始 tenant 字符串，防 path traversal）；
 * - eventId 是 tenant 内全局证据 ID：独立 claims seam 经 wx（O_EXCL）保证跨分区并发唯一，
 *   同 ID 不可在不同 provenance 重复；删除后 ID 不得静默复用（claim + tombstone 保留）；
 * - append 在任何 mkdir/write 前调用 ../policy/index.ts 的 validatePracticeEvent：不通过时抛
 *   稳定错误码摘要（只含 issue.code，不回显原始值）；持久化使用 policy 计算的
 *   attribution/failureClass/firstAttributableFailureStepId 正规化值（不信任 caller 字段），
 *   undefined 字段真正省略；再经 store 准入白名单（eventId 字符/tenant 长度等）；
 * - append 排他（claim + 分区文件双 wx）：同 eventId 不得覆盖，事件本体不可原地修改；
 * - explicit deletion（invalidate）事务顺序：先定位 provenance → 先 wx 写 tombstone
 *   （审计先于删除，无审计缺口窗口）→ 再物理删除事件本体；rm 失败时 tombstone 已隐藏查询，
 *   重试仍尝试物理删除；tombstone 不含事件内容；DeleteResult 只返回真实存在且被删除/
 *   已 tombstone 的 ids（不制造虚假失效）；重复删除幂等；
 * - project-local 强制：rootDir 必须位于 projectRoot（默认 process.cwd()）内，
 *   词法（构造时）+ realpath（首次 I/O 前）双校验，拒绝 ../ 与 symlink/junction 逃逸；
 * - 读取时 fail-closed：queryEvidence/listProvenance/getEvent 对 JSON.parse、完整 policy
 *   校验、文件名/body eventId 一致、分区 provenance 一致、tenantScope 一致逐一验证，
 *   任一损坏抛固定 practice_store_corrupt_event（附稳定 code，不含原始内容/路径/字段值），
 *   绝不返回 policy-invalid body、绝不静默跳过；非普通文件条目（目录/链接）继续忽略；
 * - 持久化显式白名单复制（不 spread 原始事件）：未知顶层/嵌套键一律丢弃，防止
 *   rawTask/rawToolOutput/extraSecret 等类型外字段绕过 policy 扫描落盘；
 * - production evidence query（queryEvidence）只读 real 分区并过滤 tombstone，
 *   绝不包含 evaluation/synthetic/shadow。
 *
 * 本模块不实现：Activation 更新、procedure compiler、runtime promotion、宿主 API；
 * append 的 source/attribution 完整校验由 policy 层负责（Store 不越权复制）。
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import { validatePracticeEvent } from "../policy/index.ts";
import type { PolicyResult } from "../policy/index.ts";

export const PRACTICE_SCHEMA_VERSION = 1;
export const ACCEPTED_SENSITIVITY = "none";
export const ACCEPTED_RETENTION_CLASS = "project_manual";

/** provenance 白名单（目录名取自白名单枚举，非用户输入）。 */
export const PROVENANCES = ["real", "shadow", "evaluation", "synthetic"] as const;
export type StoreProvenance = (typeof PROVENANCES)[number];

/** eventId 白名单字符（拒绝 "/"、"\\"、控制字符等 path traversal 载荷）。 */
export const EVENT_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

/** tenantScope 长度上限（内容一律 hash 化）。 */
const MAX_TENANT_LENGTH = 256;

export interface PracticeStoreOptions {
  /** store 根目录（project-local，如 <project>/.skill-cortex/practice）。 */
  rootDir: string;
  /** 项目根（project-local 强制基准）：默认 process.cwd()。rootDir 必须位于其内。 */
  projectRoot?: string;
}

/** tombstone 记录：只含删除审计元数据，绝不含事件本体（无敏感内容）。 */
export interface TombstoneRecord {
  eventId: string;
  provenance: StoreProvenance;
  invalidatedAt: string;
  reason: "explicit_delete";
}

export interface DeleteResult {
  /** 真实存在且被删除/已 tombstone 的 event ids（供 Activation/Profile/Procedure 级联失效）。 */
  invalidatedEventIds: string[];
}

function isErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as NodeJS.ErrnoException).code === code;
}

/** 校验“可写入/可读取”的权限语义字段（未知字段保留但不改变权限语义）。 */
function assertValidStoredEvent(raw: unknown): asserts raw is PracticeEvent {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("PracticeEvent must be an object");
  }
  const event = raw as Record<string, unknown>;
  if (event.schemaVersion !== PRACTICE_SCHEMA_VERSION) {
    throw new Error(
      `PracticeEvent.schemaVersion must be ${PRACTICE_SCHEMA_VERSION}, got: ${String(event.schemaVersion)}`,
    );
  }
  if (event.sensitivity !== ACCEPTED_SENSITIVITY) {
    throw new Error(`PracticeEvent.sensitivity must be "none", got: ${String(event.sensitivity)}`);
  }
  if (event.retentionClass !== ACCEPTED_RETENTION_CLASS) {
    throw new Error(
      `PracticeEvent.retentionClass must be "project_manual", got: ${String(event.retentionClass)}`,
    );
  }
  if (typeof event.provenance !== "string" || !(PROVENANCES as readonly string[]).includes(event.provenance)) {
    throw new Error(`PracticeEvent.provenance must be one of ${PROVENANCES.join("/")}`);
  }
  if (typeof event.eventId !== "string" || !EVENT_ID_RE.test(event.eventId)) {
    throw new Error(`PracticeEvent.eventId is invalid: ${String(event.eventId)}`);
  }
  if (typeof event.tenantScope !== "string" || event.tenantScope.length === 0 || event.tenantScope.length > MAX_TENANT_LENGTH) {
    throw new Error("PracticeEvent.tenantScope must be a non-empty string (≤ 256 chars)");
  }
}

/** 固定错误码（不含原始内容/绝对路径/字段值）。 */
function corruptEvent(code: string): never {
  throw new Error(`practice_store_corrupt_event: ${code}`);
}

/**
 * 读取侧 fail-closed 校验（证据库损坏必须可见，不得静默跳过/回显）：
 * 1. JSON.parse（失败时不回显原始解析错误——Node 错误消息可能含内容片段）；
 * 2. 完整 validatePracticeEvent（坏 nested enum/短 sourceHash 等全部暴露）；
 * 3. 文件名 eventId 与 body eventId 一致；
 * 4. 分区 provenance 与 body provenance 一致；
 * 5. 调用 tenantScope 与 body tenantScope 一致；
 * 6. store 边界（policy 不覆盖的 eventId ≤200 / tenantScope ≤256）。
 * 任一损坏抛 practice_store_corrupt_event（附稳定 code）。
 */
function parseStoredEvent(
  text: string,
  fileEventId: string,
  tenantScope: string,
  provenance: StoreProvenance,
): PracticeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    corruptEvent("json_parse");
  }
  if (typeof parsed !== "object" || parsed === null) {
    corruptEvent("not_object");
  }
  const event = parsed as Record<string, unknown>;
  const policyResult = validatePracticeEvent(event);
  if (!policyResult.ok) {
    corruptEvent(`policy_${policyResult.issues.map((i) => i.code).join("+")}`);
  }
  if (event.eventId !== fileEventId) corruptEvent("event_id_mismatch");
  if (event.provenance !== provenance) corruptEvent("provenance_mismatch");
  if (event.tenantScope !== tenantScope) corruptEvent("tenant_scope_mismatch");
  if (typeof event.eventId !== "string" || !EVENT_ID_RE.test(event.eventId)) {
    corruptEvent("event_id_too_long");
  }
  if (typeof event.tenantScope !== "string" || event.tenantScope.length > MAX_TENANT_LENGTH) {
    corruptEvent("tenant_scope_too_long");
  }
  return normalizeForPersistence(parsed as PracticeEvent, policyResult);
}

/**
 * “child 位于 parent 内”判定（Windows path.relative 原生大小写无关；非字符串前缀）。
 */
function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child).replaceAll("\\", "/");
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith("../");
}

/** 稳定安全 hash：目录名绝不包含原始 tenant 字符串。 */
function tenantDir(rootDir: string, tenantScope: string): string {
  const hash = createHash("sha256").update(tenantScope, "utf8").digest("hex");
  return path.join(rootDir, hash);
}

function partitionDir(rootDir: string, tenantScope: string, provenance: StoreProvenance): string {
  return path.join(tenantDir(rootDir, tenantScope), provenance);
}

function eventFilePath(
  rootDir: string,
  tenantScope: string,
  provenance: StoreProvenance,
  eventId: string,
): string {
  return path.join(partitionDir(rootDir, tenantScope, provenance), `${eventId}.json`);
}

function claimFilePath(rootDir: string, tenantScope: string, eventId: string): string {
  return path.join(tenantDir(rootDir, tenantScope), "claims", `${eventId}.json`);
}

function tombstoneFilePath(rootDir: string, tenantScope: string, eventId: string): string {
  return path.join(tenantDir(rootDir, tenantScope), "tombstones", `${eventId}.json`);
}

async function existsFile(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function readJsonFilesIn(
  dir: string,
  context: { tenantScope: string; provenance: StoreProvenance },
): Promise<Array<{ eventId: string; parsed: PracticeEvent }>> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return [];
    throw error;
  }
  const entries: Array<{ eventId: string; parsed: PracticeEvent }> = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(dir, file);
    // 仅读普通文件：目录/链接等异常条目跳过（不影响其他事件；防 EISDIR 中断查询）
    let stat: Stats;
    try {
      stat = await lstat(filePath);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    const eventId = file.slice(0, -".json".length);
    const text = await readFile(filePath, "utf8");
    // fail-closed：任一损坏抛 practice_store_corrupt_event（不跳过、不回显）
    const parsed = parseStoredEvent(text, eventId, context.tenantScope, context.provenance);
    entries.push({ eventId, parsed });
  }
  entries.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  return entries;
}

async function loadTombstoneIds(rootDir: string, tenantScope: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const dir = path.join(tenantDir(rootDir, tenantScope), "tombstones");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return ids;
    throw error;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    ids.add(file.slice(0, -".json".length));
  }
  return ids;
}

/**
 * 用 policy 计算的 attribution/failureClass/firstAttributableFailureStepId 正规化事件
 * （不信任 caller 字段）；undefined 的 firstAttributableFailureStepId 真正省略（不落键）。
 */
/**
 * 显式白名单复制（不 spread 原始事件）：所有顶层必需/可选合同字段逐项复制；
 * step/auth/guard/verifier/dependencyFingerprint 元素同样逐项白名单复制，未知顶层键
 * 与嵌套键全部丢弃（调用方无法以类型外字段绕过 policy 扫描落盘）。
 * attribution/failureClass/firstAttributableFailureStepId 使用 policy 计算值；
 * 无失败信号且 computed failureClass=unknown 时省略 optional failureClass 以最小化
 * 落盘数据（unknown 无信息量；非 unknown 失败类必须保留）。
 */
function normalizeForPersistence(event: PracticeEvent, result: PolicyResult): PracticeEvent {
  const stepSummaries: PracticeEvent["stepSummaries"] = event.stepSummaries.map((s) => ({
    stepId: s.stepId,
    actor: s.actor,
    operationClass: s.operationClass,
    outcome: s.outcome,
  }));
  const authorizationResults: PracticeEvent["authorizationResults"] = event.authorizationResults.map(
    (a) => ({ gateId: a.gateId, result: a.result }),
  );
  const guardResults: PracticeEvent["guardResults"] = event.guardResults.map((g) => ({
    predicateId: g.predicateId,
    phase: g.phase,
    result: g.result,
  }));
  const verifierResults: PracticeEvent["verifierResults"] = event.verifierResults.map((v) => ({
    verifierId: v.verifierId,
    result: v.result,
    ...(v.observedEffect !== undefined ? { observedEffect: v.observedEffect } : {}),
  }));
  const dependencyFingerprint: PracticeEvent["dependencyFingerprint"] =
    event.dependencyFingerprint === undefined
      ? undefined
      : {
          sourceHash: event.dependencyFingerprint.sourceHash,
          ...(event.dependencyFingerprint.toolSchemaHash !== undefined
            ? { toolSchemaHash: event.dependencyFingerprint.toolSchemaHash }
            : {}),
          ...(event.dependencyFingerprint.permissionPolicyHash !== undefined
            ? { permissionPolicyHash: event.dependencyFingerprint.permissionPolicyHash }
            : {}),
          ...(event.dependencyFingerprint.environmentClass !== undefined
            ? { environmentClass: event.dependencyFingerprint.environmentClass }
            : {}),
          ...(event.dependencyFingerprint.modelId !== undefined
            ? { modelId: event.dependencyFingerprint.modelId }
            : {}),
          ...(event.dependencyFingerprint.promptHash !== undefined
            ? { promptHash: event.dependencyFingerprint.promptHash }
            : {}),
        };

  const normalized: PracticeEvent = {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    tenantScope: event.tenantScope,
    provenance: event.provenance,
    parentSkillId: event.parentSkillId,
    parentSkillRevision: event.parentSkillRevision,
    sourceHash: event.sourceHash,
    candidateSkillIds: [...event.candidateSkillIds],
    selectedSkillIds: [...event.selectedSkillIds],
    executionMode: event.executionMode,
    redactedTaskFeatures: [...event.redactedTaskFeatures],
    stepSummaries,
    authorizationResults,
    guardResults,
    verifierResults,
    attribution: result.attribution,
    sensitivity: event.sensitivity,
    retentionClass: event.retentionClass,
    ...(event.routeDecisionId !== undefined ? { routeDecisionId: event.routeDecisionId } : {}),
    ...(event.procedureId !== undefined ? { procedureId: event.procedureId } : {}),
    ...(event.environmentFingerprint !== undefined
      ? { environmentFingerprint: event.environmentFingerprint }
      : {}),
    ...(dependencyFingerprint !== undefined ? { dependencyFingerprint } : {}),
  };
  const failureClass = result.failureClass;
  if (failureClass !== "unknown") {
    // 非 unknown 失败类（如 tool_failure）承载授权/守卫/verifier/step 语义，必须保留
    normalized.failureClass = failureClass;
  }
  if (result.firstAttributableFailureStepId !== undefined) {
    normalized.firstAttributableFailureStepId = result.firstAttributableFailureStepId;
  }
  return normalized;
}

export class PracticeStore {
  readonly rootDir: string;
  readonly projectRoot: string;
  #initPromise?: Promise<void>;

  constructor(options: PracticeStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    // 词法校验（同步、构造即拒绝）：rootDir 必须位于 projectRoot 内，禁止 ../ 外部路径。
    if (!isPathInside(this.projectRoot, this.rootDir)) {
      throw new Error(
        `PracticeStore.rootDir must be inside projectRoot (${this.projectRoot}): ${this.rootDir}`,
      );
    }
  }

  /** 首次 I/O 前初始化：realpath 校验（防 symlink/junction 逃逸）+ 创建 rootDir。 */
  #ensureInit(): Promise<void> {
    this.#initPromise ??= this.#init();
    return this.#initPromise;
  }

  async #init(): Promise<void> {
    let realProject: string;
    try {
      realProject = await realpath(this.projectRoot);
    } catch {
      throw new Error(`projectRoot does not exist or is not accessible: ${this.projectRoot}`);
    }

    // 找 rootDir 链上最近已存在祖先的 realpath：若已存在的部分（可能含 symlink/junction）
    // 已逃出 projectRoot，立即拒绝——不在外部创建任何目录。
    let probe = this.rootDir;
    let realProbe: string | undefined;
    while (realProbe === undefined) {
      try {
        await lstat(probe);
        realProbe = await realpath(probe);
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) {
          const parent = path.dirname(probe);
          if (parent === probe) break;
          probe = parent;
          continue;
        }
        throw error;
      }
    }
    if (realProbe !== undefined && !isPathInside(realProject, realProbe)) {
      throw new Error(
        `PracticeStore.rootDir resolves outside projectRoot (${this.projectRoot}): ${this.rootDir}`,
      );
    }

    await mkdir(this.rootDir, { recursive: true });
    let realRoot: string;
    try {
      realRoot = await realpath(this.rootDir);
    } catch {
      throw new Error(`rootDir cannot be resolved: ${this.rootDir}`);
    }
    if (!isPathInside(realProject, realRoot)) {
      throw new Error(
        `PracticeStore.rootDir resolves outside projectRoot (${this.projectRoot}): ${this.rootDir}`,
      );
    }
  }

  /**
   * 追加事件（append-only）：
   * 1. policy gate（validatePracticeEvent，在任何 mkdir/write 前；拒绝时抛稳定错误码摘要，
   *    只含 issue.code、不回显原始敏感值，调用方无法绕过 policy）；
   * 2. store 准入白名单（eventId 字符、tenant 长度、provenance 枚举等 policy 不覆盖项）；
   * 3. 持久化使用 policy 正规化的 attribution/failureClass/firstAttributableFailureStepId；
   * 4. claims seam（wx，tenant 内跨分区全局唯一）→ 分区事件文件（wx）。
   */
  async append(event: PracticeEvent): Promise<void> {
    const policyResult = validatePracticeEvent(event);
    if (!policyResult.ok) {
      const codes = policyResult.issues.map((issue) => issue.code).join(",");
      throw new Error(`practice_event_rejected: ${codes}`);
    }
    assertValidStoredEvent(event);
    const persisted = normalizeForPersistence(event, policyResult);
    await this.#ensureInit();

    const claimPath = claimFilePath(this.rootDir, persisted.tenantScope, persisted.eventId);
    await mkdir(path.dirname(claimPath), { recursive: true });
    try {
      const claim = {
        eventId: persisted.eventId,
        provenance: persisted.provenance,
        claimedAt: new Date().toISOString(),
      };
      await writeFile(claimPath, JSON.stringify(claim), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (isErrnoCode(error, "EEXIST")) {
        throw new Error(
          `PracticeEvent eventId already exists in tenant (globally unique per tenant, deleted ids are not reused): ${persisted.eventId}`,
        );
      }
      throw error;
    }

    // claim 已仲裁跨分区唯一；分区文件 wx 双保险（若失败 claim 保留，ID 不静默复用）。
    const filePath = eventFilePath(
      this.rootDir,
      persisted.tenantScope,
      persisted.provenance,
      persisted.eventId,
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(persisted), { encoding: "utf8", flag: "wx" });
  }

  /**
   * 原始读取（跨四分区查找，过滤 tombstone；删除后返回 undefined）。
   * production evidence query 请使用 queryEvidence。
   */
  async getEvent(tenantScope: string, eventId: string): Promise<PracticeEvent | undefined> {
    if (!EVENT_ID_RE.test(eventId)) {
      throw new Error(`eventId is invalid: ${eventId}`);
    }
    await this.#ensureInit();
    if ((await loadTombstoneIds(this.rootDir, tenantScope)).has(eventId)) {
      return undefined;
    }
    for (const provenance of PROVENANCES) {
      const filePath = eventFilePath(this.rootDir, tenantScope, provenance, eventId);
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) continue;
        throw error;
      }
      const parsed = parseStoredEvent(raw, eventId, tenantScope, provenance);
      return parsed;
    }
    return undefined;
  }

  /**
   * production evidence query：只读 real 分区，并过滤 tombstone。
   * 绝不包含 evaluation/synthetic/shadow。结果按 eventId 字典序（确定性）。
   */
  async queryEvidence(tenantScope: string): Promise<PracticeEvent[]> {
    await this.#ensureInit();
    const tombstones = await loadTombstoneIds(this.rootDir, tenantScope);
    const entries = await readJsonFilesIn(partitionDir(this.rootDir, tenantScope, "real"), {
      tenantScope,
      provenance: "real",
    });
    return entries
      .filter(({ eventId }) => !tombstones.has(eventId))
      .map(({ parsed }) => parsed);
  }

  /**
   * 列出某分区的全部事件（过滤 tombstone；测试/审计用）。
   */
  async listProvenance(tenantScope: string, provenance: StoreProvenance): Promise<PracticeEvent[]> {
    await this.#ensureInit();
    const tombstones = await loadTombstoneIds(this.rootDir, tenantScope);
    const entries = await readJsonFilesIn(partitionDir(this.rootDir, tenantScope, provenance), {
      tenantScope,
      provenance,
    });
    return entries
      .filter(({ eventId }) => !tombstones.has(eventId))
      .map(({ parsed }) => parsed);
  }

  /**
   * explicit deletion seam：
   * 事务顺序：定位事件 provenance → 先以 wx 写 tombstone（审计必先于删除，无
   * “事件已删但 tombstone 写失败、以后无法审计”的窗口）→ 再物理删除事件本体；
   * 若 rm 失败，tombstone 已使查询隐藏，错误上抛，重试仍尝试物理删除（幂等）。
   * claim 保留（删除后 ID 不得复用）；DeleteResult 只返回真实存在且被删除/已
   * tombstone 的 ids；不存在的 id 不制造虚假 evidence invalidation。
   */
  async invalidate(tenantScope: string, eventIds: readonly string[]): Promise<DeleteResult> {
    await this.#ensureInit();
    const invalidatedEventIds: string[] = [];
    for (const eventId of eventIds) {
      if (!EVENT_ID_RE.test(eventId)) {
        throw new Error(`eventId is invalid: ${eventId}`);
      }

      // 1) 定位事件 provenance（claim 保证跨分区唯一，至多一个分区有该事件）
      let foundProvenance: StoreProvenance | undefined;
      let foundFilePath: string | undefined;
      for (const provenance of PROVENANCES) {
        const filePath = eventFilePath(this.rootDir, tenantScope, provenance, eventId);
        if (await existsFile(filePath)) {
          foundProvenance = provenance;
          foundFilePath = filePath;
          break;
        }
      }

      const tombstonePath = tombstoneFilePath(this.rootDir, tenantScope, eventId);
      const tombstoneExists = await existsFile(tombstonePath);

      if (foundProvenance !== undefined || tombstoneExists) {
        // 2) 先写 tombstone（wx；已存在则幂等跳过）——审计标记先于物理删除
        if (!tombstoneExists) {
          const record: TombstoneRecord = {
            eventId,
            provenance: foundProvenance ?? "real",
            invalidatedAt: new Date().toISOString(),
            reason: "explicit_delete",
          };
          await mkdir(path.dirname(tombstonePath), { recursive: true });
          await writeFile(tombstonePath, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
        }
        // 3) 再物理删除事件本体；失败时 tombstone 已隐藏查询，错误上抛供重试
        if (foundFilePath !== undefined) {
          await rm(foundFilePath, { force: true });
        }
        invalidatedEventIds.push(eventId);
      }
    }
    return { invalidatedEventIds };
  }
}
