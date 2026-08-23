import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { createDiscoveryServices } from "../../adapters/pi/core.ts";
import {
  EXPECTED_CATALOG_HASH,
  FINAL_HELDOUT_CASES,
  FROZEN_FINAL_HELDOUT_GOLD_SET_HASH,
} from "./final-heldout-cases.ts";
import {
  FINAL_EVALUATION_RUN_CONFIG,
  FINAL_SELECTION_SYSTEM_PROMPT,
  FROZEN_CATALOG_SNAPSHOT_ENTRIES_HASH,
  FROZEN_FINAL_EVALUATION_RUN_CONFIG_HASH,
} from "./final-run-config.ts";
import { runFrozenFinalSelectionPaired } from "./final-runner.ts";
import { FINAL_SELECTION_THRESHOLD_CONFIG_HASH } from "./final-thresholds.ts";
import { evaluateFinalSelection } from "./final-verdict.ts";

const REPORT_FILE = "2026-08-20-selection-final-heldout-v1-report.json";
const CONFIRM_FLAG = "--confirm-first-reveal";
const MODEL_REVISION = "provider-alias:deepseek-v4-flash@2026-08-20";
const SOURCE_REVISIONS = Object.freeze({
  "src/discovery/bm25.ts": "sha256:eb2867e1cb220574b240c756d54d7143a79566fe85691fa7c487bbf499ccf2d4",
  "src/discovery/tokenize.ts": "sha256:3bafcd975eacc4bf43f548e381a869155c218685ea262bb4a2f383018d69a9cc",
  "src/discovery/candidate-card.ts": "sha256:5e33b93b506ad094f4304f60c6f08ea04deb0215c040383b1812b05ad4e2a273",
  "src/evaluation/selection/paired.ts": "sha256:6ecf652df6eb042bc82c26c34d627f1e749355a6274494a474093347ca705482",
});

async function main(): Promise<void> {
  if (!process.argv.includes(CONFIRM_FLAG)) {
    throw new Error(`final_selection_first_reveal_requires:${CONFIRM_FLAG}`);
  }
  const projectRoot = process.cwd();
  const reportsDir = path.join(projectRoot, "docs", "reports");
  const reportPath = path.join(reportsDir, REPORT_FILE);
  if (await exists(reportPath)) {
    throw new Error("final_selection_v1_already_revealed");
  }
  await verifySourceRevisions(projectRoot);

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
  const discovery = createDiscoveryServices({ topK: FINAL_EVALUATION_RUN_CONFIG.topK });
  const ingest = await discovery.run("", visibleSkills);
  if (!ingest.ok || discovery.state.catalog === undefined) {
    throw new Error("final_selection_catalog_ingest_failed");
  }
  const catalog = [...discovery.state.catalog.values()].map(({ record }) => record);

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = runtime.getModel(
    FINAL_EVALUATION_RUN_CONFIG.model.provider,
    FINAL_EVALUATION_RUN_CONFIG.model.modelId,
  );
  if (model === undefined) throw new Error("final_selection_model_not_found");

  const modelConfig = {
    provider: model.provider,
    modelId: model.id,
    api: model.api,
    thinkingLevel: FINAL_EVALUATION_RUN_CONFIG.inference.reasoningLevel,
    temperature: FINAL_EVALUATION_RUN_CONFIG.inference.temperature,
    maxTokens: FINAL_EVALUATION_RUN_CONFIG.inference.maxTokens,
    timeoutMs: FINAL_EVALUATION_RUN_CONFIG.inference.timeoutMs,
    maxRetries: FINAL_EVALUATION_RUN_CONFIG.inference.maxRetries,
  };
  const report = await runFrozenFinalSelectionPaired({
    catalog,
    cases: FINAL_HELDOUT_CASES,
    expectedCatalogHash: EXPECTED_CATALOG_HASH,
    expectedCatalogSnapshotHash: FROZEN_CATALOG_SNAPSHOT_ENTRIES_HASH,
    expectedGoldSetHash: FROZEN_FINAL_HELDOUT_GOLD_SET_HASH,
    expectedThresholdConfigHash: FINAL_SELECTION_THRESHOLD_CONFIG_HASH,
    expectedRunConfigHash: FROZEN_FINAL_EVALUATION_RUN_CONFIG_HASH,
    runConfig: FINAL_EVALUATION_RUN_CONFIG,
    modelRevision: MODEL_REVISION,
    generatedAt: new Date().toISOString(),
    model: modelConfig,
    complete: async (request) => toCompletion(await runtime.completeSimple(
      model,
      {
        systemPrompt: FINAL_SELECTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
      },
      {
        reasoning: FINAL_EVALUATION_RUN_CONFIG.inference.reasoningLevel as "high",
        temperature: FINAL_EVALUATION_RUN_CONFIG.inference.temperature,
        maxTokens: FINAL_EVALUATION_RUN_CONFIG.inference.maxTokens,
        timeoutMs: FINAL_EVALUATION_RUN_CONFIG.inference.timeoutMs,
        maxRetries: FINAL_EVALUATION_RUN_CONFIG.inference.maxRetries,
      },
    )),
  });

  const finalVerdict = evaluateFinalSelection(report, FINAL_HELDOUT_CASES);
  const finalReport = { ...report, finalVerdict };
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(JSON.stringify({
    report: path.relative(projectRoot, reportPath).replaceAll("\\", "/"),
    evidenceMode: report.evidenceMode,
    catalogHash: report.paired.catalogHash,
    goldSetHash: report.paired.goldSetHash,
    evaluationRunConfigHash: report.evaluationRunConfigHash,
    fullCatalogExactSetAccuracy: report.paired.fullCatalog.exactSetAccuracy,
    topKExactSetAccuracy: report.paired.topK.exactSetAccuracy,
    retrievalGoldAvailability: report.paired.topK.retrievalGoldAvailability,
    passed: finalVerdict.passed,
    failures: finalVerdict.failures,
  }));
}

async function verifySourceRevisions(projectRoot: string): Promise<void> {
  for (const [relativePath, expectedHash] of Object.entries(SOURCE_REVISIONS)) {
    const content = await readFile(path.join(projectRoot, relativePath));
    const actualHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (actualHash !== expectedHash) {
      throw new Error(`final_selection_source_revision_mismatch:${relativePath}`);
    }
  }
}

function toCompletion(response: AssistantMessage) {
  return {
    text: response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(""),
    usage: response.usage,
    stopReason: response.stopReason,
    ...(response.responseModel === undefined ? {} : { responseModel: response.responseModel }),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

await main();
