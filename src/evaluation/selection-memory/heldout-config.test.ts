import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  buildFrozenCalibrationCatalog,
  type SelectionCatalogSnapshot,
} from "./calibration-config.ts";
import {
  SELECTION_MEMORY_CALIBRATION_REPORT_HASH,
  SELECTION_MEMORY_HELDOUT_CASE_HASH,
  SELECTION_MEMORY_HELDOUT_CONFIG,
  SELECTION_MEMORY_HELDOUT_GOLD_SET_HASH,
  assertFrozenSelectionMemoryHeldoutPreflight,
  computeSelectionMemoryHeldoutConfigHash,
} from "./heldout-config.ts";
import { SELECTION_MEMORY_HELDOUT_CASES } from "./heldout-cases.ts";
import { runRealSelectionMemoryHeldout } from "./heldout-runner.ts";
import type { RealSelectionMemoryCalibrationReport } from "./real-model.ts";

const EXPECTED_HELDOUT_CONFIG_HASH =
  "sha256:8b41fe8823196b024ec8f28285d44854df5255fdd187e64d9eca8bebb70291b0";
const calibrationText = readFileSync(
  "docs/reports/2026-08-20-selection-memory-context-calibration.json",
  "utf8",
);
const calibrationReport = JSON.parse(calibrationText) as RealSelectionMemoryCalibrationReport;
const calibrationReportHash = sha256(calibrationText);
const snapshot = JSON.parse(readFileSync(
  "docs/evaluation/2026-08-20-selection-catalog-snapshot.json",
  "utf8",
)) as SelectionCatalogSnapshot;
const catalog = buildFrozenCalibrationCatalog(snapshot);

describe("selection Memory-as-Context frozen held-out config", () => {
  it("binds the untouched cases and passing calibration before a provider call", () => {
    assert.equal(calibrationReportHash, SELECTION_MEMORY_CALIBRATION_REPORT_HASH);
    assert.equal(SELECTION_MEMORY_HELDOUT_CONFIG.configHash, EXPECTED_HELDOUT_CONFIG_HASH);
    assert.equal(
      computeSelectionMemoryHeldoutConfigHash(SELECTION_MEMORY_HELDOUT_CONFIG),
      EXPECTED_HELDOUT_CONFIG_HASH,
    );
    assert.equal(SELECTION_MEMORY_HELDOUT_CONFIG.heldoutCaseHash, SELECTION_MEMORY_HELDOUT_CASE_HASH);
    assert.equal(SELECTION_MEMORY_HELDOUT_CONFIG.heldoutGoldSetHash, SELECTION_MEMORY_HELDOUT_GOLD_SET_HASH);
    assert.equal(SELECTION_MEMORY_HELDOUT_CONFIG.expectedInvocationCount, 540);
    assert.doesNotThrow(() => assertFrozenSelectionMemoryHeldoutPreflight({
      catalog,
      cases: SELECTION_MEMORY_HELDOUT_CASES,
      config: SELECTION_MEMORY_HELDOUT_CONFIG,
      calibrationReport,
      calibrationReportHash,
    }));
  });

  it("fails closed on calibration or held-out tampering", () => {
    const failedCalibration = structuredClone(calibrationReport);
    (failedCalibration.layers.selection_isolated.arms.structured_memory as {
      exactSetAccuracy: number;
    }).exactSetAccuracy = 0;
    assert.throws(() => assertFrozenSelectionMemoryHeldoutPreflight({
      catalog,
      cases: SELECTION_MEMORY_HELDOUT_CASES,
      config: SELECTION_MEMORY_HELDOUT_CONFIG,
      calibrationReport: failedCalibration,
      calibrationReportHash,
    }), /selection_memory_calibration_accuracy_gate_failed/);
    assert.throws(() => assertFrozenSelectionMemoryHeldoutPreflight({
      catalog,
      cases: SELECTION_MEMORY_HELDOUT_CASES,
      config: SELECTION_MEMORY_HELDOUT_CONFIG,
      calibrationReport,
      calibrationReportHash: `sha256:${"0".repeat(64)}`,
    }), /selection_memory_calibration_report_hash_mismatch/);
    assert.throws(() => assertFrozenSelectionMemoryHeldoutPreflight({
      catalog,
      cases: SELECTION_MEMORY_HELDOUT_CASES.slice(1),
      config: SELECTION_MEMORY_HELDOUT_CONFIG,
      calibrationReport,
      calibrationReportHash,
    }), /selection_memory_heldout_case_hash_mismatch/);
  });

  it("runs the frozen two-layer shape without storing prompts, responses, or queries", async () => {
    const byId = new Map(SELECTION_MEMORY_HELDOUT_CASES.map((item) => [item.id, item]));
    const report = await runRealSelectionMemoryHeldout({
      catalog,
      cases: SELECTION_MEMORY_HELDOUT_CASES,
      config: SELECTION_MEMORY_HELDOUT_CONFIG,
      calibrationReport,
      calibrationReportHash,
      generatedAt: "2026-08-21T00:00:00.000Z",
      complete: async (request) => {
        const item = byId.get(request.caseId)!;
        const visible = new Set(request.visibleSkillIds);
        const selected = item.goldSkillIds.every((id) => visible.has(id)) ? item.goldSkillIds : [];
        return {
          text: JSON.stringify({ selected_skill_ids: selected }),
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
        };
      },
    });
    assert.equal(report.calls.length, 540);
    assert.equal(report.protocol.firstReveal, true);
    assert.equal(report.protocol.rawPromptsStored, false);
    assert.equal(report.protocol.rawResponsesStored, false);
    assert.equal(report.protocol.queriesStored, false);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(SELECTION_MEMORY_HELDOUT_CASES[0]!.query), false);
  });
});

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
