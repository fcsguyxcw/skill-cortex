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
  ExtensionRunner,
  loadExtensions,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import { buildSystemPrompt } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import type { DiscoveryCacheObservation } from "../../adapters/pi/core.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const ENTRY = path.join(PROJECT_ROOT, "src", "evaluation", "d3", "cache-host-entry.ts");

interface HostObservation {
  cache: DiscoveryCacheObservation;
  recordCount: number;
  candidates: Array<{ skillId: string; skillRevision: string; name: string }>;
}

let fixtureRoot = "";
let runner: ExtensionRunner;

function writeSkill(name: string, description: string, body: string): void {
  const dir = path.join(fixtureRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
  );
}

function loadFixtureSkills(): Skill[] {
  const result = loadSkillsFromDir({ dir: fixtureRoot, source: "user" });
  assert.deepEqual(result.diagnostics, []);
  return result.skills;
}

async function emitRun(prompt: string, skills: Skill[]): Promise<void> {
  const systemPrompt = buildSystemPrompt({ cwd: fixtureRoot, skills, contextFiles: [] });
  await runner.emitBeforeAgentStart(prompt, undefined, systemPrompt, {
    cwd: fixtureRoot,
    skills,
    contextFiles: [],
  });
}

async function observations(): Promise<HostObservation[]> {
  const tool = runner.getToolDefinition("d3_cache_observations");
  assert.ok(tool);
  const result = await tool.execute("cache-observation", {}, undefined, undefined, runner.createContext());
  return (result.details as { observations: HostObservation[] }).observations;
}

async function searchOne(query: string): Promise<{ skillId: string; skillRevision: string }> {
  const tool = runner.getToolDefinition("search_skills");
  assert.ok(tool);
  const result = await tool.execute("search", { query, limit: 1 }, undefined, undefined, runner.createContext());
  const matches = (result.details as { matches: Array<{ skillId: string; skillRevision: string }> }).matches;
  assert.equal(matches.length, 1);
  return matches[0]!;
}

async function loadSkill(skillId: string, skillRevision: string): Promise<Record<string, unknown>> {
  const tool = runner.getToolDefinition("load_skill");
  assert.ok(tool);
  const result = await tool.execute(
    "load",
    { skill_id: skillId, skill_revision: skillRevision },
    undefined,
    undefined,
    runner.createContext(),
  );
  return result.details as Record<string, unknown>;
}

before(async () => {
  fixtureRoot = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-d3-cache-host-"));
  writeSkill("docx", "Create and edit Word docx reports.", "version one");
  const { extensions, errors, runtime } = await loadExtensions([ENTRY], fixtureRoot, createEventBus());
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1);
  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
    modelsPath: null,
    authPath: path.join(fixtureRoot, "auth.json"),
  });
  runner = new ExtensionRunner(
    extensions,
    runtime,
    fixtureRoot,
    SessionManager.inMemory(fixtureRoot),
    new ModelRegistry(modelRuntime),
  );
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("D3 cache real ExtensionRunner refresh E2E", () => {
  it("unchanged hit；install/source refresh miss；旧 revision 与未 refresh drift 均 fail closed", async () => {
    const firstSkills = loadFixtureSkills();
    await emitRun("create a docx report", firstSkills);
    const oldDocx = await searchOne("docx");

    await emitRun("edit a word document", firstSkills);
    let seen = await observations();
    assert.deepEqual(seen.slice(0, 2).map((item) => item.cache.catalog), ["miss", "hit"]);
    assert.deepEqual(seen.slice(0, 2).map((item) => item.cache.overlay), ["disabled", "disabled"]);

    writeSkill("pdf", "Read and inspect PDF documents.", "pdf version one");
    const installedSkills = loadFixtureSkills();
    await emitRun("inspect a pdf", installedSkills);
    seen = await observations();
    assert.equal(seen[2]!.cache.catalog, "miss");
    assert.equal(seen[2]!.recordCount, 2);

    writeSkill("docx", "Create and edit Word docx reports.", "version two");
    const refreshedSkills = loadFixtureSkills();
    await emitRun("create a docx report", refreshedSkills);
    const newDocx = await searchOne("docx");
    seen = await observations();
    assert.equal(seen[3]!.cache.catalog, "miss");
    assert.notEqual(newDocx.skillRevision, oldDocx.skillRevision);
    assert.equal((await loadSkill(oldDocx.skillId, oldDocx.skillRevision)).category, "revision_mismatch");
    assert.equal((await loadSkill(newDocx.skillId, newDocx.skillRevision)).category, "ok");

    writeSkill("docx", "Create and edit Word docx reports.", "version three without refresh");
    assert.equal((await loadSkill(newDocx.skillId, newDocx.skillRevision)).category, "source_drift");
  });
});
