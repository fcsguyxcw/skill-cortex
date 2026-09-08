import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const REPORT = path.join(ROOT, "docs", "reports", "2026-09-07-g3-candidate-budget-selection.json");
const FREEZE = "sha256:40c750102dbd8e086b9b0107a09688b3ff6d25fb40747574712f677601740137";

describe("G3 frozen real-model selection report", () => {
  it("pins the complete run and rejects K=3 because multi-skill regresses", async () => {
    const report = JSON.parse(await readFile(REPORT, "utf8"));
    assert.equal(report.sourceMode, "real_model");
    assert.equal(report.freezeHash, FREEZE);
    assert.equal(report.calls.length, 180);
    assert.equal(report.calls.filter((call: { parseOk: boolean }) => !call.parseOk).length, 0);
    assert.equal(report.calls.filter((call: { stopReason: string }) => call.stopReason !== "stop").length, 0);
    const baseline = report.summaries.k5_full;
    for (const arm of ["k3_full", "k3_120", "k3_240", "k3_480"]) {
      assert.ok(report.summaries[arm].bySlice.multi < baseline.bySlice.multi);
    }
  });
});
