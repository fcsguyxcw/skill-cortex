import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { createDiscoveryServices } from "../../adapters/pi/core.ts";
import {
  DEV_SELECTION_CASES,
  EXPECTED_CATALOG_HASH,
  FROZEN_GOLD_SET_HASH,
} from "./dev-cases.ts";
import {
  runRealSelectionPaired,
  type RealSelectionModelConfig,
} from "./real-model.ts";

const MODEL_PROVIDER = "deepseek";
const MODEL_ID = "deepseek-v4-flash";
const TOP_K = 5;
const REPORT_FILE = "2026-08-20-selection-dev-paired-report.json";

const REQUEST_OPTIONS = Object.freeze({
  reasoning: "high" as const,
  temperature: 0,
  maxTokens: 256,
  timeoutMs: 120_000,
  maxRetries: 0,
});

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const visibleSkills = loader
    .getSkills()
    .skills.filter((skill) => skill.disableModelInvocation !== true);
  const discovery = createDiscoveryServices({ topK: TOP_K });
  const ingest = await discovery.run("", visibleSkills);
  if (!ingest.ok || discovery.state.catalog === undefined) {
    throw new Error("selection_catalog_ingest_failed");
  }
  const catalog = [...discovery.state.catalog.values()].map(({ record }) => record);

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = runtime.getModel(MODEL_PROVIDER, MODEL_ID);
  if (model === undefined) throw new Error("selection_model_not_found");
  const modelConfig: RealSelectionModelConfig = {
    provider: model.provider,
    modelId: model.id,
    api: model.api,
    thinkingLevel: REQUEST_OPTIONS.reasoning,
    temperature: REQUEST_OPTIONS.temperature,
    maxTokens: REQUEST_OPTIONS.maxTokens,
    timeoutMs: REQUEST_OPTIONS.timeoutMs,
    maxRetries: REQUEST_OPTIONS.maxRetries,
  };

  const report = await runRealSelectionPaired({
    catalog,
    cases: DEV_SELECTION_CASES,
    expectedCatalogHash: EXPECTED_CATALOG_HASH,
    expectedGoldSetHash: FROZEN_GOLD_SET_HASH,
    topK: TOP_K,
    generatedAt: new Date().toISOString(),
    model: modelConfig,
    complete: async (request) => {
      const response = await runtime.completeSimple(
        model,
        {
          systemPrompt: "Select only the installed skills required for the task. Follow the exact JSON response contract.",
          messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
        },
        REQUEST_OPTIONS,
      );
      return toCompletion(response);
    },
  });

  const reportsDir = path.resolve(projectRoot, "docs", "reports");
  if (!isPathInside(projectRoot, reportsDir)) {
    throw new Error("selection_report_path_outside_project");
  }
  await mkdir(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, REPORT_FILE);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  console.log(JSON.stringify({
    report: path.relative(projectRoot, reportPath).replaceAll("\\", "/"),
    sourceMode: report.sourceMode,
    catalogHash: report.paired.catalogHash,
    goldSetHash: report.paired.goldSetHash,
    fullCatalogExactSetAccuracy: report.paired.fullCatalog.exactSetAccuracy,
    topKExactSetAccuracy: report.paired.topK.exactSetAccuracy,
    topKGoldAvailability: report.paired.topK.retrievalGoldAvailability,
    totalActualTokens: report.usage.total.totalTokens,
  }));
}

function toCompletion(response: AssistantMessage) {
  return {
    text: response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(""),
    usage: response.usage,
    stopReason: response.stopReason,
    ...(response.responseModel === undefined
      ? {}
      : { responseModel: response.responseModel }),
  };
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

await main();
