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
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  buildInjectionBlock,
  clampTopK,
  createDiscoveryServices,
  mapSkills,
  runSearchTool,
  type AdapterState,
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
