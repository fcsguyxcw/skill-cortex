import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { SELECTION_MEMORY_HELDOUT_CONFIG } from "./heldout-config.ts";
import type { RealSelectionMemoryHeldoutReport } from "./heldout-runner.ts";

const REPORT_FILE = "docs/reports/2026-08-20-selection-memory-context-heldout.json";
const EXPECTED_REPORT_HASH =
  "sha256:3ad48fbed61c38b266cc4186418288a4493f37776cd56bcf64cf68e69b4406d2";

describe("selection Memory-as-Context first-reveal held-out report", () => {
  const text = readFileSync(REPORT_FILE, "utf8");
  const report = JSON.parse(text) as RealSelectionMemoryHeldoutReport;

  it("pins the immutable report and frozen run config", () => {
    assert.equal(sha256(text), EXPECTED_REPORT_HASH);
    assert.equal(report.sourceMode, "real_model");
    assert.equal(report.protocol.firstReveal, true);
    assert.equal(report.config.configHash, SELECTION_MEMORY_HELDOUT_CONFIG.configHash);
    assert.equal(report.calls.length, 540);
    assert.equal(report.usage.callCount, 540);
    const unique = new Set(report.calls.map((item) =>
      `${item.layer}|${item.caseId}|${item.arm}|${item.repeatIndex}`
    ));
    assert.equal(unique.size, 540);
  });

  it("keeps private model inputs and outputs out of the report", () => {
    assert.equal(report.protocol.rawPromptsStored, false);
    assert.equal(report.protocol.rawResponsesStored, false);
    assert.equal(report.protocol.queriesStored, false);
    assert.equal(text.includes('"prompt":'), false);
    assert.equal(text.includes('"query":'), false);
    assert.equal(text.includes('"rawResponse":'), false);
  });

  it("freezes the observed selection and retrieval metrics", () => {
    const selection = report.layers.selection_isolated;
    assert.equal(selection.goldAvailability.recallAtK, 1);
    assert.equal(selection.arms.description_only.exactSetAccuracy, 84 / 90);
    assert.equal(selection.arms.positive_memory.exactSetAccuracy, 87 / 90);
    assert.equal(selection.arms.structured_memory.exactSetAccuracy, 89 / 90);
    assert.equal(selection.arms.structured_memory.noSkillFalsePositiveCalls, 0);
    assert.equal(selection.arms.structured_memory.strictParseFailures, 0);
    assert.equal(selection.arms.structured_memory.unknownSkillIdCalls, 0);
    assert.equal(selection.arms.structured_memory.unlistedSkillIdCalls, 0);
    assert.equal(selection.arms.structured_memory.duplicateSkillIdCalls, 0);

    const retrieval = report.layers.retrieval_controlled;
    assert.equal(retrieval.goldAvailability.availableCases, 13);
    assert.equal(retrieval.goldAvailability.missedCases, 17);
    assert.equal(retrieval.goldAvailability.recallAtK, 13 / 30);
    assert.equal(retrieval.arms.structured_memory.exactSetAccuracy, 39 / 90);
    assert.equal(retrieval.arms.structured_memory.exactSetAccuracyWhenGoldAvailable, 1);
  });
});

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
