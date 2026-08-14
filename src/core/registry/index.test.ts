/**
 * Workstream A：Skill Registry 测试（node:test，仅 node 内置模块）。
 *
 * 覆盖（按 Phase 1 任务要求）：
 *  1. 同输入 ID/revision/manifest 确定（含注入 now 的完全确定）
 *  2. 同名不同 scope/path ⇒ 不同 skillId
 *  3. 内容变化 ⇒ skillRevision / sourceHash 变化
 *  4. disableModelInvocation 被过滤
 *  5. manifest 排序与角色（含根目录非角色文件排除、子目录递归）
 *  6. 作者未声明 permissions/effects/aliases ⇒ 空数组
 *  7. move/rename ⇒ 新实例（不同 skillId；内容级 sourceHash/revision 保持）
 *
 * 附加守卫：哈希已知向量、ID/revision/hash 格式、SKILL.md 缺失/相对 baseDir 拒绝、
 * 不落盘文件内容、根目录 LICENSE/README 不进入 manifest、空角色目录无条目。
 *
 * 测试临时数据：mkdtemp 于项目根（project-local），after() 统一清理。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  buildSkillCatalog,
  buildSkillRecord,
  computeSkillId,
  computeSkillRevision,
  computeSourceHash,
  enumerateManifest,
  isMissingDirectoryError,
  isPathInside,
  normalizePath,
  serializeManifest,
  sha256Hex,
} from "./index.ts";
import type { SkillPackageInput } from "./types.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) {
    // 注：此环境（Windows sandbox）下同步 fs.rmSync({recursive}) 静默失效，
    // 必须用 fs.promises.rm 才能确保删除（已实测验证）。
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-registry-test-"));
  tempDirs.push(dir);
  return dir;
}

interface FixtureFiles {
  skillMd?: string;
  scripts?: Record<string, string>;
  references?: Record<string, string>;
  assets?: Record<string, string>;
  templates?: Record<string, string>;
  /** 根目录额外文件（不应进入 manifest）。 */
  extraRoot?: Record<string, string>;
}

/** 创建 skill fixture 树，返回 skill 根目录（绝对路径）。 */
function createSkillFixture(files: FixtureFiles = {}): string {
  const root = makeTempDir();
  writeFileSync(path.join(root, "SKILL.md"), files.skillMd ?? "# Fixture Skill\n\ndefault body\n");
  for (const [sub, roleFiles] of [
    ["scripts", files.scripts],
    ["references", files.references],
    ["assets", files.assets],
    ["templates", files.templates],
  ] as const) {
    if (!roleFiles) continue;
    for (const [rel, content] of Object.entries(roleFiles)) {
      const full = path.join(root, sub, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  if (files.extraRoot) {
    for (const [name, content] of Object.entries(files.extraRoot)) {
      writeFileSync(path.join(root, name), content);
    }
  }
  return root;
}

function inputFor(root: string, overrides: Partial<SkillPackageInput> = {}): SkillPackageInput {
  return {
    name: "fixture-skill",
    description: "A fixture skill for registry tests.",
    scope: "user",
    baseDir: root,
    ...overrides,
  };
}

/** 探测本环境能否创建 Windows junction（普通用户可创建，无需提权）。 */
function probeJunction(): boolean {
  const root = makeTempDir();
  const target = path.join(root, "probe-target");
  mkdirSync(target, { recursive: true });
  const link = path.join(root, "probe-link");
  try {
    symlinkSync(target, link, "junction");
    return true;
  } catch {
    return false;
  }
}

/** 探测本环境能否创建文件级 symlink（Windows 需开发者模式/管理员）。 */
function probeFileSymlink(): boolean {
  const root = makeTempDir();
  const target = path.join(root, "probe-file");
  writeFileSync(target, "x");
  const link = path.join(root, "probe-link");
  try {
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

// 环境能力探测：junction 无需提权；文件 symlink 需要开发者模式/管理员。
const JUNCTION_SUPPORTED = probeJunction();
const FILE_SYMLINK_SUPPORTED = probeFileSymlink();

const SKIP_NO_JUNCTION = JUNCTION_SUPPORTED
  ? false
  : "junction 创建不可用（跳过；不伪通过）";
const SKIP_NO_FILE_SYMLINK = FILE_SYMLINK_SUPPORTED
  ? false
  : "文件 symlink 创建不可用（需开发者模式/管理员，本环境 EPERM；不伪通过）";

const FIXED_NOW = new Date("2026-08-14T00:00:00.000Z");

describe("sha256Hex / normalizePath（哈希基元）", () => {
  it("已知 SHA-256 向量（空串与 abc）", () => {
    assert.equal(
      sha256Hex(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    assert.equal(
      sha256Hex("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("normalizePath 是幂等的（确定、可重复）", () => {
    const p = path.join(PROJECT_ROOT, "Some", "Skill", "Dir");
    assert.equal(normalizePath(p), normalizePath(normalizePath(p)));
    assert.ok(!normalizePath(p).includes("\\"), "反斜杠必须转换为正斜杠");
  });

  it("Windows：路径大小写变体得到同一规范化结果", { skip: process.platform !== "win32" }, () => {
    assert.equal(normalizePath("C:\\Skills\\Docx"), normalizePath("c:\\skills\\docx"));
    assert.equal(normalizePath("C:/Skills/Docx"), normalizePath("c:\\skills\\docx"));
  });
});

describe("computeSkillId", () => {
  it("格式为 skill:<64 hex>，同输入确定", () => {
    const id = computeSkillId("user", path.join(PROJECT_ROOT, "skills", "docx"));
    assert.match(id, /^skill:[0-9a-f]{64}$/);
    assert.equal(id, computeSkillId("user", path.join(PROJECT_ROOT, "skills", "docx")));
  });

  it("同名不同 scope ⇒ 不同 skillId", () => {
    const dir = path.join(PROJECT_ROOT, "skills", "docx");
    const a = computeSkillId("user", dir);
    const b = computeSkillId("project", dir);
    const c = computeSkillId("temporary", dir);
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.notEqual(b, c);
  });

  it("同名同 scope 不同 baseDir ⇒ 不同 skillId", () => {
    const a = computeSkillId("user", path.join(PROJECT_ROOT, "a", "docx"));
    const b = computeSkillId("user", path.join(PROJECT_ROOT, "b", "docx"));
    assert.notEqual(a, b);
  });

  it("Windows：大小写变体 baseDir 得到同一 skillId", { skip: process.platform !== "win32" }, () => {
    assert.equal(
      computeSkillId("user", "C:\\Skills\\Docx"),
      computeSkillId("user", "c:\\skills\\docx"),
    );
  });
});

describe("computeSourceHash / computeSkillRevision", () => {
  it("sourceHash 格式 sha256:<64 hex>；内容变化则变化", () => {
    const h1 = computeSourceHash(new TextEncoder().encode("v1"));
    const h2 = computeSourceHash(new TextEncoder().encode("v2"));
    assert.match(h1, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(h1, h2);
  });

  it("serializeManifest 冻结格式：按 (role, locator) 排序、\u0000 分隔、\\n 连接", () => {
    const entries = [
      { role: "script" as const, locator: "scripts/a.py", contentHash: "aa".repeat(32) },
      { role: "instruction" as const, locator: "SKILL.md", contentHash: "bb".repeat(32) },
      { role: "asset" as const, locator: "templates/t.md", contentHash: "cc".repeat(32) },
    ];
    assert.equal(
      serializeManifest(entries),
      [
        `asset\u0000templates/t.md\u0000${"cc".repeat(32)}`,
        `instruction\u0000SKILL.md\u0000${"bb".repeat(32)}`,
        `script\u0000scripts/a.py\u0000${"aa".repeat(32)}`,
      ].join("\n"),
    );
  });

  it("skillRevision 格式 rev:<64 hex>；顺序无关但条目不同则不同", () => {
    const e1 = [
      { role: "script" as const, locator: "scripts/a.py", contentHash: "aa".repeat(32) },
      { role: "instruction" as const, locator: "SKILL.md", contentHash: "bb".repeat(32) },
    ];
    const rev = computeSkillRevision(e1);
    assert.match(rev, /^rev:[0-9a-f]{64}$/);
    assert.equal(rev, computeSkillRevision([...e1].reverse())); // 排序在内部完成
    assert.notEqual(
      rev,
      computeSkillRevision([{ role: "script" as const, locator: "scripts/b.py", contentHash: "aa".repeat(32) }]),
    );
  });
});

describe("buildSkillRecord", () => {
  it("同输入（注入 now）产生完全相同的记录", async () => {
    const root = createSkillFixture({ scripts: { "run.py": "print(1)" } });
    const input = inputFor(root);
    const r1 = await buildSkillRecord(input, { now: FIXED_NOW });
    const r2 = await buildSkillRecord(input, { now: FIXED_NOW });
    assert.deepEqual(r1, r2);
  });

  it("不同 now 只影响 discoveredAt，不影响身份/版本/指纹/manifest", async () => {
    const root = createSkillFixture();
    const input = inputFor(root);
    const r1 = await buildSkillRecord(input, { now: FIXED_NOW });
    const r2 = await buildSkillRecord(input, { now: new Date("2030-01-01T00:00:00.000Z") });
    assert.equal(r1.skillId, r2.skillId);
    assert.equal(r1.skillRevision, r2.skillRevision);
    assert.equal(r1.sourceHash, r2.sourceHash);
    assert.deepEqual(r1.dependencyManifest, r2.dependencyManifest);
    assert.notEqual(r1.discoveredAt, r2.discoveredAt);
    assert.equal(r2.discoveredAt, "2030-01-01T00:00:00.000Z");
  });

  it("记录字段形状与格式（scope 保留、schemaVersion、哈希格式）", async () => {
    const root = createSkillFixture();
    const record = await buildSkillRecord(inputFor(root, { scope: "project" }), { now: FIXED_NOW });
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.scope, "project");
    assert.match(record.skillId, /^skill:[0-9a-f]{64}$/);
    assert.match(record.skillRevision, /^rev:[0-9a-f]{64}$/);
    assert.match(record.sourceHash, /^sha256:[0-9a-f]{64}$/);
    for (const entry of record.dependencyManifest) {
      assert.match(entry.contentHash, /^[0-9a-f]{64}$/);
    }
  });

  it("SKILL.md 缺失 ⇒ 拒绝", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "notes.txt"), "no skill here");
    await assert.rejects(buildSkillRecord(inputFor(root)), /SKILL\.md/);
  });

  it("相对 baseDir ⇒ 拒绝", async () => {
    await assert.rejects(
      buildSkillRecord(inputFor("relative/skill/dir")),
      /absolute/,
    );
  });

  it("空 name / description、非法 scope ⇒ 拒绝", async () => {
    const root = createSkillFixture();
    await assert.rejects(buildSkillRecord(inputFor(root, { name: "  " })), /name/);
    await assert.rejects(buildSkillRecord(inputFor(root, { description: "" })), /description/);
    await assert.rejects(
      buildSkillRecord(inputFor(root, { scope: "everywhere" as never })),
      /scope/,
    );
  });

  it("作者未声明 permissions/effects/aliases ⇒ 空数组；显式声明则原样保留", async () => {
    const root = createSkillFixture();
    const record = await buildSkillRecord(inputFor(root), { now: FIXED_NOW });
    assert.deepEqual(record.declaredAliases, []);
    assert.deepEqual(record.declaredPermissions, []);
    assert.deepEqual(record.declaredEffects, []);

    const declared = await buildSkillRecord(
      inputFor(root, {
        declaredAliases: ["word", "docs"],
        declaredPermissions: ["read:project"],
        declaredEffects: ["write:tmp"],
      }),
      { now: FIXED_NOW },
    );
    assert.deepEqual(declared.declaredAliases, ["word", "docs"]);
    assert.deepEqual(declared.declaredPermissions, ["read:project"]);
    assert.deepEqual(declared.declaredEffects, ["write:tmp"]);
  });

  it("不落盘文件内容、秘密或原始输出", async () => {
    const secret = "TOP-SECRET-BODY-CONTENT-42";
    const root = createSkillFixture({ skillMd: `# X\n\n${secret}\n`, scripts: { "run.py": secret } });
    const record = await buildSkillRecord(inputFor(root), { now: FIXED_NOW });
    const json = JSON.stringify(record);
    assert.ok(!json.includes(secret), "记录不得包含任何文件正文/秘密");
    assert.ok(!json.includes("print("), "记录不得包含脚本内容");
  });
});

describe("manifest：角色与排序", () => {
  it("按冻结角色枚举；子目录递归；根目录非角色文件排除；稳定排序", async () => {
    const root = createSkillFixture({
      skillMd: "# Docx\n\nbody\n",
      scripts: { "a.py": "a", "nested/b.py": "b" },
      references: { "api.md": "api" },
      assets: { "logo.png": "png" },
      templates: { "tmpl.md": "tmpl" },
      extraRoot: { "README.md": "readme", "LICENSE.txt": "license" },
    });
    const record = await buildSkillRecord(inputFor(root), { now: FIXED_NOW });

    const expected = [
      { locator: "assets/logo.png", role: "asset" },
      { locator: "templates/tmpl.md", role: "asset" },
      { locator: "SKILL.md", role: "instruction" },
      { locator: "references/api.md", role: "reference" },
      { locator: "scripts/a.py", role: "script" },
      { locator: "scripts/nested/b.py", role: "script" },
    ];
    assert.deepEqual(
      record.dependencyManifest.map(({ locator, role }) => ({ locator, role })),
      expected,
    );

    // contentHash = 对应文件字节的完整 SHA-256
    for (const entry of record.dependencyManifest) {
      const abs = entry.role === "instruction" ? path.join(root, "SKILL.md") : path.join(root, entry.locator);
      assert.equal(entry.contentHash, sha256Hex(readFileSync(abs)));
    }
    // 排除项不得出现
    const locators = record.dependencyManifest.map((e) => e.locator);
    assert.ok(!locators.includes("README.md"));
    assert.ok(!locators.includes("LICENSE.txt"));
  });

  it("空/缺失角色目录产生 0 条（仅 instruction）", async () => {
    const root = createSkillFixture({ scripts: {} }); // 空 scripts 目录
    const record = await buildSkillRecord(inputFor(root), { now: FIXED_NOW });
    assert.equal(record.dependencyManifest.length, 1);
    assert.equal(record.dependencyManifest[0].locator, "SKILL.md");
    assert.equal(record.dependencyManifest[0].role, "instruction");
    assert.match(record.dependencyManifest[0].contentHash, /^[0-9a-f]{64}$/);
  });

  it("enumerateManifest 排序确定（两次调用一致）", async () => {
    const root = createSkillFixture({ scripts: { "z.py": "1", "a.py": "2" }, references: { "r.md": "3" } });
    const m1 = await enumerateManifest(root);
    const m2 = await enumerateManifest(root);
    assert.deepEqual(m1, m2);
    assert.deepEqual(
      m1.map((e) => e.locator),
      ["references/r.md", "scripts/a.py", "scripts/z.py"],
    );
  });
});

describe("内容变化 ⇒ revision/sourceHash 变化", () => {
  it("SKILL.md 内容变化 ⇒ sourceHash 与 skillRevision 都变化", async () => {
    const root = createSkillFixture({ skillMd: "v1" });
    const before = await buildSkillRecord(inputFor(root), { now: FIXED_NOW });
    writeFileSync(path.join(root, "SKILL.md"), "v2");
    const after = await buildSkillRecord(inputFor(root), { now: FIXED_NOW });
    assert.notEqual(after.sourceHash, before.sourceHash);
    assert.notEqual(after.skillRevision, before.skillRevision);
    assert.equal(after.skillId, before.skillId); // 身份不受内容影响
  });

  it("仅脚本内容变化 ⇒ skillRevision 变化、sourceHash 不变", async () => {
    const root = createSkillFixture({ skillMd: "v1", scripts: { "run.py": "print(1)" } });
    const before = await buildSkillRecord(inputFor(root), { now: FIXED_NOW });
    writeFileSync(path.join(root, "scripts", "run.py"), "print(2)");
    const after = await buildSkillRecord(inputFor(root), { now: FIXED_NOW });
    assert.equal(after.sourceHash, before.sourceHash);
    assert.notEqual(after.skillRevision, before.skillRevision);
  });
});

describe("disableModelInvocation 过滤", () => {
  it("buildSkillCatalog 过滤 disableModelInvocation=true，保留其余与 scope", async () => {
    const rootA = createSkillFixture();
    const rootB = createSkillFixture();
    const rootC = createSkillFixture();
    const records = await buildSkillCatalog(
      [
        inputFor(rootA, { name: "enabled-a", scope: "project" }),
        inputFor(rootB, { name: "disabled-b", disableModelInvocation: true }),
        inputFor(rootC, { name: "enabled-c", scope: "temporary" }),
      ],
      { now: FIXED_NOW },
    );
    assert.deepEqual(
      records.map((r) => [r.name, r.scope]),
      [
        ["enabled-a", "project"],
        ["enabled-c", "temporary"],
      ],
    );
  });
});

describe("isMissingDirectoryError（纯函数）", () => {
  it("ENOENT ⇒ true", () => {
    const e = new Error("missing") as NodeJS.ErrnoException;
    e.code = "ENOENT";
    assert.equal(isMissingDirectoryError(e), true);
  });

  it("EACCES / EPERM / EIO / ENOTDIR ⇒ false（必须抛出，不得静默跳过）", () => {
    for (const code of ["EACCES", "EPERM", "EIO", "ENOTDIR"]) {
      const e = new Error(code) as NodeJS.ErrnoException;
      e.code = code;
      assert.equal(isMissingDirectoryError(e), false, code);
    }
  });

  it("非 Errno 值 ⇒ false", () => {
    assert.equal(isMissingDirectoryError(null), false);
    assert.equal(isMissingDirectoryError(undefined), false);
    assert.equal(isMissingDirectoryError("ENOENT"), false);
    assert.equal(isMissingDirectoryError({}), false);
    assert.equal(isMissingDirectoryError(new Error("no code")), false);
  });
});

describe("isPathInside（纯函数）", () => {
  const base = path.join(PROJECT_ROOT, "skills", "docx");

  it("子路径 ⇒ true", () => {
    assert.equal(isPathInside(base, path.join(base, "SKILL.md")), true);
  });

  it("同路径 ⇒ true", () => {
    assert.equal(isPathInside(base, base), true);
  });

  it("../ 逃逸与 baseDir 外路径 ⇒ false", () => {
    assert.equal(isPathInside(base, path.join(base, "..", "other", "SKILL.md")), false);
    assert.equal(isPathInside(base, path.join(PROJECT_ROOT, "outside", "SKILL.md")), false);
    assert.equal(isPathInside(base, path.resolve(base, "..")), false);
  });

  it("名称以 .. 开头的子目录仍为内部", () => {
    assert.equal(isPathInside(base, path.join(base, "..hidden", "SKILL.md")), true);
  });

  it("Windows：大小写变体 ⇒ true（大小写无关包含）", { skip: process.platform !== "win32" }, () => {
    assert.equal(isPathInside(base, path.join(base.toLowerCase(), "skill.md")), true);
  });
});

describe("buildSkillRecord：skillMdPath 校验", () => {
  it("相对 skillMdPath ⇒ 拒绝", async () => {
    const root = createSkillFixture();
    await assert.rejects(buildSkillRecord(inputFor(root, { skillMdPath: "SKILL.md" })), /absolute/);
  });

  it("baseDir 之外（独立目录）的 skillMdPath ⇒ 拒绝", async () => {
    const root = createSkillFixture();
    const outside = makeTempDir();
    writeFileSync(path.join(outside, "SKILL.md"), "# outside\n");
    await assert.rejects(
      buildSkillRecord(inputFor(root, { skillMdPath: path.join(outside, "SKILL.md") })),
      /inside baseDir/,
    );
  });

  it("../ 逃逸形式的 skillMdPath ⇒ 拒绝", async () => {
    const root = createSkillFixture();
    const sibling = makeTempDir();
    writeFileSync(path.join(sibling, "SKILL.md"), "# sibling\n");
    await assert.rejects(
      buildSkillRecord(
        inputFor(root, { skillMdPath: path.join(root, "..", path.basename(sibling), "SKILL.md") }),
      ),
      /inside baseDir/,
    );
  });

  it("显式 baseDir 内 skillMdPath ⇒ 接受", async () => {
    const root = createSkillFixture();
    const record = await buildSkillRecord(
      inputFor(root, { skillMdPath: path.join(root, "SKILL.md") }),
      { now: FIXED_NOW },
    );
    assert.equal(record.sourceLocator, path.join(root, "SKILL.md").replaceAll("\\", "/"));
  });

  it("Windows：大小写变体 skillMdPath（仍在 baseDir 内）⇒ 接受", { skip: process.platform !== "win32" }, async () => {
    const root = createSkillFixture();
    const record = await buildSkillRecord(inputFor(root, { skillMdPath: path.join(root, "skill.md") }), {
      now: FIXED_NOW,
    });
    assert.match(record.sourceHash, /^sha256:[0-9a-f]{64}$/);
  });
});

describe("manifest：非 ENOENT 错误不得静默跳过", () => {
  it("顶层角色目录被普通文件占用 ⇒ buildSkillRecord 拒绝", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "SKILL.md"), "# ok\n");
    writeFileSync(path.join(root, "scripts"), "i am a file, not a dir");
    await assert.rejects(buildSkillRecord(inputFor(root)), /not a directory/);
  });
});

describe("symlink/junction 安全", () => {
  it("SKILL.md 为 junction（指向 baseDir 外）⇒ 拒绝", { skip: SKIP_NO_JUNCTION }, async () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    writeFileSync(path.join(outside, "SKILL.md"), "# outside\n");
    symlinkSync(outside, path.join(root, "SKILL.md"), "junction");
    await assert.rejects(buildSkillRecord(inputFor(root)), /symlink or junction/);
  });

  it("SKILL.md 为 junction（指向 baseDir 内）⇒ 同样拒绝（链接一律拒绝）", { skip: SKIP_NO_JUNCTION }, async () => {
    const root = makeTempDir();
    const inner = path.join(root, "inner");
    mkdirSync(inner);
    writeFileSync(path.join(inner, "SKILL.md"), "# inner\n");
    symlinkSync(inner, path.join(root, "SKILL.md"), "junction");
    await assert.rejects(buildSkillRecord(inputFor(root)), /symlink or junction/);
  });

  it("SKILL.md 为文件 symlink ⇒ 拒绝", { skip: SKIP_NO_FILE_SYMLINK }, async () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    writeFileSync(path.join(outside, "SKILL.md"), "# outside\n");
    symlinkSync(path.join(outside, "SKILL.md"), path.join(root, "SKILL.md"));
    await assert.rejects(buildSkillRecord(inputFor(root)), /symlink or junction/);
  });

  it("角色目录（scripts）为 junction 指向外部 ⇒ 忽略，外部文件不进 manifest", { skip: SKIP_NO_JUNCTION }, async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "SKILL.md"), "# ok\n");
    const outside = makeTempDir();
    writeFileSync(path.join(outside, "evil.py"), "external");
    symlinkSync(outside, path.join(root, "scripts"), "junction");
    const record = await buildSkillRecord(inputFor(root), { now: FIXED_NOW });
    assert.equal(record.dependencyManifest.length, 1);
    assert.equal(record.dependencyManifest[0]!.locator, "SKILL.md");
  });

  it("角色目录内 junction 子目录 ⇒ 忽略（链接忽略策略保持）", { skip: SKIP_NO_JUNCTION }, async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "SKILL.md"), "# ok\n");
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "scripts", "real.py"), "ok");
    const outside = makeTempDir();
    writeFileSync(path.join(outside, "evil.py"), "external");
    symlinkSync(outside, path.join(root, "scripts", "junc"), "junction");
    const record = await buildSkillRecord(inputFor(root), { now: FIXED_NOW });
    const locators = record.dependencyManifest.map((e) => e.locator);
    assert.ok(locators.includes("scripts/real.py"));
    assert.ok(!locators.includes("scripts/junc/evil.py"));
  });

  it("baseDir 为 junction 指向真实 skill 目录 ⇒ 允许（SKILL.md realpath 在 realBaseDir 内）", { skip: SKIP_NO_JUNCTION }, async () => {
    const realDir = makeTempDir();
    writeFileSync(path.join(realDir, "SKILL.md"), "# linked\n");
    const linkDir = path.join(path.dirname(realDir), `lnk-${path.basename(realDir)}`);
    symlinkSync(realDir, linkDir, "junction");
    try {
      const record = await buildSkillRecord(inputFor(linkDir), { now: FIXED_NOW });
      assert.equal(record.name, "fixture-skill");
      assert.match(record.sourceHash, /^sha256:[0-9a-f]{64}$/);
    } finally {
      await rm(linkDir, { recursive: true, force: true }); // 清理 junction 本身
    }
  });
});

describe("move/rename 语义", () => {
  it("同内容不同 baseDir ⇒ 新 skillId；内容级 sourceHash/revision/manifest 一致", async () => {
    const content = "# Docx\n\nsame\n";
    const rootA = createSkillFixture({ skillMd: content, scripts: { "run.py": "print(1)" } });
    const rootB = createSkillFixture({ skillMd: content, scripts: { "run.py": "print(1)" } });
    const a = await buildSkillRecord(inputFor(rootA), { now: FIXED_NOW });
    const b = await buildSkillRecord(inputFor(rootB), { now: FIXED_NOW });
    assert.notEqual(a.skillId, b.skillId, "move/rename ⇒ 新实例（新 skillId）");
    assert.equal(a.sourceHash, b.sourceHash, "内容指纹不变");
    assert.equal(a.skillRevision, b.skillRevision, "相对 manifest 不变 ⇒ revision 不变");
    assert.deepEqual(a.dependencyManifest, b.dependencyManifest);
    assert.notEqual(a.sourceLocator, b.sourceLocator);
  });
});
