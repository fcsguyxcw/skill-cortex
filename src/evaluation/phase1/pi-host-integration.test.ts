/**
 * B1 host integration 证据：真实 Pi 0.84.1 extension runner 链上的 before_agent_start 集成。
 *
 * 本测试不使用 FakePi。被断言路径全部为宿主真实实现：
 * - `loadExtensions`（dist/core/extensions/loader.js）：用 jiti 实际加载
 *   `.pi/extensions/skill-cortex/index.ts`（真实入口 → registerSkillCortex(pi, { mode: "inject" })）；
 * - `ExtensionRunner.emitBeforeAgentStart`（dist/core/extensions/runner.js）：真实 before_agent_start 链，
 *   捕获最终送入 agent 的 systemPrompt；
 * - `buildSystemPrompt`（dist/core/system-prompt.js）：生成含原生全量 Skill catalog 的 base prompt
 *   （Pi 非 customPrompt 分支，`formatSkillsForPrompt` 精确嵌入）；
 * - `loadSkillsFromDir`（dist/core/skills.js）：从 project-local fixture 解析真实 Skill 文件；
 * - `loadProjectContextFiles`（dist/core/resource-loader.js，DefaultResourceLoader 路径）：加载项目上下文；
 * - `SessionManager.inMemory()` 与 `ModelRegistry`（无网络刷新）作为 runner 的宿主依赖。
 *
 * 断言面：
 * 1) inject 成功：最终 systemPrompt 不再含未选中 Skill 的 name/description/location，
 *    只保留有界 Top-K 卡、选择说明与 CWD；
 * 2) 失败安全回退：原生 block 缺失 / 非唯一 / 摄入失败 → 返回 undefined（宿主保留原 prompt
 *    慢路径），绝不注入 Top-K，绝不产生“全量 + Top-K”混合 prompt；
 * 3) shadow 模式：真实链上不修改 systemPrompt；
 * 4) 多扩展顺序：其他扩展先修改 prompt 时 fail open（当前 0.84.1 加载顺序 project-local 优先，
 *    反向时安全降级为宿主默认），skill-cortex 先执行时结果保留。
 *
 * 约束：不写用户 .pi、不调用外部模型、不创建 PracticeEvent、不修改 production 逻辑。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// 宿主顶层导出（项目锁定 @earendil-works/pi-coding-agent@0.84.1）
import {
  createEventBus,
  formatSkillsForPrompt,
  loadProjectContextFiles,
  loadSkillsFromDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionFactory,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { registerSkillCortex } from "../../adapters/pi/index.ts";
// 宿主内部模块（package exports map 仅 "." / "./rpc-entry" / "./client"，深层路径
// 以项目 node_modules 内已验证 dist 文件的相对文件 URL 导入；仅测试使用）。
import { buildSystemPrompt } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
  loadExtensions,
  ExtensionRunner,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SKILL_CORTEX_ENTRY = path.join(PROJECT_ROOT, ".pi", "extensions", "skill-cortex", "index.ts");

const TOOL_SNIPPETS = {
  read: "Read the contents of a file",
  bash: "Execute bash commands",
  edit: "Edit files",
  write: "Write files",
};

/** 宿主 buildSystemPrompt 可见所需的最小 options（read 工具在场 → skills 块被嵌入）。 */
function buildPromptOptions(
  cwd: string,
  skills: Skill[],
  contextFiles: { path: string; content: string }[],
): Parameters<typeof buildSystemPrompt>[0] {
  return { cwd, skills, contextFiles, toolSnippets: TOOL_SNIPPETS };
}

interface HostFixture {
  root: string;
  skills: Skill[];
  /** docx-a..f 的 filePath（未选中断言目标）。 */
  unselectedPaths: string[];
  basePrompt: string;
  nativeBlock: string;
}

let fixture: HostFixture;
let tempDirs: string[] = [];

before(async () => {
  const root = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-pi-host-fixture-"));
  tempDirs.push(root);
  const names = ["docx-a", "docx-b", "docx-c", "docx-d", "docx-e", "docx-f", "pdf"];
  for (const name of names) {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    const description =
      name === "pdf"
        ? "Read and merge PDF documents."
        : `Creates and reads Word docx files, variant ${name}.`;
    writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody\n`,
    );
  }
  const { skills } = loadSkillsFromDir({ dir: root, source: "user" });
  assert.equal(skills.length, 7, "fixture 必须解析出 7 个真实 Skill");

  // 真实 DefaultResourceLoader 路径：加载项目上下文（agentDir 指向空临时目录，避免读用户级）。
  const emptyAgentDir = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-pi-host-agentdir-"));
  tempDirs.push(emptyAgentDir);
  const contextFiles = loadProjectContextFiles({ cwd: PROJECT_ROOT, agentDir: emptyAgentDir });
  assert.ok(contextFiles.length > 0, "loadProjectContextFiles 必须从项目根找到 AGENTS.md");

  const basePrompt = buildSystemPrompt(buildPromptOptions(PROJECT_ROOT, skills, contextFiles));
  assert.ok(
    basePrompt.includes("<available_skills>"),
    "真实 buildSystemPrompt 必须包含原生全量 Skill catalog block",
  );
  assert.match(basePrompt, /Current working directory: /);

  fixture = {
    root,
    skills,
    unselectedPaths: skills
      .filter((s) => s.name.startsWith("docx-"))
      .map((s) => s.filePath),
    basePrompt,
    nativeBlock: formatSkillsForPrompt(skills),
  };
});

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

/** 构造真实 ExtensionRunner（真实 loader 加载 .pi 扩展 + 真实宿主依赖）。 */
async function makeRunner(extensions: Awaited<ReturnType<typeof loadExtensions>>["extensions"], runtime: ReturnType<typeof createExtensionRuntime>) {
  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
    modelsPath: null,
    authPath: path.join(fixture.root, "auth.json"),
  });
  const sessionManager = SessionManager.inMemory(PROJECT_ROOT);
  return new ExtensionRunner(extensions, runtime, PROJECT_ROOT, sessionManager, new ModelRegistry(modelRuntime));
}

describe("B1 host integration（真实 0.84.1 extension runner 链）", () => {
  it("onDiscovery：真实 runner 链上每次成功摄入触发有界快照（不含 prompt/全量 catalog）", async () => {
    const eventBus = createEventBus();
    const runtime = createExtensionRuntime();
    const snapshots: unknown[] = [];
    const discoveryFactory: ExtensionFactory = (pi) => {
      registerSkillCortex(pi, { mode: "shadow", onDiscovery: (r) => snapshots.push(r) });
    };
    const ext = await loadExtensionFromFactory(
      discoveryFactory,
      PROJECT_ROOT,
      eventBus,
      runtime,
      "<discovery-test>",
    );
    const runner = await makeRunner([ext], runtime);

    const result = await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      fixture.basePrompt,
      buildPromptOptions(PROJECT_ROOT, fixture.skills, []),
    );
    assert.equal(result, undefined, "shadow 模式不修改 systemPrompt");
    assert.equal(snapshots.length, 1, "每次成功摄入必须触发一次 onDiscovery");
    const snap = snapshots[0] as {
      candidates: Array<{ name: string }>;
      recordCount: number;
      topK: number;
      exposedToAgent: boolean;
      deliveryMode: string;
    };
    assert.ok(snap.candidates.length >= 1 && snap.candidates.length <= 5, "快照候选必须是有界 Top-K");
    assert.equal(snap.recordCount, 7, "快照 recordCount 必须等于实际摄入数");
    assert.equal(snap.topK, 5, "快照必须携带本次候选预算");
    assert.equal(snap.exposedToAgent, false, "shadow 模式候选未进入 prompt，必须报告未暴露");
    assert.equal(snap.deliveryMode, "shadow");
    assert.ok(!("prompt" in (snapshots[0] as object)), "快照不得包含原始 prompt");
    assert.ok(!("systemPrompt" in (snapshots[0] as object)), "快照不得包含 systemPrompt");
    const serialized = JSON.stringify(snap);
    for (const fp of fixture.unselectedPaths) {
      assert.ok(!serialized.includes(fp), "快照不得泄漏未选中 Skill 的 location");
    }
    assert.ok(!serialized.includes(fixture.root), "快照不得泄漏 fixture 绝对路径");
  });

  it("onDiscovery：真实链 inject 成功后才报告 exposedToAgent=true；rewrite 失败不产出快照", async () => {
    const eventBus = createEventBus();
    const runtime = createExtensionRuntime();
    const injectSnaps: unknown[] = [];
    const errors: Array<{ context: { phase: string } }> = [];
    const injectFactory: ExtensionFactory = (pi) => {
      registerSkillCortex(pi, {
        mode: "inject",
        onDiscovery: (r) => injectSnaps.push(r),
        onError: (e, c) => errors.push({ context: c }),
      });
    };
    const ext = await loadExtensionFromFactory(injectFactory, PROJECT_ROOT, eventBus, runtime, "<inject-discovery-test>");
    const runner = await makeRunner([ext], runtime);

    // 成功注入：exposedToAgent=true，且只产生一次快照。
    const okResult = await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      fixture.basePrompt,
      buildPromptOptions(PROJECT_ROOT, fixture.skills, []),
    );
    assert.ok(okResult && typeof okResult.systemPrompt === "string", "inject 必须成功");
    assert.equal(injectSnaps.length, 1);
    const okSnap = injectSnaps[0] as { exposedToAgent: boolean; deliveryMode: string };
    assert.equal(okSnap.exposedToAgent, true);
    assert.equal(okSnap.deliveryMode, "inject");
    assert.equal(errors.length, 0);

    // rewrite 失败（block 缺失）：不产出快照，只报 prompt_rewrite 失败。
    const beforeFailure = injectSnaps.length;
    const tampered = fixture.basePrompt.replace(
      fixture.nativeBlock,
      "<available_skills>replaced by another extension</available_skills>",
    );
    const failResult = await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      tampered,
      buildPromptOptions(PROJECT_ROOT, fixture.skills, []),
    );
    assert.equal(failResult, undefined, "rewrite 失败必须 fail open");
    assert.equal(injectSnaps.length, beforeFailure, "rewrite 失败不得产出 route snapshot");
    assert.ok(errors.some((e) => e.context.phase === "prompt_rewrite"), "必须经 onError 报告 prompt_rewrite");
  });

  it("inject：未选中 Skill 的 metadata 全部消失，Top-K 候选与选择说明保留", async () => {
    const { extensions, errors, runtime } = await loadExtensions(
      [SKILL_CORTEX_ENTRY],
      PROJECT_ROOT,
      createEventBus(),
    );
    assert.deepEqual(errors, [], "真实 .pi 扩展必须能被宿主 loader 加载");
    assert.equal(extensions.length, 1);
    const runner = await makeRunner(extensions, runtime);

    const result = await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      fixture.basePrompt,
      buildPromptOptions(PROJECT_ROOT, fixture.skills, []),
    );
    assert.ok(result && typeof result.systemPrompt === "string", "inject 必须返回修改后的 systemPrompt");

    const finalPrompt = result.systemPrompt;
    // 原生全量 catalog block（全部 Skill 的 name/description/location）必须被完整移除。
    assert.ok(!finalPrompt.includes(fixture.nativeBlock), "原生全量 catalog block 必须被完整移除");
    // 未选中 Skill 的 name/description/location 一律不得出现。
    for (const skill of fixture.skills.filter((s) => s.name.startsWith("docx-"))) {
      assert.ok(!finalPrompt.includes(`<name>${skill.name}</name>`), `${skill.name} name 必须消失`);
      assert.ok(!finalPrompt.includes(skill.description), `${skill.name} description 必须消失`);
    }
    for (const filePath of fixture.unselectedPaths) {
      assert.ok(!finalPrompt.includes(filePath), `未选中 location 必须消失: ${filePath}`);
    }
    // Top-K 候选与选择说明保留。
    assert.ok(finalPrompt.includes("## Skill Cortex：prompt 外候选（有界 Top-K）"), "注入块必须存在");
    assert.ok(finalPrompt.includes("Read and merge PDF documents."), "选中 Skill 完整 description 必须在候选卡中");
    assert.ok(finalPrompt.includes("Single skill"), "选择说明必须存在");
    assert.ok(finalPrompt.includes("No-skill"), "no-skill 说明必须存在");
    assert.match(finalPrompt, /Current working directory: /, "移除必须是外科式的，不得误删 CWD 行");
    // 有界：注入块中出现的 skill 名 ≤ 默认 topK=5。
    const shownNames = new Set<string>();
    for (const name of fixture.skills.map((s) => s.name)) {
      if (finalPrompt.includes(`[skill_id=skill:`)) {
        // 候选卡行格式：`N. <name> [skill_id=..., scope=..., skill_revision=...]`
        const match = finalPrompt.match(new RegExp(`\\d+\\. ${name} \\[skill_id=`));
        if (match) shownNames.add(name);
      }
    }
    assert.ok(shownNames.size >= 1 && shownNames.size <= 5, `注入候选必须是有界 Top-K，实际 ${shownNames.size}`);
  });

  it("失败回退：原生 block 缺失（其他扩展先改）→ undefined，不注入 Top-K，宿主保留原 prompt", async () => {
    const { extensions, runtime } = await loadExtensions([SKILL_CORTEX_ENTRY], PROJECT_ROOT, createEventBus());
    const runner = await makeRunner(extensions, runtime);
    const tampered = fixture.basePrompt.replace(
      fixture.nativeBlock,
      "<available_skills>replaced by another extension</available_skills>",
    );
    assert.ok(!tampered.includes(fixture.nativeBlock), "前置：tampered prompt 必须已无原生 block");

    const result = await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      tampered,
      buildPromptOptions(PROJECT_ROOT, fixture.skills, []),
    );
    assert.equal(result, undefined, "无法唯一定位原生 block 时必须 fail open（不注入、不部分修改）");
  });

  it("失败回退：原生 block 非唯一 → undefined（绝不 slice 错误位置）", async () => {
    const { extensions, runtime } = await loadExtensions([SKILL_CORTEX_ENTRY], PROJECT_ROOT, createEventBus());
    const runner = await makeRunner(extensions, runtime);
    // 在 CWD 行之后重复一份 block，制造 indexOf !== lastIndexOf。
    const duplicated = `${fixture.basePrompt}\n\n${fixture.nativeBlock}`;

    const result = await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      duplicated,
      buildPromptOptions(PROJECT_ROOT, fixture.skills, []),
    );
    assert.equal(result, undefined, "block 不唯一时必须 fail open");
  });

  it("失败回退：摄入失败（SKILL.md 在摄入时消失）→ undefined，原生 prompt 保留", async () => {
    const { extensions, runtime } = await loadExtensions([SKILL_CORTEX_ENTRY], PROJECT_ROOT, createEventBus());
    const runner = await makeRunner(extensions, runtime);
    // 真实解析出的 Skill 中，把其中一个 filePath 指向已不存在的文件（模拟摄入时文件消失）。
    const broken = fixture.skills.map((skill, index) =>
      index === 0 ? { ...skill, filePath: path.join(skill.baseDir, "SKILL.md.missing") } : skill,
    );
    const basePrompt = buildSystemPrompt(buildPromptOptions(PROJECT_ROOT, broken, []));
    assert.ok(basePrompt.includes("<available_skills>"), "前置：prompt 仍含原生 block（格式化不读文件）");

    const result = await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      basePrompt,
      buildPromptOptions(PROJECT_ROOT, broken, []),
    );
    assert.equal(result, undefined, "Registry 摄入失败必须 fail open：不注入、不修改 prompt");
  });

  it("shadow：真实链上不修改 systemPrompt（不注入、不改）", async () => {
    const eventBus = createEventBus();
    const runtime = createExtensionRuntime();
    const shadowFactory: ExtensionFactory = (pi) => {
      // 与真实入口一致的注册路径，仅 mode 不同（生产入口当前为 inject，此处验证 shadow 语义）。
      registerSkillCortex(pi, { mode: "shadow" });
    };
    const shadowExt = await loadExtensionFromFactory(shadowFactory, PROJECT_ROOT, eventBus, runtime, "<shadow-test>");
    const runner = await makeRunner([shadowExt], runtime);

    const result = await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      fixture.basePrompt,
      buildPromptOptions(PROJECT_ROOT, fixture.skills, []),
    );
    assert.equal(result, undefined, "shadow 必须不修改 systemPrompt（真实链上返回 undefined）");
  });

  it("多扩展顺序：其他扩展先替换 block → skill-cortex fail open（无全量+Top-K 混合）", async () => {
    const eventBus = createEventBus();
    const runtime = createExtensionRuntime();
    // 模拟真实环境中的其他全局扩展（如 skill-router）先执行并替换原生 block。
    const firstFactory: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", (event) => {
        const block = formatSkillsForPrompt(event.systemPromptOptions?.skills ?? []);
        if (block && event.systemPrompt.includes(block)) {
          return { systemPrompt: event.systemPrompt.replace(block, "<available_skills>replaced</available_skills>") };
        }
        return undefined;
      });
    };
    const firstExt = await loadExtensionFromFactory(firstFactory, PROJECT_ROOT, eventBus, runtime, "<first-ext>");
    const { extensions, runtime: loadedRuntime } = await loadExtensions(
      [SKILL_CORTEX_ENTRY],
      PROJECT_ROOT,
      eventBus,
      runtime,
    );
    // 顺序 = handler 执行顺序：其他扩展先，skill-cortex 后。
    const runner = await makeRunner([firstExt, ...extensions], loadedRuntime);

    const result = await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      fixture.basePrompt,
      buildPromptOptions(PROJECT_ROOT, fixture.skills, []),
    );
    assert.ok(result && typeof result.systemPrompt === "string");
    assert.ok(result.systemPrompt.includes("<available_skills>replaced</available_skills>"), "先执行扩展的修改保留");
    assert.ok(!result.systemPrompt.includes("## Skill Cortex"), "skill-cortex 不得在 block 缺失时注入 Top-K");
    assert.ok(!result.systemPrompt.includes(fixture.nativeBlock), "不得出现全量 catalog");
  });

  it("多扩展顺序：skill-cortex 先执行时其 inject 结果保留（当前 0.84.1 project-local 优先）", async () => {
    const eventBus = createEventBus();
    const runtime = createExtensionRuntime();
    const { extensions } = await loadExtensions([SKILL_CORTEX_ENTRY], PROJECT_ROOT, eventBus, runtime);
    const secondFactory: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", (event) => {
        const block = formatSkillsForPrompt(event.systemPromptOptions?.skills ?? []);
        if (block && event.systemPrompt.includes(block)) {
          return { systemPrompt: event.systemPrompt.replace(block, "<available_skills>replaced</available_skills>") };
        }
        return undefined;
      });
    };
    const secondExt = await loadExtensionFromFactory(secondFactory, PROJECT_ROOT, eventBus, runtime, "<second-ext>");
    const runner = await makeRunner([...extensions, secondExt], runtime);

    const result = await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      fixture.basePrompt,
      buildPromptOptions(PROJECT_ROOT, fixture.skills, []),
    );
    assert.ok(result && typeof result.systemPrompt === "string");
    assert.ok(result.systemPrompt.includes("## Skill Cortex"), "skill-cortex 先执行时注入结果必须保留");
    assert.ok(!result.systemPrompt.includes(fixture.nativeBlock), "全量 block 不得残留");
  });
});

describe("B2 host integration（load_skill 真实 Pi loader/runner，无用户全局扩展）", () => {
  it("project-local 入口同时注册 search_skills + load_skill，load_skill 可按需加载 fixture 且 fail-closed", async () => {
    // 只加载 project-local .pi 入口；不加载用户全局 skill-router —— load_skill 必须由本项目自身提供。
    const { extensions, errors, runtime } = await loadExtensions(
      [SKILL_CORTEX_ENTRY],
      PROJECT_ROOT,
      createEventBus(),
    );
    assert.deepEqual(errors, [], "真实 .pi 扩展必须能被宿主 loader 加载");
    assert.equal(extensions.length, 1);
    const runner = await makeRunner(extensions, runtime);

    const registeredNames = runner.getAllRegisteredTools().map((t) => t.definition.name).sort();
    assert.ok(registeredNames.includes("search_skills"), "search_skills 必须由 project-local 入口注册");
    assert.ok(registeredNames.includes("load_skill"), "load_skill 必须由 project-local 入口注册");

    // 真实 before_agent_start 摄入（inject 路径同样填充 catalog）。
    await runner.emitBeforeAgentStart(
      "merge PDF documents",
      undefined,
      fixture.basePrompt,
      buildPromptOptions(PROJECT_ROOT, fixture.skills, []),
    );

    const ctx = runner.createContext();

    const searchDef = runner.getToolDefinition("search_skills");
    assert.ok(searchDef, "search_skills 工具定义必须存在");
    const searchResult = await searchDef.execute("tcid", { query: "pdf", limit: 1 }, undefined, undefined, ctx);
    const matches = (searchResult.details as { matches: Array<{ skillId: string; skillRevision: string; name: string }> }).matches;
    assert.equal(matches[0]!.name, "pdf", "search_skills 必须召回真实 fixture pdf");

    const loadDef = runner.getToolDefinition("load_skill");
    assert.ok(loadDef, "load_skill 工具定义必须存在");

    // 成功加载：正文 + 最小 provenance，不泄漏绝对路径。
    const loadResult = await loadDef.execute(
      "tcid",
      { skill_id: matches[0]!.skillId, skill_revision: matches[0]!.skillRevision },
      undefined,
      undefined,
      ctx,
    );
    const loadDetails = loadResult.details as { category: string; name: string; source_hash?: string };
    assert.equal(loadDetails.category, "ok");
    assert.equal(loadDetails.name, "pdf");
    // B3 seam：success details 返回内容指纹 source_hash，且等于 fixture 磁盘字节的 SHA-256。
    const pdfSkill = fixture.skills.find((s) => s.name === "pdf")!;
    const expectedHash = "sha256:" + createHash("sha256").update(await readFile(pdfSkill.filePath)).digest("hex");
    assert.equal(loadDetails.source_hash, expectedHash);
    const loadText = loadResult.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(loadText, /Read and merge PDF documents\./);
    assert.ok(!loadText.includes(fixture.root), "load 正文不得泄漏 fixture 绝对路径");

    // fail closed：unknown id / revision mismatch。
    const unknown = await loadDef.execute(
      "tcid",
      { skill_id: "skill:unknown", skill_revision: matches[0]!.skillRevision },
      undefined,
      undefined,
      ctx,
    );
    assert.equal((unknown.details as { category: string }).category, "unknown_skill");
    const mismatch = await loadDef.execute(
      "tcid",
      { skill_id: matches[0]!.skillId, skill_revision: "rev:wrong" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal((mismatch.details as { category: string }).category, "revision_mismatch");
  });
});
