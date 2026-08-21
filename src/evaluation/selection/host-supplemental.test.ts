import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { registerSkillCortex } from "../../adapters/pi/index.ts";

const DIAGNOSING_SKILL_ID_PATTERN = /skill:[0-9a-f]{64}/;

async function skill(root: string, name: string, description: string): Promise<Skill> {
  const baseDir = path.join(root, "skills", name);
  const filePath = path.join(baseDir, "SKILL.md");
  await mkdir(baseDir, { recursive: true });
  await writeFile(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
  return {
    name,
    description,
    baseDir,
    filePath,
    sourceInfo: {
      path: baseDir,
      source: "evaluation_fixture",
      scope: "temporary",
      origin: "top-level",
    },
    disableModelInvocation: false,
  };
}

describe("selection supplemental search host chain", () => {
  it("runs AgentSession -> model tool call -> search_skills result -> model", async (t) => {
    const fixtureRoot = await mkdtemp(path.join(process.cwd(), ".tmp-selection-host-"));
    t.after(async () => {
      await rm(fixtureRoot, { recursive: true, force: true });
    });
    const skills = await Promise.all([
      skill(fixtureRoot, "diagnosing-bugs", "Diagnose intermittent failures and identify root causes with evidence."),
      skill(fixtureRoot, "code-review", "Review a code change for correctness and maintainability."),
      skill(fixtureRoot, "pdf", "Read and modify PDF documents."),
    ]);
    const searches: unknown[] = [];
    const snapshots: unknown[] = [];
    const adapterErrors: string[] = [];
    const faux = fauxProvider({
      provider: "selection-fixture",
      api: "selection-fixture-api",
      models: [{ id: "selection-fixture-model", reasoning: false }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("search_skills", {
          query: "diagnose intermittent test timeout root cause",
          limit: 5,
        }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const toolResult = context.messages.find((message) => message.role === "toolResult");
        assert.ok(toolResult, "the second model turn must receive the tool result");
        const text = toolResult.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("");
        assert.match(text, /diagnosing-bugs/);
        const selected = text.match(DIAGNOSING_SKILL_ID_PATTERN)?.[0];
        assert.ok(selected);
        return fauxAssistantMessage(JSON.stringify({ selected_skill_ids: [selected] }));
      },
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
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      skillsOverride: () => ({ skills, diagnostics: [] }),
      extensionFactories: [
        (pi) => {
          pi.on("tool_call", (event) => {
            if (event.toolName === "search_skills") searches.push(event.input);
          });
          registerSkillCortex(pi, {
            mode: "inject",
            onDiscovery: (snapshot) => snapshots.push(snapshot),
            onError: (error, context) => adapterErrors.push(
              `${context.phase}:${error instanceof Error ? error.message : String(error)}`,
            ),
          });
        },
      ],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: fixtureRoot,
      agentDir: path.join(fixtureRoot, "agent"),
      modelRuntime: runtime,
      model: faux.getModel(),
      thinkingLevel: "off",
      // Pi only includes the native Skill block when `read` is active. The
      // adapter rewrites that block to bounded candidate cards before the
      // first model turn; the scripted model never invokes `read`.
      tools: ["read", "search_skills"],
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(fixtureRoot),
    });

    await session.prompt("测试套件偶发超时，请定位根因并给出证据，不要改代码。");

    assert.equal(faux.state.callCount, 2);
    assert.deepEqual(searches, [{ query: "diagnose intermittent test timeout root cause", limit: 5 }]);
    assert.deepEqual(adapterErrors, []);
    assert.equal(snapshots.length, 1);
    const last = session.messages.at(-1);
    assert.equal(last?.role, "assistant");
    if (last?.role !== "assistant") return;
    const finalText = last.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    assert.match(finalText, /selected_skill_ids/);
  });
});
