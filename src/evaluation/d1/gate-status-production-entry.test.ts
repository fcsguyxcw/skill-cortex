import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import productionEntry from "../../../.pi/extensions/skill-cortex/index.ts";
import { LearningAssessmentStore } from "../../activation/admission-store.ts";
import { defaultTenantScope } from "../../adapters/pi/practice-observer.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const PROMPT = "Report the current Skill Cortex G1-G7 gate states from the authoritative registry.";

describe("G1 bounded verifier through the real production entry", () => {
  it("exact gate output stores one assessment; wrong output stores none; raw evidence is not persisted", async (t) => {
    const fixtureRoot = await mkdtemp(path.join(PROJECT_ROOT, ".tmp-g1-production-entry-"));
    const originalCwd = process.cwd();
    t.after(async () => {
      process.chdir(originalCwd);
      await rm(fixtureRoot, { recursive: true, force: true });
    });
    const skillDir = path.join(fixtureRoot, "skills", "skill-cortex-gate-status");
    await mkdir(path.join(skillDir, "agents"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "config"), { recursive: true });
    await copyFile(path.join(PROJECT_ROOT, "skills", "skill-cortex-gate-status", "SKILL.md"), path.join(skillDir, "SKILL.md"));
    await copyFile(path.join(PROJECT_ROOT, "skills", "skill-cortex-gate-status", "agents", "openai.yaml"), path.join(skillDir, "agents", "openai.yaml"));
    await copyFile(path.join(PROJECT_ROOT, "config", "activation-memory-gates.json"), path.join(fixtureRoot, "config", "activation-memory-gates.json"));
    const expected = JSON.stringify(JSON.parse(await readFile(path.join(fixtureRoot, "config", "activation-memory-gates.json"), "utf8")));

    process.chdir(fixtureRoot);
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
      extensionFactories: [productionEntry],
    });
    await loader.reload();
    const hostSkill = loader.getSkills().skills.find((skill) => skill.name === "skill-cortex-gate-status");
    assert.ok(hostSkill);

    const faux = fauxProvider({
      provider: "g1-production-entry-fixture",
      api: "g1-production-entry-fixture-api",
      models: [{ id: "g1-production-entry-fixture-model", reasoning: false }],
    });
    const run = (output: string) => [
      fauxAssistantMessage(fauxToolCall("load_skill", {
        skill_id: hostSkill.name,
        skill_revision: "placeholder",
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "config/activation-memory-gates.json" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(output),
    ];

    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);

    // The immutable identity is supplied by the actual injected candidate card, not the host name.
    // First emit a dry discovery through the session, then replace the placeholder in faux inputs.
    const parent = loader.getSkills().skills[0]!;
    const { buildSkillRecord } = await import("../../core/registry/index.ts");
    const { mapSkills } = await import("../../adapters/pi/core.ts");
    const record = await buildSkillRecord(mapSkills([parent])[0]!);
    const responses = [...run(expected), ...run('{"schemaVersion":1,"gates":[]}')];
    for (const message of responses) {
      for (const content of message.content) {
        if (content.type === "toolCall" && content.name === "load_skill") {
          content.arguments = { skill_id: record.skillId, skill_revision: record.skillRevision };
        }
      }
    }
    faux.setResponses(responses);

    const { session } = await createAgentSession({
      cwd: fixtureRoot,
      agentDir: path.join(fixtureRoot, "agent"),
      modelRuntime: runtime,
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: ["read", "load_skill"],
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(fixtureRoot),
    });
    await session.prompt(PROMPT);
    await session.prompt(PROMPT);

    const assessmentStore = new LearningAssessmentStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "learning-assessments"),
      projectRoot: fixtureRoot,
    });
    const assessments = await assessmentStore.list(defaultTenantScope(fixtureRoot));
    assert.equal(assessments.length, 1);
    const persisted = JSON.stringify(assessments);
    assert.equal(persisted.includes(PROMPT), false);
    assert.equal(persisted.includes(expected), false);
  });
});
