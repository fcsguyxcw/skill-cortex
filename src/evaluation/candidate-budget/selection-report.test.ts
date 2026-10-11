import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const REPORT = path.join(ROOT, "docs", "reports", "2026-09-07-g3-candidate-budget-selection.json");
const GATE_REGISTRY = path.join(ROOT, "config", "activation-memory-gates.json");
const PRODUCTION_ENTRY = path.join(ROOT, ".pi", "extensions", "skill-cortex", "index.ts");
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

  it("closes the optimization decision by retaining K=5/full in production", async () => {
    const registry = JSON.parse(await readFile(GATE_REGISTRY, "utf8"));
    assert.equal(
      registry.gates.find((gate: { gateId: string }) => gate.gateId === "G3")?.status,
      "closed_keep_k5_full",
    );
    const entry = await readFile(PRODUCTION_ENTRY, "utf8");
    assert.equal(entry.includes("topK: 5,"), true);
  });
});
