import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { registerSkillCortex, type DiscoveryResult } from "../../adapters/pi/index.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

interface HostObservation {
  cache: DiscoveryResult["cache"];
  recordCount: number;
  candidates: Array<{ skillId: string; skillRevision: string; name: string }>;
}

async function writeSkill(skillDir: string, body: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: docx\ndescription: Create and edit Word docx reports.\n---\n\n# docx\n\n${body}\n`,
    "utf8",
  );
}

describe("D3 cache real AgentSession resource lifecycle", () => {
  it("连续正常 turn 复用宿主 skills 数组；resource reload 后宿主更换数组并触发 catalog miss", async (t) => {
    const fixtureRoot = await mkdtemp(path.join(PROJECT_ROOT, ".tmp-d3-real-host-"));
    t.after(async () => {
      await rm(fixtureRoot, { recursive: true, force: true });
    });
    const skillDir = path.join(fixtureRoot, "skills", "docx");
    await writeSkill(skillDir, "version one");

    const turnSkillRefs: Skill[][] = [];
    const observations: HostObservation[] = [];
    const adapterErrors: string[] = [];
    const faux = fauxProvider({
      provider: "d3-host-fixture",
      api: "d3-host-fixture-api",
      models: [{ id: "d3-host-fixture-model", reasoning: false }],
    });
    faux.setResponses([
      fauxAssistantMessage("turn one complete"),
      fauxAssistantMessage("turn two complete"),
      fauxAssistantMessage("turn after reload complete"),
    ]);

    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: fixtureRoot,
      agentDir: path.join(fixtureRoot, "agent"),
      settingsManager,
      additionalSkillPaths: [skillDir],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          pi.on("before_agent_start", (event) => {
            turnSkillRefs.push(event.systemPromptOptions.skills ?? []);
          });
          registerSkillCortex(pi, {
            mode: "shadow",
            onDiscovery: (result) => {
              observations.push({
                cache: result.cache,
                recordCount: result.recordCount,
                candidates: result.candidates.map(({ skillId, skillRevision, name }) => ({
                  skillId,
                  skillRevision,
                  name,
                })),
              });
            },
            onError: (error, context) => adapterErrors.push(
              `${context.phase}:${error instanceof Error ? error.message : String(error)}`,
            ),
          });
        },
      ],
    });
    await loader.reload();
    const initialLoaderSkills = loader.getSkills().skills;
    assert.equal(initialLoaderSkills.length, 1);

    const { session } = await createAgentSession({
      cwd: fixtureRoot,
      agentDir: path.join(fixtureRoot, "agent"),
      modelRuntime: runtime,
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: ["read"],
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(fixtureRoot),
    });

    await session.prompt("create a docx report");
    await session.prompt("edit the same Word document");

    assert.equal(turnSkillRefs.length, 2);
    assert.strictEqual(turnSkillRefs[0], initialLoaderSkills);
    assert.strictEqual(turnSkillRefs[1], turnSkillRefs[0]);
    assert.deepEqual(observations.map((item) => item.cache.catalog), ["miss", "hit"]);

    const oldRevision = observations[0]!.candidates[0]!.skillRevision;
    await writeSkill(skillDir, "version two after resource reload");
    await session.reload();
    const reloadedLoaderSkills = loader.getSkills().skills;
    assert.notStrictEqual(reloadedLoaderSkills, initialLoaderSkills);

    await session.prompt("create another docx report after reload");

    assert.equal(faux.state.callCount, 3);
    assert.equal(turnSkillRefs.length, 3);
    assert.strictEqual(turnSkillRefs[2], reloadedLoaderSkills);
    assert.notStrictEqual(turnSkillRefs[2], turnSkillRefs[1]);
    assert.deepEqual(observations.map((item) => item.cache.catalog), ["miss", "hit", "miss"]);
    assert.equal(observations[2]!.recordCount, 1);
    assert.notEqual(observations[2]!.candidates[0]!.skillRevision, oldRevision);
    assert.deepEqual(adapterErrors, []);
  });
});
