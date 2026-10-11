import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { ActivationProfileStore } from "../../activation/store.ts";
import { scanMarkdownRelativeLinks } from "../../activation/markdown-link-audit-contribution-verifier.ts";
import { defaultTenantScope } from "../../adapters/pi/practice-observer.ts";
import { mapSkills } from "../../adapters/pi/core.ts";
import { buildSkillRecord } from "../../core/registry/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const PROMPT = "Audit project Markdown relative links and report broken local targets.";

describe("Markdown link audit through the real production entry", () => {
  it("stores one assessment for exact output and none for fenced output without persisting raw evidence", async (t) => {
    const fixtureRoot = await mkdtemp(path.join(PROJECT_ROOT, ".tmp-markdown-link-production-entry-"));
    const originalCwd = process.cwd();
    t.after(async () => {
      process.chdir(originalCwd);
      await rm(fixtureRoot, { recursive: true, force: true });
    });
    const skillDir = path.join(fixtureRoot, "skills", "markdown-relative-link-audit");
    await mkdir(skillDir, { recursive: true });
    await mkdir(path.join(fixtureRoot, "docs"), { recursive: true });
    await copyFile(
      path.join(PROJECT_ROOT, "skills", "markdown-relative-link-audit", "SKILL.md"),
      path.join(skillDir, "SKILL.md"),
    );
    await writeFile(path.join(fixtureRoot, "README.md"), "[guide](docs/guide.md)\n[missing](docs/missing.md)\n");
    await writeFile(path.join(fixtureRoot, "docs", "guide.md"), "# Guide\n");
    const expected = JSON.stringify(await scanMarkdownRelativeLinks(fixtureRoot));

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
    const hostSkill = loader.getSkills().skills.find((skill) => skill.name === "markdown-relative-link-audit");
    assert.ok(hostSkill);
    const record = await buildSkillRecord(mapSkills([hostSkill])[0]!);

    const faux = fauxProvider({
      provider: "markdown-link-production-entry-fixture",
      api: "markdown-link-production-entry-fixture-api",
      models: [{ id: "markdown-link-production-entry-fixture-model", reasoning: false }],
    });
    const run = (output: string) => [
      fauxAssistantMessage(fauxToolCall("load_skill", {
        skill_id: record.skillId,
        skill_revision: record.skillRevision,
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "docs/guide.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(output),
    ];
    const withoutLoad = [
      fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "docs/guide.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(expected),
    ];
    faux.setResponses([...run(expected), ...run(`\`\`\`json\n${expected}\n\`\`\``), ...withoutLoad]);

    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
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
    await session.prompt(PROMPT);

    const tenantScope = defaultTenantScope(fixtureRoot);
    const assessments = await new LearningAssessmentStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "learning-assessments"),
      projectRoot: fixtureRoot,
    }).list(tenantScope);
    const events = await new PracticeStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "practice"),
      projectRoot: fixtureRoot,
    }).listProvenance(tenantScope, "real");
    const profiles = await new ActivationProfileStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "activation"),
      projectRoot: fixtureRoot,
    }).listCurrent();
    assert.equal(events.length, 2);
    assert.equal(assessments.length, 1);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]!.status, "shadow");
    assert.deepEqual(profiles[0]!.positiveExamples[0]!.features, [
      "task-family:markdown-relative-link-audit",
      "audit-scope:project-markdown",
      "link-class:relative-file",
      "result-class:broken-links-present",
    ]);
    const persisted = JSON.stringify({ assessments, events, profiles });
    assert.equal(persisted.includes(PROMPT), false);
    assert.equal(persisted.includes(expected), false);
    assert.equal(persisted.includes(fixtureRoot), false);
  });
});
