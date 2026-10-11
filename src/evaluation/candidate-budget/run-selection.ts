import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { parseSelectionResponse } from "../selection/paired.ts";
import type { SelectionCatalogSnapshot } from "../selection-memory/calibration-config.ts";
import { CANDIDATE_BUDGET_SELECTION_CASES as CASES } from "./selection-cases.ts";

const ARMS = Object.freeze([
  { id: "k5_full", k: 5, limit: null },
  { id: "k3_full", k: 3, limit: null },
  { id: "k3_120", k: 3, limit: 120 },
  { id: "k3_240", k: 3, limit: 240 },
  { id: "k3_480", k: 3, limit: 480 },
] as const);
const REPEAT_COUNT = 3;
const SNAPSHOT = "docs/evaluation/2026-08-20-selection-catalog-snapshot.json";
const REPORT = "docs/reports/2026-09-07-g3-candidate-budget-selection.json";
const SYSTEM = "Select only the installed skills required for the task. Follow the exact JSON response contract.";

async function main(): Promise<void> {
  const execute = process.argv.length === 3 && process.argv[2] === "--execute";
  if (!execute && process.argv.length > 2) throw new Error("usage: node run-selection.ts [--execute]");
  const root = path.resolve(process.cwd());
  const snapshot = JSON.parse(await readFile(path.join(root, SNAPSHOT), "utf8")) as SelectionCatalogSnapshot;
  const byId = new Map(snapshot.entries.map((item) => [item.skillId, item]));
  const freeze = sha256(JSON.stringify({ cases: CASES, arms: ARMS, repeatCount: REPEAT_COUNT, model: "deepseek-v4-flash", system: SYSTEM }));
  if (!execute) {
    console.log(JSON.stringify({ mode: "dry_run", freezeHash: freeze, cases: CASES.length, calls: CASES.length * ARMS.length * REPEAT_COUNT, report: REPORT }));
    return;
  }
  const reportPath = path.join(root, REPORT);
  try { await readFile(reportPath); throw new Error("candidate_budget_selection_already_run"); } catch (error) {
    if (error instanceof Error && error.message === "candidate_budget_selection_already_run") throw error;
  }
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  const model = runtime.getModel("deepseek", "deepseek-v4-flash");
  if (model === undefined || await runtime.getAuth(model) === undefined) throw new Error("candidate_budget_model_unavailable");
  const calls: Array<Record<string, unknown>> = [];
  for (const item of CASES) {
    for (const arm of ARMS) {
      const candidates = item.candidateSkillIds.slice(0, arm.k).map((id) => {
        const entry = byId.get(id);
        if (entry === undefined) throw new Error("candidate_budget_catalog_member_missing");
        const description = arm.limit === null ? entry.description : entry.description.slice(0, arm.limit);
        return { id, name: entry.name, revision: entry.skillRevision, description };
      });
      const prompt = [
        'Output exactly one JSON object: {"selected_skill_ids":["skill-id"]}.',
        "Return an empty array when no candidate is required. Do not output markdown or explanation.",
        `Task: ${item.query}`,
        "Candidates:",
        ...candidates.map((candidate) => JSON.stringify(candidate)),
      ].join("\n");
      for (let repeatIndex = 0; repeatIndex < REPEAT_COUNT; repeatIndex += 1) {
        const response = await runtime.completeSimple(model, { systemPrompt: SYSTEM, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { reasoning: "high", temperature: 0, maxTokens: 256, timeoutMs: 120_000, maxRetries: 0 });
        const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        const parsed = parseSelectionResponse(text);
        const selected = parsed.ok ? parsed.selectedSkillIds : [];
        calls.push({ caseId: item.id, slice: item.slice, arm: arm.id, repeatIndex, exactSetMatch: parsed.ok && sameSet(selected, item.goldSkillIds), parseOk: parsed.ok, selectedSkillIds: selected, responseHash: sha256(text), usage: response.usage, stopReason: response.stopReason });
      }
    }
  }
  const summaries = Object.fromEntries(ARMS.map((arm) => {
    const rows = calls.filter((call) => call.arm === arm.id);
    const bySlice = Object.fromEntries(["single", "multi", "no_skill", "hard_confuser"].map((slice) => {
      const subset = rows.filter((call) => call.slice === slice);
      return [slice, subset.filter((call) => call.exactSetMatch === true).length / subset.length];
    }));
    return [arm.id, { exactSetAccuracy: rows.filter((call) => call.exactSetMatch === true).length / rows.length, bySlice }];
  }));
  const report = { schemaVersion: 1, sourceMode: "real_model", generatedAt: new Date().toISOString(), freezeHash: freeze, protocol: { rawPromptsStored: false, rawResponsesStored: false, casesChangedAfterRun: false }, arms: ARMS, repeatCount: REPEAT_COUNT, summaries, calls };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ report: REPORT, freezeHash: freeze, summaries }));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

await main();
