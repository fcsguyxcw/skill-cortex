import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  buildFrozenCalibrationCatalog,
  type SelectionCatalogSnapshot,
} from "./calibration-config.ts";
import {
  SELECTION_MEMORY_HELDOUT_CONFIG,
  SELECTION_MEMORY_HELDOUT_SYSTEM_PROMPT,
  assertFrozenSelectionMemoryHeldoutPreflight,
} from "./heldout-config.ts";
import { SELECTION_MEMORY_HELDOUT_CASES } from "./heldout-cases.ts";
import { runRealSelectionMemoryHeldout } from "./heldout-runner.ts";
import type { RealSelectionMemoryCalibrationReport } from "./real-model.ts";

const SNAPSHOT_FILE = "docs/evaluation/2026-08-20-selection-catalog-snapshot.json";
const CALIBRATION_REPORT_FILE = "docs/reports/2026-08-20-selection-memory-context-calibration.json";
const CONFIRM_FLAG = "--confirm-first-reveal";

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const projectRoot = path.resolve(process.cwd());
  const snapshotPath = resolveInside(projectRoot, SNAPSHOT_FILE);
  const calibrationPath = resolveInside(projectRoot, CALIBRATION_REPORT_FILE);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as SelectionCatalogSnapshot;
  const calibrationText = await readFile(calibrationPath, "utf8");
  const calibrationReport = JSON.parse(calibrationText) as RealSelectionMemoryCalibrationReport;
  const calibrationReportHash = sha256(calibrationText);
  const catalog = buildFrozenCalibrationCatalog(snapshot);
  assertFrozenSelectionMemoryHeldoutPreflight({
    catalog,
    cases: SELECTION_MEMORY_HELDOUT_CASES,
    config: SELECTION_MEMORY_HELDOUT_CONFIG,
    calibrationReport,
    calibrationReportHash,
  });

  const reportPath = resolveInside(
    projectRoot,
    path.join("docs", "reports", SELECTION_MEMORY_HELDOUT_CONFIG.report.file),
  );
  const reportExists = await exists(reportPath);
  if (mode === "execute" && reportExists) throw new Error("selection_memory_heldout_already_revealed");

  if (mode === "dry_run") {
    console.log(JSON.stringify({
      mode,
      billableCallsMade: 0,
      reportExists,
      configHash: SELECTION_MEMORY_HELDOUT_CONFIG.configHash,
      calibrationReportHash,
      heldoutCaseHash: SELECTION_MEMORY_HELDOUT_CONFIG.heldoutCaseHash,
      heldoutGoldSetHash: SELECTION_MEMORY_HELDOUT_CONFIG.heldoutGoldSetHash,
      caseCount: SELECTION_MEMORY_HELDOUT_CASES.length,
      expectedInvocationCount: SELECTION_MEMORY_HELDOUT_CONFIG.expectedInvocationCount,
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
  const configured = SELECTION_MEMORY_HELDOUT_CONFIG.model;
  const model = runtime.getModel(configured.provider, configured.modelId);
  if (model === undefined) throw new Error("selection_memory_heldout_model_not_found");
  if (model.api !== configured.api) throw new Error("selection_memory_heldout_model_api_mismatch");
  if (await runtime.getAuth(model) === undefined) {
    throw new Error("selection_memory_heldout_model_auth_not_configured");
  }

  const report = await runRealSelectionMemoryHeldout({
    catalog,
    cases: SELECTION_MEMORY_HELDOUT_CASES,
    config: SELECTION_MEMORY_HELDOUT_CONFIG,
    calibrationReport,
    calibrationReportHash,
    generatedAt: new Date().toISOString(),
    complete: async (request) => toCompletion(await runtime.completeSimple(
      model,
      {
        systemPrompt: SELECTION_MEMORY_HELDOUT_SYSTEM_PROMPT,
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
  if (args.length === 1 && args[0] === CONFIRM_FLAG) return "execute";
  throw new Error(`usage: node src/evaluation/selection-memory/run-heldout.ts [--dry-run|${CONFIRM_FLAG}]`);
}

function toCompletion(response: AssistantMessage) {
  return {
    text: response.content.filter((item) => item.type === "text").map((item) => item.text).join(""),
    usage: response.usage,
    stopReason: response.stopReason,
    ...(response.responseModel === undefined ? {} : { responseModel: response.responseModel }),
  };
}

function resolveInside(projectRoot: string, relativePath: string): string {
  const resolved = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, resolved);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) throw new Error("selection_memory_heldout_path_outside_project");
  return resolved;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

await main();
