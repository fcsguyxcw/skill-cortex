import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { registerSkillCortex } from "../../adapters/pi/index.ts";
import { createDiscoveryServices } from "../../adapters/pi/core.ts";
import { computeCatalogHash, parseSelectionResponse } from "./paired.ts";
import {
  DEV_SELECTION_CASES,
  EXPECTED_CATALOG_HASH,
  FROZEN_GOLD_SET_HASH,
} from "./dev-cases.ts";

const MODEL_PROVIDER = "deepseek";
const MODEL_ID = "deepseek-v4-flash";
const CASE_IDS = new Set(["D01", "D04"]);
const TOP_K = 5;
const REPORT_FILE = "2026-08-20-selection-supplemental-host-diagnostic.json";
const PROTOCOL_REVISION = "selection-supplemental-host-v1";
const APPEND_SYSTEM_PROMPT = [
  "This is a Skill selection evaluation. Do not execute the user's task.",
  "Select the smallest exact set of installed Skill IDs required for the task.",
  "If the injected candidate cards omit a specialized capability that likely exists, you may call search_skills once.",
  'After zero or one search_skills call, reply with exactly one JSON object: {"selected_skill_ids":["skill:..."]}.',
  "Use an empty array only when no installed Skill is needed.",
].join(" ");

interface SearchCallSummary {
  readonly queryHash: string;
  readonly queryLength: number;
  readonly hasLatin: boolean;
  readonly limit: number | null;
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const globalAgentDir = getAgentDir();
  const globalLoader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir: globalAgentDir,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await globalLoader.reload();
  const skills = globalLoader
    .getSkills()
    .skills.filter((item) => item.disableModelInvocation !== true);

  const discovery = createDiscoveryServices({ topK: TOP_K });
  const ingest = await discovery.run("", skills);
  if (!ingest.ok || discovery.state.catalog === undefined) {
    throw new Error("supplemental_catalog_ingest_failed");
  }
  const catalog = [...discovery.state.catalog.values()].map(({ record }) => record);
  const catalogHash = computeCatalogHash(catalog);
  if (catalogHash !== EXPECTED_CATALOG_HASH) {
    throw new Error(`supplemental_catalog_hash_mismatch:${catalogHash}`);
  }

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: path.join(globalAgentDir, "models.json"),
    modelsStorePath: path.join(globalAgentDir, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = runtime.getModel(MODEL_PROVIDER, MODEL_ID);
  if (model === undefined) throw new Error("supplemental_model_not_found");

  const cases = DEV_SELECTION_CASES.filter((item) => CASE_IDS.has(item.id));
  const results = [];
  for (const evalCase of cases) {
    const searchCalls: SearchCallSummary[] = [];
    const initialCandidateIds: string[][] = [];
    const adapterErrors: string[] = [];
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false, provider: { timeoutMs: 120_000, maxRetries: 0 } },
    });
    const evaluationAgentDir = path.join(projectRoot, ".skill-cortex", "evaluation-agent");
    const loader = createEvaluationLoader({
      projectRoot,
      evaluationAgentDir,
      settingsManager,
      skills,
      searchCalls,
      initialCandidateIds,
      adapterErrors,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: projectRoot,
      agentDir: evaluationAgentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: "high",
      tools: ["read", "search_skills"],
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(projectRoot),
    });

    const started = performance.now();
    await session.prompt(evalCase.query);
    const latencyMs = performance.now() - started;
    const assistantMessages = session.messages.filter(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    const finalMessage = assistantMessages.at(-1);
    if (finalMessage === undefined) throw new Error(`supplemental_missing_response:${evalCase.id}`);
    const finalText = finalMessage.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    const parsed = parseSelectionResponse(finalText);
    const selectedSkillIds = parsed.ok ? parsed.selectedSkillIds : [];
    results.push({
      caseId: evalCase.id,
      queryHash: sha256(evalCase.query),
      goldSkillIds: [...evalCase.goldSkillIds],
      initialCandidateIds: initialCandidateIds.at(-1) ?? [],
      initialRetrievalGoldAvailable: evalCase.goldSkillIds.every((id) =>
        (initialCandidateIds.at(-1) ?? []).includes(id)),
      searchCalls,
      searchSkillsCalled: searchCalls.length > 0,
      searchCallBoundRespected: searchCalls.length <= 1,
      validOutput: parsed.ok,
      ...(parsed.ok ? {} : { parseFailureReason: parsed.reason }),
      selectedSkillIds,
      exactSetMatch: sameSet(selectedSkillIds, evalCase.goldSkillIds),
      adapterErrors,
      assistantTurnCount: assistantMessages.length,
      usage: sumUsage(assistantMessages),
      latencyMs,
      rawResponseHash: sha256(finalText),
    });
  }

  const report = {
    schemaVersion: 1,
    sourceMode: "real_host_model",
    generatedAt: new Date().toISOString(),
    protocolRevision: PROTOCOL_REVISION,
    protocolPromptHash: sha256(APPEND_SYSTEM_PROMPT),
    catalogHash,
    devGoldSetHash: FROZEN_GOLD_SET_HASH,
    model: {
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      thinkingLevel: "high",
      temperature: "host_default_unavailable",
    },
    boundaries: {
      focusedDevMissDiagnosticOnly: true,
      comparableToOriginalPairedArms: false,
      rawPromptsStored: false,
      rawResponsesStored: false,
      sessionPersistence: false,
      practiceObserverEnabled: false,
      userEnvironmentWrites: false,
    },
    cases: results,
  };
  const reportsDir = path.join(projectRoot, "docs", "reports");
  await mkdir(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, REPORT_FILE);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ report: path.relative(projectRoot, reportPath), cases: results }));
}

function createEvaluationLoader(input: {
  projectRoot: string;
  evaluationAgentDir: string;
  settingsManager: SettingsManager;
  skills: Skill[];
  searchCalls: SearchCallSummary[];
  initialCandidateIds: string[][];
  adapterErrors: string[];
}): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: input.projectRoot,
    agentDir: input.evaluationAgentDir,
    settingsManager: input.settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: [APPEND_SYSTEM_PROMPT],
    skillsOverride: () => ({ skills: input.skills, diagnostics: [] }),
    extensionFactories: [
      (pi) => {
        pi.on("tool_call", (event) => {
          if (event.toolName !== "search_skills") return;
          const value = isRecord(event.input) ? event.input : {};
          const query = typeof value.query === "string" ? value.query : "";
          input.searchCalls.push({
            queryHash: sha256(query),
            queryLength: query.length,
            hasLatin: /[A-Za-z]/.test(query),
            limit: typeof value.limit === "number" ? value.limit : null,
          });
        });
        registerSkillCortex(pi, {
          mode: "inject",
          topK: TOP_K,
          onDiscovery: (snapshot) => input.initialCandidateIds.push(
            snapshot.candidates.map((candidate) => candidate.skillId),
          ),
          onError: (error, context) => input.adapterErrors.push(
            `${context.phase}:${error instanceof Error ? error.message : String(error)}`,
          ),
        });
      },
    ],
  });
}

function sumUsage(messages: readonly AssistantMessage[]) {
  return messages.reduce(
    (total, message) => ({
      input: total.input + message.usage.input,
      output: total.output + message.usage.output,
      cacheRead: total.cacheRead + message.usage.cacheRead,
      cacheWrite: total.cacheWrite + message.usage.cacheWrite,
      reasoning: total.reasoning + (message.usage.reasoning ?? 0),
      totalTokens: total.totalTokens + message.usage.totalTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 },
  );
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    left.every((item) => right.includes(item));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

await main();
