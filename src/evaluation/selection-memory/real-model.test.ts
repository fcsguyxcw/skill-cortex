import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  SELECTION_MEMORY_CALIBRATION_CONFIG,
  buildFrozenCalibrationCatalog,
  type SelectionCatalogSnapshot,
} from "./calibration-config.ts";
import { SELECTION_MEMORY_CALIBRATION_CASES } from "./calibration-cases.ts";
import { runRealSelectionMemoryCalibration } from "./real-model.ts";

const snapshot = JSON.parse(readFileSync(
  "docs/evaluation/2026-08-20-selection-catalog-snapshot.json",
  "utf8",
)) as SelectionCatalogSnapshot;
const catalog = buildFrozenCalibrationCatalog(snapshot);

describe("selection Memory-as-Context real-model adapter", () => {
  it("checks the frozen config before the first provider call", async () => {
    let calls = 0;
    await assert.rejects(
      runRealSelectionMemoryCalibration({
        catalog,
        cases: SELECTION_MEMORY_CALIBRATION_CASES,
        config: { ...SELECTION_MEMORY_CALIBRATION_CONFIG, topK: 4 },
        generatedAt: "2000-01-01T00:00:00.000Z",
        complete: async () => {
          calls += 1;
          return completion();
        },
      }),
      /selection_memory_calibration_config_hash_mismatch/,
    );
    assert.equal(calls, 0);
  });

  it("runs both frozen layers and stores only hashes, IDs, usage, and numeric evidence", async () => {
    const report = await runRealSelectionMemoryCalibration({
      catalog,
      cases: SELECTION_MEMORY_CALIBRATION_CASES,
      config: SELECTION_MEMORY_CALIBRATION_CONFIG,
      generatedAt: "2000-01-01T00:00:00.000Z",
      complete: async () => completion(),
    });
    assert.equal(report.sourceMode, "real_model");
    assert.equal(report.calls.length, 540);
    assert.equal(report.usage.callCount, 540);
    assert.equal(report.usage.totalTokens, 540 * 13);
    assert.equal(report.layers.selection_isolated.layer, "selection_isolated");
    assert.equal(report.layers.retrieval_controlled.layer, "retrieval_controlled");
    assert.equal(report.protocol.rawPromptsStored, false);
    assert.equal(report.protocol.rawResponsesStored, false);
    const serialized = JSON.stringify(report);
    for (const hidden of [
      SELECTION_MEMORY_CALIBRATION_CASES[0]!.query,
      "selected_skill_ids",
      "<skill_memory>",
    ]) assert.equal(serialized.includes(hidden), false, hidden);
  });

  it("fails fast after one provider error", async () => {
    let calls = 0;
    await assert.rejects(
      runRealSelectionMemoryCalibration({
        catalog,
        cases: SELECTION_MEMORY_CALIBRATION_CASES,
        config: SELECTION_MEMORY_CALIBRATION_CONFIG,
        generatedAt: "2000-01-01T00:00:00.000Z",
        complete: async () => {
          calls += 1;
          throw new Error("provider unavailable");
        },
      }),
      /selection_memory_invoker_error/,
    );
    assert.equal(calls, 1);
  });
});

function completion() {
  return {
    text: JSON.stringify({ selected_skill_ids: [] }),
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 1,
      totalTokens: 13,
      cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
    },
    stopReason: "stop",
    responseModel: "fixture-model",
  };
}
