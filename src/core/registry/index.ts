/**
 * Skill Cortex — Workstream A：Skill Registry
 *
 * 从明确的 Skill package 输入生成不可变 SkillRecord（数据合同 §4.1）。
 * 身份/版本/指纹算法冻结于 Phase 0 baseline §3（宿主不提供任何稳定 ID/hash）：
 *
 * - skillId        = "skill:" + sha256( scope + "\u0000" + normalize(baseDir) )
 * - sourceHash     = "sha256:" + sha256( SKILL.md 原始字节 )
 * - skillRevision  = "rev:" + sha256( 稳定序列化的 dependency manifest )
 * - manifest 条目 contentHash = 完整 SHA-256（64 hex，无前缀）
 *
 * normalize(p) = NFKC → toLowerCase → path.resolve → 反斜杠转 "/"（Windows 规范化确定）。
 *
 * dependencyManifest 仅按冻结角色枚举：
 *   SKILL.md → instruction；scripts/** → script；references/** → reference；
 *   assets/** 与 templates/** → asset。
 * locator 一律为相对 skill 根的 "/" 分隔路径；条目按 (role, locator) 稳定排序。
 *
 * 安全边界：
 * - declaredAliases/Permissions/Effects 只接收调用方显式解析的作者声明，不做任何推断。
 * - 不保存文件内容、秘密或原始工具输出，仅保存哈希与元数据。
 * - 符号链接一律忽略（避免目录逃逸与遍历顺序不确定性）。
 * - skillMdPath 必须为绝对路径，且解析后必须位于 baseDir 内（path.relative 判定，
 *   Windows 大小写兼容）；禁止 ../ 或 baseDir 外 SKILL.md。
 * - manifest 枚举仅在顶层角色目录确实不存在（ENOENT）时跳过；
 *   EACCES/EPERM/EIO/ENOTDIR 等错误一律抛出，不得静默形成不完整 revision。
 * - move/rename 视为新安装实例：baseDir 变化 ⇒ 新 skillId（派生数据不得错误继承）。
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import type { SkillRecord, SkillScope } from "../contracts/index.ts";
import type { BuildSkillRecordOptions, SkillPackageInput } from "./types.ts";

export type { BuildSkillRecordOptions, SkillPackageInput } from "./types.ts";
export type { SkillRecord, SkillScope } from "../contracts/index.ts";

export const SKILL_ID_PREFIX = "skill:";
export const SKILL_REVISION_PREFIX = "rev:";
export const SOURCE_HASH_PREFIX = "sha256:";

/** 唯一 instruction 条目，locator 固定为 "SKILL.md"。 */
export const INSTRUCTION_LOCATOR = "SKILL.md";

export type ManifestRole = "instruction" | "script" | "reference" | "asset";

/** 与 SkillRecord.dependencyManifest 条目一致的最小形状。 */
export interface DependencyEntry {
  /** 相对 skill 根的 "/" 分隔路径。 */
  locator: string;
  /** 文件字节的完整 SHA-256（64 hex，无前缀）。 */
  contentHash: string;
  role: ManifestRole;
}

/** 冻结角色 → 顶层目录映射（顺序不影响结果，条目最终按 (role, locator) 排序）。 */
const ROLE_DIRS: ReadonlyArray<{ dir: string; role: "script" | "reference" | "asset" }> = [
  { dir: "scripts", role: "script" },
  { dir: "references", role: "reference" },
  { dir: "assets", role: "asset" },
  { dir: "templates", role: "asset" },
];

const VALID_SCOPES: readonly SkillScope[] = ["project", "user", "temporary"];

/** 完整 SHA-256，64 hex。输入可为字节或字符串（字符串按 UTF-8 编码）。 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Windows 确定的路径规范化：NFKC → toLowerCase → path.resolve → 反斜杠转 "/"。
 * 输入应为绝对路径（buildSkillRecord 会校验）。
 */
export function normalizePath(p: string): string {
  return path.resolve(p.normalize("NFKC").toLowerCase()).replaceAll("\\", "/");
}

/** skillId = "skill:" + sha256(scope + "\u0000" + normalize(baseDir))。 */
export function computeSkillId(scope: SkillScope, baseDir: string): string {
  return SKILL_ID_PREFIX + sha256Hex(scope + "\u0000" + normalizePath(baseDir));
}

/** sourceHash = "sha256:" + sha256(SKILL.md 原始字节)。内容指纹，不承担 revision 身份语义。 */
export function computeSourceHash(skillMdBytes: Uint8Array): string {
  return SOURCE_HASH_PREFIX + sha256Hex(skillMdBytes);
}

/** manifest 条目 contentHash = 完整 SHA-256（64 hex，无前缀）。 */
export function computeContentHash(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/** (role, locator) 字典序稳定比较；不依赖 locale，字节级确定。 */
export function compareManifestEntries(a: DependencyEntry, b: DependencyEntry): number {
  if (a.role !== b.role) return a.role < b.role ? -1 : 1;
  if (a.locator !== b.locator) return a.locator < b.locator ? -1 : 1;
  return 0;
}

/**
 * 稳定序列化 manifest（冻结格式）：
 * 按 (role, locator) 排序后，每行 "role\u0000relpath\u0000contentHash"，行间以 "\n" 连接。
 */
export function serializeManifest(entries: readonly DependencyEntry[]): string {
  return [...entries]
    .sort(compareManifestEntries)
    .map((entry) => `${entry.role}\u0000${entry.locator}\u0000${entry.contentHash}`)
    .join("\n");
}

/** skillRevision = "rev:" + sha256(serializeManifest(entries))。 */
export function computeSkillRevision(entries: readonly DependencyEntry[]): string {
  return SKILL_REVISION_PREFIX + sha256Hex(serializeManifest(entries));
}

/**
 * 递归收集目录下的普通文件（绝对路径）。
 * - 每个目录内按名称排序，保证遍历顺序确定（不受 OS readdir 顺序影响）。
 * - 符号链接一律忽略。
 */
async function collectRegularFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

/** 供包含判断使用的规范化：绝对化；Windows 下小写化以获得大小写无关比较。 */
function resolveForContainment(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Windows 兼容的“child 位于 parent 内”判定（path.relative，非字符串前缀）：
 * - rel === ""（同路径）视为包含；
 * - rel 为 ".." / "../..." 或跨盘绝对路径 ⇒ 外部；
 * - 其余（子路径、含 ".." 前缀的同名子目录如 "..hidden/x"）⇒ 内部。
 */
export function isPathInside(parent: string, child: string): boolean {
  // Windows 上 path.relative 返回反斜杠分隔，先统一为正斜杠再判断。
  const rel = path.relative(resolveForContainment(parent), resolveForContainment(child)).replaceAll("\\", "/");
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith("../");
}

/**
 * 判断错误是否确为“路径不存在”（ENOENT）。纯函数，便于单测。
 * EACCES/EPERM/EIO/ENOTDIR 等一律返回 false —— 调用方必须抛出，
 * 避免把不完整 manifest 静默固化成 revision。
 */
export function isMissingDirectoryError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const errno = error as NodeJS.ErrnoException;
  return errno.code === "ENOENT";
}

/**
 * 顶层角色目录存在性检查：
 * - ENOENT → false（目录不存在，跳过）；
 * - symlink/junction → false（忽略，与 collectRegularFiles 的链接忽略策略一致，防逃逸）；
 * - 普通文件占用 → 抛错（保持“非 ENOENT 必须抛出”语义）；
 * - EACCES/EPERM/EIO 等 → 抛出。
 */
async function roleDirectoryExists(dirPath: string): Promise<boolean> {
  let stat: Stats;
  try {
    stat = await lstat(dirPath);
  } catch (error) {
    if (isMissingDirectoryError(error)) return false;
    throw error;
  }
  if (stat.isSymbolicLink()) return false; // junction 在 Windows 上 lstat.isSymbolicLink() === true（已实测）
  if (stat.isDirectory()) return true;
  throw new Error(`Role directory is not a directory: ${dirPath}`);
}

/**
 * 枚举冻结角色目录（scripts/references/assets/templates）下的依赖条目。
 * 仅当顶层角色目录确实不存在（ENOENT）时跳过；symlink/junction 一律忽略；
 * 嵌套遍历中的任何错误（EACCES/EPERM/EIO/ENOTDIR/ENOENT 竞态）全部向上抛出。
 * 返回条目已按 (role, locator) 排序。instruction（SKILL.md）由 buildSkillRecord 单独加入。
 */
export async function enumerateManifest(baseDir: string): Promise<DependencyEntry[]> {
  const entries: DependencyEntry[] = [];
  for (const { dir, role } of ROLE_DIRS) {
    const dirPath = path.join(baseDir, dir);
    if (!(await roleDirectoryExists(dirPath))) continue;
    const files = await collectRegularFiles(dirPath);
    for (const file of files) {
      // lstat 复核：竞态中新出现的 symlink/junction 或非普通文件一律忽略（保持链接忽略策略）。
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const bytes = await readFile(file);
      entries.push({
        locator: path.relative(baseDir, file).replaceAll("\\", "/"),
        contentHash: sha256Hex(bytes),
        role,
      });
    }
  }
  return entries.sort(compareManifestEntries);
}

/**
 * 由单个 Skill package 输入构建不可变 SkillRecord。
 *
 * 校验：baseDir 必须绝对；name/description 非空；scope 合法；SKILL.md 存在且可读。
 * 不执行任何文件内容推断：declared* 直接透传调用方解析结果（缺省为空数组）。
 */
export async function buildSkillRecord(
  input: SkillPackageInput,
  options: BuildSkillRecordOptions = {},
): Promise<SkillRecord> {
  if (!path.isAbsolute(input.baseDir)) {
    throw new TypeError(`SkillPackageInput.baseDir must be an absolute path, got: ${input.baseDir}`);
  }
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new TypeError("SkillPackageInput.name must be a non-empty string");
  }
  if (typeof input.description !== "string" || input.description.trim() === "") {
    throw new TypeError("SkillPackageInput.description must be a non-empty string");
  }
  if (!VALID_SCOPES.includes(input.scope)) {
    throw new TypeError(`SkillPackageInput.scope must be one of ${VALID_SCOPES.join(", ")}, got: ${input.scope}`);
  }

  // —— baseDir：必须存在（realpath 可解析）；允许为目录或指向目录的链接 ——
  let baseStat: Stats;
  try {
    baseStat = await lstat(input.baseDir);
  } catch {
    throw new Error(`baseDir does not exist or is not accessible: ${input.baseDir}`);
  }
  if (!baseStat.isDirectory() && !baseStat.isSymbolicLink()) {
    throw new Error(`baseDir must be a directory: ${input.baseDir}`);
  }
  let realBaseDir: string;
  try {
    realBaseDir = await realpath(input.baseDir);
  } catch {
    throw new Error(`baseDir cannot be resolved: ${input.baseDir}`);
  }

  const skillMdPath = input.skillMdPath ?? path.join(input.baseDir, INSTRUCTION_LOCATOR);
  if (!path.isAbsolute(skillMdPath)) {
    throw new TypeError(`SkillPackageInput.skillMdPath must be an absolute path, got: ${skillMdPath}`);
  }
  if (!isPathInside(input.baseDir, skillMdPath)) {
    throw new TypeError(
      `SkillPackageInput.skillMdPath must resolve inside baseDir (${input.baseDir}), got: ${skillMdPath}`,
    );
  }

  // —— SKILL.md：常规文件、非 symlink/junction、realpath 不得逃出 realBaseDir ——
  let skillMdStat: Stats;
  try {
    skillMdStat = await lstat(skillMdPath);
  } catch {
    throw new Error(`SKILL.md not found at: ${skillMdPath}`);
  }
  if (skillMdStat.isSymbolicLink()) {
    throw new Error(`SKILL.md must not be a symlink or junction: ${skillMdPath}`);
  }
  if (!skillMdStat.isFile()) {
    throw new Error(`SKILL.md must be a regular file: ${skillMdPath}`);
  }
  let realSkillMd: string;
  try {
    realSkillMd = await realpath(skillMdPath);
  } catch {
    throw new Error(`SKILL.md cannot be resolved: ${skillMdPath}`);
  }
  if (!isPathInside(realBaseDir, realSkillMd)) {
    throw new Error(`SKILL.md must resolve inside baseDir (${input.baseDir}): ${skillMdPath}`);
  }

  let skillMdBytes: Buffer;
  try {
    skillMdBytes = await readFile(skillMdPath);
  } catch {
    throw new Error(`SKILL.md unreadable at: ${skillMdPath}`);
  }

  const roleEntries = await enumerateManifest(input.baseDir);
  const instructionEntry: DependencyEntry = {
    locator: INSTRUCTION_LOCATOR,
    contentHash: sha256Hex(skillMdBytes),
    role: "instruction",
  };
  const manifest = [instructionEntry, ...roleEntries].sort(compareManifestEntries);

  return {
    schemaVersion: 1,
    skillId: computeSkillId(input.scope, input.baseDir),
    skillRevision: computeSkillRevision(manifest),
    name: input.name,
    description: input.description,
    scope: input.scope,
    sourceLocator: path.resolve(skillMdPath).replaceAll("\\", "/"),
    sourceHash: computeSourceHash(skillMdBytes),
    disableModelInvocation: input.disableModelInvocation ?? false,
    declaredAliases: [...(input.declaredAliases ?? [])],
    declaredEffects: [...(input.declaredEffects ?? [])],
    declaredPermissions: [...(input.declaredPermissions ?? [])],
    dependencyManifest: manifest,
    discoveredAt: (options.now ?? new Date()).toISOString(),
  };
}

/**
 * 批量摄入：保留 scope、过滤 disableModelInvocation=true 的 Skill（不进入 Registry，
 * 与 ADR-0007 一致——被禁用的 Skill 不作为 discovery 候选；宿主仍可用 /skill:name 显式调用）。
 * 任一输入不合法会整体拒绝（fail-fast，避免部分注册造成不可归因状态）。
 */
export async function buildSkillCatalog(
  inputs: readonly SkillPackageInput[],
  options: BuildSkillRecordOptions = {},
): Promise<SkillRecord[]> {
  const records: SkillRecord[] = [];
  for (const input of inputs) {
    if (input.disableModelInvocation === true) continue;
    records.push(await buildSkillRecord(input, options));
  }
  return records;
}
