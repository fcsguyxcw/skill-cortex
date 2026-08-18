/**
 * Phase 6 host integration —— 真实 runner E2E（隔离）+ discovery overlay seam 集成。
 *
 * 覆盖：
 * 1. 真实链路（ExtensionRunner 加载 host-integration-entry）：真实 load_skill 选中 +
 *    pagination 证据钩子 ⇒ verified real 事件 ⇒ induction ⇒ ActivationProfileStore shadow；
 *    受控 promotion 对 real skill（父不在冻结评估集内）⇒ 拒绝（parent_not_in_evaluation_set），
 *    profile 保持 shadow（不 trivial 晋升）。
 * 2. discovery overlay seam（createDiscoveryServices + overlayProfiles）：active profile
 *    （revision 匹配）⇒ 候选追加 learned_cue evidence；无 overlayProfiles ⇒ 无损回静态。
 *
 * 隔离：真实 runner 用 --no-session 等价隔离（ExtensionRunner 内存 runner + fixture）；
 * store 落在 <fixture>/.skill-cortex/{practice,activation}（project-local）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createEventBus,
  loadSkillsFromDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  loadExtensions,
  ExtensionRunner,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import { buildSystemPrompt } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import type { ActivationProfile, SkillRecord } from "../../core/contracts/index.ts";
import { buildSkillRecord } from "../../core/registry/index.ts";
import { createDiscoveryServices } from "../../adapters/pi/core.ts";
import { phase6ActivationStore } from "./host-integration-entry.ts";
import { promoteProfileIfEligible, transitionProfileToShadow } from "../../activation/index.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const ENTRY = path.join(PROJECT_ROOT, "src", "evaluation", "phase6", "host-integration-entry.ts");

let fixtureRoot = "";
let originalCwd = "";
let fixtureSkills: Skill[] = [];
let runner: ExtensionRunner;
let paginationSkill: Skill;
let paginationRecord: SkillRecord;

const OVERLAY = { aliasBoost: 5, positiveBoost: 3, nearMissPenalty: 10 } as const;

async function realLoad(query: string): Promise<{ skillId: string; skillRevision: string; details: Record<string, unknown> }> {
  const searchDef = runner.getToolDefinition("search_skills")!;
  const loadDef = runner.getToolDefinition("load_skill")!;
  const ctx = runner.createContext();
  const searchResult = await searchDef.execute("tid", { query, limit: 1 }, undefined, undefined, ctx);
  const matches = (searchResult.details as { matches: Array<{ skillId: string; skillRevision: string }> }).matches;
  assert.equal(matches.length, 1, `search_skills("${query}") 必须命中 1 个 skill`);
  const { skillId, skillRevision } = matches[0]!;
  const loadResult = await loadDef.execute("tcid", { skill_id: skillId, skill_revision: skillRevision }, undefined, undefined, ctx);
  return { skillId, skillRevision, details: loadResult.details as Record<string, unknown> };
}

before(async () => {
  originalCwd = process.cwd();
  const root = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-phase6-host-"));
  fixtureRoot = root;
  const names = ["sql-pagination-helper", "pdf"];
  for (const name of names) {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${
        name === "sql-pagination-helper"
          ? "Detect pagination in SQL queries and report offset or keyset usage."
          : "Read and merge PDF documents."
      }\n---\n\n# ${name}\n\nbody\n`,
    );
  }
  process.chdir(root);

  const { skills } = loadSkillsFromDir({ dir: root, source: "user" });
  assert.equal(skills.length, 2, "fixture 必须解析出 2 个真实 Skill");
  fixtureSkills = skills;
  paginationSkill = skills.find((s) => s.name === "sql-pagination-helper")!;
  paginationRecord = await buildSkillRecord({
    name: paginationSkill.name,
    description: paginationSkill.description,
    scope: paginationSkill.sourceInfo.scope,
    baseDir: paginationSkill.baseDir,
    skillMdPath: paginationSkill.filePath,
    disableModelInvocation: paginationSkill.disableModelInvocation,
    declaredAliases: [],
    declaredPermissions: [],
    declaredEffects: [],
  });

  const { extensions, errors, runtime } = await loadExtensions([ENTRY], root, createEventBus());
  assert.deepEqual(errors, [], "host-integration-entry 必须能被宿主 loader 无错加载");
  assert.equal(extensions.length, 1);

  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
    modelsPath: null,
    authPath: path.join(root, "auth.json"),
  });
  const sessionManager = SessionManager.inMemory(root);
  runner = new ExtensionRunner(extensions, runtime, root, sessionManager, new ModelRegistry(modelRuntime));
});

after(async () => {
  process.chdir(originalCwd);
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function startRun(prompt: string): Promise<void> {
  const basePrompt = buildSystemPrompt({
    cwd: fixtureRoot,
    skills: fixtureSkills,
    contextFiles: [{ path: "AGENTS.md", content: "project context" }],
  });
  await runner.emitBeforeAgentStart(prompt, undefined, basePrompt, {
    cwd: fixtureRoot,
    skills: fixtureSkills,
    contextFiles: [],
  });
}

describe("Phase 6 host integration（真实 ExtensionRunner）", () => {
  it("真实链路：load_skill 选中 + pagination 证据钩子 ⇒ induction ⇒ 冻结评估 promotion ⇒ active", async () => {
    // Run 0：预摄入（observer 无快照，不产事件）。
    await startRun("detect pagination");
    const { skillId, skillRevision, details } = await realLoad("pagination");
    assert.equal(details.category, "ok");
    assert.ok(
      typeof details.source_hash === "string" && /^(?:sha256:)?[0-9a-f]{64}$/.test(details.source_hash),
    );

    // Run 1：inject 成功（skill 进候选）+ 真实 load_skill 选中 + SQL prompt（pagination 钩子）。
    await startRun("detect pagination in SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;");
    await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "tc1",
      toolName: "load_skill",
      input: { skill_id: skillId, skill_revision: skillRevision },
    });
    await runner.emitToolResult({
      type: "tool_result",
      toolCallId: "tc1",
      toolName: "load_skill",
      input: { skill_id: skillId },
      content: [{ type: "text", text: "ok" }],
      isError: false,
      details,
    });
    await runner.emit({ type: "agent_settled" });

    // observer → induction → store：shadow profile 落盘（父 = 选中 skill）。
    const activationStore = phase6ActivationStore(fixtureRoot);
    const profiles = await activationStore.listCurrent();
    assert.equal(profiles.length, 1, "必须产出一个 ActivationProfile");
    const profile = profiles[0]!;
    assert.equal(profile.parentSkillId, skillId);
    assert.equal(profile.parentSkillRevision, skillRevision);
    // Seam 3：冻结 real-skill 评估 provider 对真实 skill（confuser pdf 区分）判门通过 ⇒ active。
    assert.equal(profile.status, "active");
    assert.ok(profile.positiveExamples.length > 0, "induction 必须从 verified 事件产出 positiveExamples");
  });
});

describe("Phase 6 discovery overlay seam（createDiscoveryServices）", () => {
  it("active profile（revision 匹配）⇒ 候选追加 learned_cue；无 overlayProfiles ⇒ 无损回静态", async () => {
    // 无 overlay：静态。
    const staticServices = createDiscoveryServices({ topK: 5 });
    const staticOutcome = await staticServices.run("pagination-check sql", fixtureSkills);
    const staticGold = staticOutcome.candidates.find((c) => c.skillId === paginationRecord.skillId)!;
    assert.ok(staticGold, "静态必须召回 gold");
    assert.ok(
      !staticGold.evidence.some((e) => e.kind === "learned_cue"),
      "静态无 learned_cue",
    );

    // active profile bound to gold + revision 匹配 ⇒ overlay 生效。
    const active: ActivationProfile = {
      schemaVersion: 1,
      profileId: "profile:seed-pagination",
      parentSkillId: paginationRecord.skillId,
      parentSkillRevision: paginationRecord.skillRevision,
      status: "active",
      learnedAliases: [{ cueId: "cue:seed-alias", text: "pagination-check", evidenceIds: ["seed-1"] }],
      positiveExamples: [],
      nearMissExamples: [],
      environmentCues: [],
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    };
    const overlayServices = createDiscoveryServices({
      topK: 5,
      overlayProfiles: () => [active],
      overlayOptions: { ...OVERLAY },
    });
    const outcome = await overlayServices.run("pagination-check sql", fixtureSkills);
    const gold = outcome.candidates.find((c) => c.skillId === paginationRecord.skillId)!;
    assert.ok(gold.evidence.some((e) => e.kind === "learned_cue" && e.cueId === "cue:seed-alias"),
      "active overlay 必须追加 learned_cue evidence");

    // revision 失配 ⇒ 不生效（无损回静态）。
    const stale: ActivationProfile = { ...active, parentSkillRevision: "rev:" + "9".repeat(64) };
    const staleServices = createDiscoveryServices({
      topK: 5,
      overlayProfiles: () => [stale],
      overlayOptions: { ...OVERLAY },
    });
    const staleOutcome = await staleServices.run("pagination-check sql", fixtureSkills);
    const staleGold = staleOutcome.candidates.find((c) => c.skillId === paginationRecord.skillId)!;
    assert.ok(!staleGold.evidence.some((e) => e.kind === "learned_cue"), "revision 失配不得生效");
  });

  it("受控 promotion：seed active profile 经 promoteProfileIfEligible（冻结评估集）⇒ active 落盘", async () => {
    const store = phase6ActivationStore(fixtureRoot);
    const draft = {
      schemaVersion: 1 as const,
      profileId: "profile:seed-promotion",
      parentSkillId: paginationRecord.skillId,
      parentSkillRevision: paginationRecord.skillRevision,
      status: "draft" as const,
      learnedAliases: [{ cueId: "cue:seed-alias", text: "pagination-check", evidenceIds: ["seed-1"] }],
      positiveExamples: [],
      nearMissExamples: [],
      environmentCues: [],
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    };
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft, { decision: "shadow", shadowReportId: "shadow:seed-001" });
    await store.transition(draft, shadow, { trigger: "procedure", reportId: "shadow:seed-001" });

    // Seam 3：promotion 只接受 catalogRecords（冻结 real-skill 评估 provider 内部构造四栏）。
    const result = await promoteProfileIfEligible(
      store,
      shadow,
      [paginationRecord],
      "promotion:seed-001",
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await store.getProfile("profile:seed-promotion"))!.status, "active");

    // 受控 evaluator 一致性：report 来自冻结评估 provider（buildFrozenEvaluation）。
    // 降级：real-skill 冻结 gate 只真实验证 hard_confuser + no_skill 两栏；multi_skill /
    // cross_language 无法真实验证 ⇒ caseCount=0（不造假）。
    if (result.ok) {
      const byColumn = new Map(result.report.learnedColumns.map((c) => [c.column, c.caseCount]));
      assert.ok(byColumn.get("hard_confuser")! > 0, "hard_confuser 必须真实验证");
      assert.ok(byColumn.get("no_skill")! > 0, "no_skill 必须真实验证");
      assert.equal(byColumn.get("multi_skill"), 0, "multi_skill 降级（无法真实验证）");
      assert.equal(byColumn.get("cross_language"), 0, "cross_language 降级（无法真实验证）");
      assert.equal(result.report.nonInferior, true);
    }
  });
});
