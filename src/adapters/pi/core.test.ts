/**
 * src/adapters/pi/core.ts 测试（node:test，仅 node 内置模块 + 项目内模块）。
 *
 * 覆盖：clampTopK、mapSkills 映射（declared* 空/不推断）、摄入+检索（有界、disable 过滤、
 * 失败 fail-open）、注入块边界（Top-K、选择说明、不出现全量）、search_skills（未初始化/
 * 构建失败诊断、limit 边界、空查询、有界）。
 *
 * 临时数据：mkdtemp 于项目根（project-local），after() 用 fs/promises.rm 清理。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  buildInjectionBlock,
  clampTopK,
  createDiscoveryServices,
  mapSkills,
  MAX_SKILL_MD_BYTES,
  runLoadSkill,
  runSearchTool,
  type AdapterState,
  type LoadableSkill,
} from "./core.ts";
import type { HostSkillLike, HostToolResultLike } from "./host.ts";

/** 断言辅助：把窄接口的 details: unknown 具象化为 search_skills 返回形状。 */
interface SearchToolDetails {
  ready: boolean;
  category?: string;
  query?: string;
  count?: number;
  matches: unknown[];
}

function detailsOf(result: HostToolResultLike): SearchToolDetails {
  return result.details as SearchToolDetails;
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const tempDirs: string[] = [];

/** 提取注入文本中出现的 docx-* 名字（去重）；顺序无关断言用。 */
function extractedNames(text: string): string[] {
  return [...new Set(text.match(/docx-[a-l]/g) ?? [])];
}

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-adapter-test-"));
  tempDirs.push(dir);
  return dir;
}

/** 构造真实文件系统上的宿主 Skill（含 SKILL.md，供 Registry 摄入）。 */
function makeSkill(overrides: Partial<HostSkillLike> & { skillMd?: string } = {}): HostSkillLike {
  const root = makeTempDir();
  writeFileSync(path.join(root, "SKILL.md"), overrides.skillMd ?? "# Fixture\n\ndefault body\n");
  return {
    name: overrides.name ?? "fixture-skill",
    description: overrides.description ?? "A fixture skill used by adapter tests.",
    filePath: path.join(root, "SKILL.md"),
    baseDir: root,
    sourceInfo: { scope: overrides.sourceInfo?.scope ?? "user" },
    disableModelInvocation: overrides.disableModelInvocation ?? false,
  };
}

/** 构造 N 个同名族 skill（name=docx-<letter>），query "docx" 可全部召回。 */
function makeDocxFamily(count: number): HostSkillLike[] {
  return Array.from({ length: count }, (_, i) =>
    makeSkill({
      name: `docx-${String.fromCharCode(97 + i)}`,
      description: `Creates and reads Word docx files, variant ${i}.`,
    }),
  );
}

describe("clampTopK", () => {
  it("undefined → 默认 5", () => {
    assert.equal(clampTopK(undefined), 5);
  });
  it("<1 / 非有限 → 1（与 discovery clampLimit 语义一致）", () => {
    assert.equal(clampTopK(0), 1);
    assert.equal(clampTopK(-3), 1);
    assert.equal(clampTopK(Number.NaN), 1);
    assert.equal(clampTopK(Number.POSITIVE_INFINITY), 1);
  });
  it(">MAX → 10；非整数 → 向下取整", () => {
    assert.equal(clampTopK(100), 10);
    assert.equal(clampTopK(3.7), 3);
  });
});

describe("mapSkills", () => {
  it("映射宿主 Skill 字段；declared* 一律空数组，不推断", () => {
    const skill = makeSkill({ name: "pdf-tools", disableModelInvocation: true });
    const inputs = mapSkills([skill]);
    assert.equal(inputs.length, 1);
    const input = inputs[0]!;
    assert.equal(input.name, "pdf-tools");
    assert.equal(input.scope, "user");
    assert.equal(input.baseDir, skill.baseDir);
    assert.equal(input.skillMdPath, skill.filePath);
    assert.equal(input.disableModelInvocation, true);
    assert.deepEqual(input.declaredAliases, []);
    assert.deepEqual(input.declaredPermissions, []);
    assert.deepEqual(input.declaredEffects, []);
  });

  it("project/temporary scope 透传", () => {
    const project = makeSkill({ name: "p", description: "project skill" });
    project.sourceInfo = { scope: "project" };
    const temporary = makeSkill({ name: "t", description: "temp skill" });
    temporary.sourceInfo = { scope: "temporary" };
    const inputs = mapSkills([project, temporary]);
    assert.deepEqual(
      inputs.map((i) => i.scope),
      ["project", "temporary"],
    );
  });
});

describe("createDiscoveryServices.run（摄入 + BM25）", () => {
  it("成功：候选有界、recordCount 正确、state.ready", async () => {
    const services = createDiscoveryServices({ topK: 3 });
    const skills = makeDocxFamily(6);
    const outcome = await services.run("docx report", skills);
    assert.equal(outcome.ok, true);
    assert.ok(outcome.candidates.length <= 3);
    assert.equal(outcome.recordCount, 6);
    assert.equal(services.state.ready, true);
    assert.equal(services.state.recordCount, 6);
  });

  it("disableModelInvocation=true 被过滤（不进 Registry、不进候选）", async () => {
    const services = createDiscoveryServices({ topK: 5 });
    const family = makeDocxFamily(3);
    family[0]!.disableModelInvocation = true; // docx-a 被过滤
    const outcome = await services.run("docx", family);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.recordCount, 2);
    assert.ok(!outcome.candidates.some((c) => c.name === "docx-a"));
  });

  it("失败 fail-open：ok=false、state 不可用、lastErrorCategory 为稳定类别（脱敏）", async () => {
    const services = createDiscoveryServices({ topK: 3 });
    // 非法 skill：baseDir 下无 SKILL.md → Registry 拒绝
    const badRoot = makeTempDir();
    const bad = {
      name: "broken",
      description: "broken skill",
      filePath: path.join(badRoot, "SKILL.md"),
      baseDir: badRoot,
      sourceInfo: { scope: "user" as const },
      disableModelInvocation: false,
    };
    const outcome = await services.run("anything", [bad]);
    assert.equal(outcome.ok, false);
    assert.ok(outcome.error !== undefined);
    assert.equal(outcome.candidates.length, 0);
    assert.equal(services.state.ready, false);
    assert.equal(services.state.lastErrorCategory, "skill_ingest_failed");
  });

  it("错误脱敏：敏感绝对路径不进入 lastErrorCategory 与 search_skills 诊断（原始 error 仅留在 outcome.error）", async () => {
    const sensitiveDir = path.join(PROJECT_ROOT, ".secret-victim", "docx");
    const services = createDiscoveryServices({ topK: 3 });
    const bad: HostSkillLike = {
      name: "secret-skill",
      description: "broken",
      filePath: path.join(sensitiveDir, "SKILL.md"),
      baseDir: sensitiveDir,
      sourceInfo: { scope: "user" },
      disableModelInvocation: false,
    };
    const outcome = await services.run("anything", [bad]);
    assert.equal(outcome.ok, false);
    assert.equal(services.state.lastErrorCategory, "skill_ingest_failed");
    assert.ok(outcome.error instanceof Error, "原始 error 供 onError 本地处理");

    const result = runSearchTool(services.state, { query: "docx" });
    const text = result.content[0]!.text;
    assert.ok(!text.includes(".secret-victim"), "诊断不得泄漏敏感绝对路径");
    assert.ok(!text.includes("SKILL.md"), "诊断不得泄漏文件名");
    assert.ok(!text.includes("Desktop"), "诊断不得泄漏目录结构");
  });
});

describe("buildInjectionBlock", () => {
  it("含边界说明、选择说明（single/multi/no-skill）、有界候选", async () => {
    const services = createDiscoveryServices({ topK: 3 });
    const outcome = await services.run("docx", makeDocxFamily(6));
    const block = buildInjectionBlock(outcome.candidates, 3);
    assert.match(block, /≤ 3/);
    assert.match(block, /Single skill/);
    assert.match(block, /Multi-skill/);
    assert.match(block, /No-skill/);
    assert.match(block, /完整 catalog 不在上下文中/);
    assert.match(block, /search_skills/);
    // 顺序无关：注入文本中出现的名字必须是检索候选的子集，且 ≤ topK（绝不出现候选之外/全量）
    const candidateNames = new Set(outcome.candidates.map((c) => c.name));
    const shown = extractedNames(block);
    assert.ok(shown.length > 0 && shown.length <= 3, `注入应是有界 Top-K，实际 ${shown.length}`);
    assert.ok(shown.every((name) => candidateNames.has(name)), "注入文本不得出现候选之外的 skill 名");
  });

  it("空候选：仍给 no-skill 说明，不注入任何 skill 名", () => {
    const block = buildInjectionBlock([], 3);
    assert.match(block, /no matching skills/);
    assert.match(block, /No-skill/);
    assert.ok(!block.includes("docx-"));
  });
});

describe("runSearchTool（search_skills 执行逻辑）", () => {
  it("未初始化：有界诊断（ready=false），不 throw、不给候选", () => {
    const state: AdapterState = { ready: false, recordCount: 0 };
    const result = runSearchTool(state, { query: "docx" });
    const details = detailsOf(result);
    assert.equal(details.ready, false);
    assert.equal(details.category, "not_initialized");
    assert.match(result.content[0]!.text, /尚未初始化/);
  });

  it("构建失败：诊断只含稳定类别（脱敏），不给候选", () => {
    const state: AdapterState = {
      ready: false,
      recordCount: 0,
      lastErrorCategory: "skill_ingest_failed",
    };
    const result = runSearchTool(state, { query: "docx" });
    const details = detailsOf(result);
    assert.equal(details.ready, false);
    assert.equal(details.category, "skill_ingest_failed");
    assert.match(result.content[0]!.text, /skill_ingest_failed/);
  });

  it("正常：候选有界（≤ limit），limit 超界被 clamp", async () => {
    const services = createDiscoveryServices({ topK: 10 });
    await services.run("docx", makeDocxFamily(6));
    const r1 = runSearchTool(services.state, { query: "docx", limit: 100 });
    assert.equal(detailsOf(r1).ready, true);
    assert.ok(detailsOf(r1).matches.length <= 10);
    const r2 = runSearchTool(services.state, { query: "docx", limit: 2 });
    assert.ok(detailsOf(r2).matches.length <= 2);
    const r3 = runSearchTool(services.state, { query: "docx", limit: 0 });
    assert.ok(detailsOf(r3).matches.length <= 1);
  });

  it("空查询：返回空候选，绝不返回全量", async () => {
    const services = createDiscoveryServices({ topK: 10 });
    await services.run("docx", makeDocxFamily(4));
    const result = runSearchTool(services.state, { query: "   " });
    const details = detailsOf(result);
    assert.equal(details.count, 0);
    assert.deepEqual(details.matches, []);
  });
});

/** runLoadSkill 测试辅助：load_skill 返回的 details 形状。 */
interface LoadDetails {
  ready: boolean;
  category?: string;
  name?: string;
  scope?: string;
  source_hash?: string;
  bytes?: number;
}

function loadDetailsOf(result: HostToolResultLike): LoadDetails {
  return result.details as LoadDetails;
}

function loadText(result: HostToolResultLike): string {
  return result.content[0]!.text;
}

/** 从成功摄入的 catalog 中取指定 name 的 skill_id/skill_revision。 */
function loadParams(state: AdapterState, name: string): { skill_id: string; skill_revision: string } {
  const entry = [...(state.catalog?.values() ?? [])].find((e) => e.record.name === name);
  assert.ok(entry, `catalog 必须包含 ${name}`);
  return { skill_id: entry.record.skillId, skill_revision: entry.record.skillRevision };
}

/** 用单个 fixture skill 摄入，返回 services（state 已含 catalog）。 */
async function ingestOne(name: string, opts: { skillMd?: string } = {}): Promise<{
  services: ReturnType<typeof createDiscoveryServices>;
  skill: HostSkillLike;
}> {
  const skill = makeSkill({ name, skillMd: opts.skillMd });
  const services = createDiscoveryServices({ topK: 5 });
  await services.run(name, [skill]);
  return { services, skill };
}

describe("runLoadSkill（load_skill 执行）", () => {
  it("成功：返回 SKILL.md 正文 + 最小 provenance（name/scope/revision），content 不泄漏绝对路径", async () => {
    const { services, skill } = await ingestOne("pdf", { skillMd: "# PDF\n\nmerge and read PDF documents.\n" });
    const params = loadParams(services.state, "pdf");
    const result = await runLoadSkill(services.state, params);
    assert.equal(loadDetailsOf(result).category, "ok");
    assert.equal(loadDetailsOf(result).name, "pdf");
    assert.equal(loadDetailsOf(result).scope, "user");
    const text = loadText(result);
    assert.match(text, /merge and read PDF documents\./);
    assert.ok(!text.includes(skill.baseDir), "content 不得泄漏绝对路径");
    assert.ok(!text.includes(skill.filePath), "content 不得泄漏 sourceLocator 绝对路径");
  });

  it("成功 details 返回 source_hash（内容指纹 sha256:…，非路径/正文/declared*）", async () => {
    const { services, skill } = await ingestOne("hash-skill", { skillMd: "# hash\n\nfingerprint\n" });
    const entry = [...services.state.catalog!.values()].find((e) => e.record.name === "hash-skill")!;
    const params = loadParams(services.state, "hash-skill");
    const result = await runLoadSkill(services.state, params);
    const details = loadDetailsOf(result);
    assert.equal(details.category, "ok");
    assert.equal(details.source_hash, entry.record.sourceHash);
    assert.match(details.source_hash!, /^sha256:[0-9a-f]{64}$/);
    const rest = JSON.stringify(details);
    assert.ok(!rest.includes(skill.baseDir), "details 不得泄漏绝对路径");
    assert.ok(!rest.includes(skill.filePath), "details 不得泄漏 sourceLocator");
    assert.ok(!rest.includes("declaredPermissions") && !rest.includes("declaredEffects"), "details 不得携带 declared*");
  });

  it("未初始化 → not_initialized；摄入失败 → ingest_failed（fail closed）", async () => {
    const fresh: AdapterState = { ready: false, recordCount: 0 };
    const notInit = await runLoadSkill(fresh, { skill_id: "skill:x", skill_revision: "rev:y" });
    assert.equal(loadDetailsOf(notInit).category, "not_initialized");

    const failed: AdapterState = { ready: false, recordCount: 0, lastErrorCategory: "skill_ingest_failed" };
    const ingestFailed = await runLoadSkill(failed, { skill_id: "skill:x", skill_revision: "rev:y" });
    assert.equal(loadDetailsOf(ingestFailed).category, "ingest_failed");
  });

  it("unknown skill_id → unknown_skill", async () => {
    const { services } = await ingestOne("pdf");
    const result = await runLoadSkill(services.state, { skill_id: "skill:unknown", skill_revision: "rev:whatever" });
    assert.equal(loadDetailsOf(result).category, "unknown_skill");
  });

  it("revision 不匹配 → revision_mismatch", async () => {
    const { services } = await ingestOne("pdf");
    const params = loadParams(services.state, "pdf");
    const result = await runLoadSkill(services.state, { skill_id: params.skill_id, skill_revision: "rev:wrong" });
    assert.equal(loadDetailsOf(result).category, "revision_mismatch");
  });

  it("catalog 重建后旧 revision 拒绝（源变化 → 新 revision）", async () => {
    const { services, skill } = await ingestOne("pdf", { skillMd: "# PDF\n\nv1\n" });
    const oldParams = loadParams(services.state, "pdf");
    writeFileSync(skill.filePath, "# PDF\n\nv2\n");
    await services.run("pdf", [skill]);
    const result = await runLoadSkill(services.state, oldParams);
    assert.equal(loadDetailsOf(result).category, "revision_mismatch");
  });

  it("source drift（文件内容变化但未重建）→ source_drift", async () => {
    const { services, skill } = await ingestOne("pdf", { skillMd: "# PDF\n\nv1\n" });
    const params = loadParams(services.state, "pdf");
    const ok = await runLoadSkill(services.state, params);
    assert.equal(loadDetailsOf(ok).category, "ok");
    writeFileSync(skill.filePath, "# PDF\n\ntampered\n");
    const drift = await runLoadSkill(services.state, params);
    assert.equal(loadDetailsOf(drift).category, "source_drift");
  });

  it("大小超限 → size_exceeded", async () => {
    const { services, skill } = await ingestOne("big-skill");
    writeFileSync(skill.filePath, "x".repeat(MAX_SKILL_MD_BYTES + 1));
    await services.run("big-skill", [skill]);
    const params = loadParams(services.state, "big-skill");
    const result = await runLoadSkill(services.state, params);
    assert.equal(loadDetailsOf(result).category, "size_exceeded");
  });

  it("大小边界：恰好 MAX_SKILL_MD_BYTES 可通过（边界不含误杀）", async () => {
    const { services, skill } = await ingestOne("boundary-skill");
    writeFileSync(skill.filePath, "y".repeat(MAX_SKILL_MD_BYTES));
    await services.run("boundary-skill", [skill]);
    const params = loadParams(services.state, "boundary-skill");
    const result = await runLoadSkill(services.state, params);
    assert.equal(loadDetailsOf(result).category, "ok");
    assert.equal(loadDetailsOf(result).bytes, MAX_SKILL_MD_BYTES);
  });

  it("dependency drift：scripts 摄入后变化（SKILL.md 未变）→ revision_drift", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "SKILL.md"), "# dep-skill\n\nbody\n");
    const scriptDir = path.join(root, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "util.js"), "// v1\n");
    const skill: HostSkillLike = {
      name: "dep-skill",
      description: "dependency drift skill",
      filePath: path.join(root, "SKILL.md"),
      baseDir: root,
      sourceInfo: { scope: "user" },
      disableModelInvocation: false,
    };
    const services = createDiscoveryServices({ topK: 5 });
    await services.run("dep-skill", [skill]);
    const params = loadParams(services.state, "dep-skill");

    // 摄入后未变化：ok。
    const ok = await runLoadSkill(services.state, params);
    assert.equal(loadDetailsOf(ok).category, "ok");

    // 只改 scripts（不动 SKILL.md）：完整 manifest 重算 → 缓存 revision 失效。
    writeFileSync(path.join(scriptDir, "util.js"), "// v2\n");
    const drift = await runLoadSkill(services.state, params);
    assert.equal(loadDetailsOf(drift).category, "revision_drift");
    assert.match(loadText(drift), /revision drift/);
  });

  it("dependency drift：references 文件被删除 → revision_drift（fail closed）", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "SKILL.md"), "# ref-skill\n\nbody\n");
    const refDir = path.join(root, "references");
    mkdirSync(refDir, { recursive: true });
    const refPath = path.join(refDir, "guide.md");
    writeFileSync(refPath, "guide v1\n");
    const skill: HostSkillLike = {
      name: "ref-skill",
      description: "reference drift skill",
      filePath: path.join(root, "SKILL.md"),
      baseDir: root,
      sourceInfo: { scope: "user" },
      disableModelInvocation: false,
    };
    const services = createDiscoveryServices({ topK: 5 });
    await services.run("ref-skill", [skill]);
    const params = loadParams(services.state, "ref-skill");

    await rm(refPath, { force: true });
    const drift = await runLoadSkill(services.state, params);
    assert.equal(loadDetailsOf(drift).category, "revision_drift");
  });

  it("权限边界：load_skill 只读 SKILL.md，不执行 scripts、不返回脚本内容/declared*", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "SKILL.md"), "# perm-skill\n\nbody only\n");
    const scriptDir = path.join(root, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    // 若被任何路径执行会写出标记文件（本实现只读 SKILL.md，脚本永不执行）。
    writeFileSync(
      path.join(scriptDir, "side-effect.js"),
      `require("fs").writeFileSync(require("path").join(__dirname, "ran"), "x")`,
    );
    const skill: HostSkillLike = {
      name: "perm-skill",
      description: "permission boundary skill",
      filePath: path.join(root, "SKILL.md"),
      baseDir: root,
      sourceInfo: { scope: "user" },
      disableModelInvocation: false,
    };
    const services = createDiscoveryServices({ topK: 5 });
    await services.run("perm-skill", [skill]);
    const params = loadParams(services.state, "perm-skill");

    const result = await runLoadSkill(services.state, params);
    assert.equal(loadDetailsOf(result).category, "ok");
    const text = loadText(result);
    assert.match(text, /body only/);
    assert.ok(!text.includes("side-effect"), "content 不得返回 scripts 内容");
    assert.ok(!text.includes("writeFileSync"), "content 不得包含脚本正文");
    const rest = JSON.stringify(loadDetailsOf(result));
    assert.ok(!rest.includes("declaredPermissions") && !rest.includes("declaredEffects"), "details 不得携带权限/effect");
    assert.ok(!existsSync(path.join(scriptDir, "ran")), "load_skill 不得执行脚本");
  });

  it("非 UTF-8 → encoding_failed", async () => {
    const { services, skill } = await ingestOne("bin-skill");
    writeFileSync(skill.filePath, Buffer.from([0xff, 0xfe, 0x80, 0x81]));
    await services.run("bin-skill", [skill]);
    const params = loadParams(services.state, "bin-skill");
    const result = await runLoadSkill(services.state, params);
    assert.equal(loadDetailsOf(result).category, "encoding_failed");
  });

  it("SKILL.md 被删除 → path_failure", async () => {
    const { services, skill } = await ingestOne("del-skill");
    const params = loadParams(services.state, "del-skill");
    await rm(skill.filePath, { force: true });
    const result = await runLoadSkill(services.state, params);
    assert.equal(loadDetailsOf(result).category, "path_failure");
  });

  it("sourceLocator 非绝对路径 → path_failure（防御分支）", async () => {
    const { services } = await ingestOne("rel-skill");
    const entry = [...services.state.catalog!.values()].find((e) => e.record.name === "rel-skill")!;
    const badRecord = { ...entry.record, sourceLocator: "relative/SKILL.md" };
    const state: AdapterState = {
      ready: true,
      recordCount: 1,
      catalog: new Map([[badRecord.skillId, { record: badRecord, baseDir: entry.baseDir }]]),
    };
    const result = await runLoadSkill(state, { skill_id: badRecord.skillId, skill_revision: badRecord.skillRevision });
    assert.equal(loadDetailsOf(result).category, "path_failure");
  });

  it("symlink/junction 逃逸 → path_failure（Windows 无权限则跳过）", async (t) => {
    const { services, skill } = await ingestOne("link-skill");
    const external = makeSkill({ name: "external-skill", skillMd: "# External\n" });
    const params = loadParams(services.state, "link-skill");
    await rm(skill.filePath, { force: true });
    try {
      symlinkSync(external.filePath, skill.filePath, "file");
    } catch {
      t.skip("当前环境无 symlink 权限（与本套件既有 skip 一致）");
      return;
    }
    const result = await runLoadSkill(services.state, params);
    assert.equal(loadDetailsOf(result).category, "path_failure");
  });
});
