import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  SELECTION_MEMORY_CALIBRATION_CONFIG,
  SELECTION_MEMORY_CALIBRATION_SYSTEM_PROMPT,
  buildFrozenCalibrationCatalog,
  type SelectionCatalogSnapshot,
} from "./calibration-config.ts";
import { SELECTION_MEMORY_CALIBRATION_CASES } from "./calibration-cases.ts";
import {
  assertFrozenSelectionMemoryCalibrationPreflight,
  runRealSelectionMemoryCalibration,
} from "./real-model.ts";

const SNAPSHOT_FILE = "docs/evaluation/2026-08-20-selection-catalog-snapshot.json";

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const projectRoot = path.resolve(process.cwd());
  const snapshotPath = path.resolve(projectRoot, SNAPSHOT_FILE);
  if (!isPathInside(projectRoot, snapshotPath)) throw new Error("selection_memory_snapshot_path_outside_project");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as SelectionCatalogSnapshot;
  const catalog = buildFrozenCalibrationCatalog(snapshot);
  assertFrozenSelectionMemoryCalibrationPreflight({
    catalog,
    cases: SELECTION_MEMORY_CALIBRATION_CASES,
    config: SELECTION_MEMORY_CALIBRATION_CONFIG,
  });

  const reportPath = path.resolve(
    projectRoot,
    "docs",
    "reports",
    SELECTION_MEMORY_CALIBRATION_CONFIG.report.file,
  );
  if (!isPathInside(projectRoot, reportPath)) throw new Error("selection_memory_report_path_outside_project");

  if (mode === "dry_run") {
    console.log(JSON.stringify({
      mode,
      billableCallsMade: 0,
      configHash: SELECTION_MEMORY_CALIBRATION_CONFIG.configHash,
      freezeHash: SELECTION_MEMORY_CALIBRATION_CONFIG.freezeHash,
      catalogContentHash: SELECTION_MEMORY_CALIBRATION_CONFIG.catalogContentHash,
      calibrationGoldSetHash: SELECTION_MEMORY_CALIBRATION_CONFIG.calibrationGoldSetHash,
      caseCount: SELECTION_MEMORY_CALIBRATION_CASES.length,
      expectedInvocationCount: SELECTION_MEMORY_CALIBRATION_CONFIG.expectedInvocationCount,
      report: path.relative(projectRoot, reportPath).replaceAll("\\", "/"),
    }));
    return;
  }

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const configured = SELECTION_MEMORY_CALIBRATION_CONFIG.model;
  const model = runtime.getModel(configured.provider, configured.modelId);
  if (model === undefined) throw new Error("selection_memory_model_not_found");
  if (model.api !== configured.api) throw new Error("selection_memory_model_api_mismatch");
  if (await runtime.getAuth(model) === undefined) {
    throw new Error("selection_memory_model_auth_not_configured");
  }

  const report = await runRealSelectionMemoryCalibration({
    catalog,
    cases: SELECTION_MEMORY_CALIBRATION_CASES,
    config: SELECTION_MEMORY_CALIBRATION_CONFIG,
    generatedAt: new Date().toISOString(),
    complete: async (request) => toCompletion(await runtime.completeSimple(
      model,
      {
        systemPrompt: SELECTION_MEMORY_CALIBRATION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
      },
      {
        reasoning: configured.thinkingLevel,
        temperature: configured.temperature,
        maxTokens: configured.maxTokens,
        timeoutMs: configured.timeoutMs,
        maxRetries: configured.maxRetries,
      },
    )),
  });

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(JSON.stringify({
    mode,
    report: path.relative(projectRoot, reportPath).replaceAll("\\", "/"),
    sourceMode: report.sourceMode,
    configHash: report.config.configHash,
    calls: report.calls.length,
    totalTokens: report.usage.totalTokens,
    totalCost: report.usage.costTotal,
  }));
}

function parseMode(args: readonly string[]): "dry_run" | "execute" {
  if (args.length === 0 || (args.length === 1 && args[0] === "--dry-run")) return "dry_run";
  if (args.length === 1 && args[0] === "--execute") return "execute";
  throw new Error("usage: node src/evaluation/selection-memory/run-calibration.ts [--dry-run|--execute]");
}

function toCompletion(response: AssistantMessage) {
  return {
    text: response.content.filter((item) => item.type === "text").map((item) => item.text).join(""),
    usage: response.usage,
    stopReason: response.stopReason,
    ...(response.responseModel === undefined ? {} : { responseModel: response.responseModel }),
  };
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

await main();
