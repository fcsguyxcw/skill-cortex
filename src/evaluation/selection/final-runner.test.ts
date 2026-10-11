import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SkillRecord } from "../../core/contracts/index.ts";
import { computeCatalogHash, computeGoldSetHash } from "./paired.ts";
import { runFrozenFinalSelectionPaired } from "./final-runner.ts";
import { computeEvaluationRunConfigHash, type EvaluationRunConfig } from "./run-config.ts";

const SKILL: SkillRecord = {
  schemaVersion: 1,
  skillId: `skill:${"1".repeat(64)}`,
  skillRevision: `rev:${"2".repeat(64)}`,
  name: "fixture",
  description: "Fixture capability",
  scope: "project",
  sourceLocator: "D:/fixture/SKILL.md",
  sourceHash: `sha256:${"3".repeat(64)}`,
  dependencyManifest: [],
  discoveredAt: "2026-08-20T00:00:00.000Z",
  disableModelInvocation: false,
  declaredAliases: [],
  declaredPermissions: [],
  declaredEffects: [],
};
const CASE = { id: "F01", query: "Use fixture", goldSkillIds: [SKILL.skillId] };

function runConfig(goldSetHash: string): EvaluationRunConfig {
  return {
    schemaVersion: 1,
    catalogSnapshotHash: `sha256:${"5".repeat(64)}`,
    goldSetHash,
    thresholdConfigHash: `sha256:${"6".repeat(64)}`,
    model: { provider: "fixture", modelId: "fixture", api: "fixture", modelRevision: "v1" },
    inference: { reasoningLevel: "off", temperature: 0, maxTokens: 64, timeoutMs: 1000, maxRetries: 0 },
    selectionPromptHash: `sha256:${"7".repeat(64)}`,
    topK: 5,
    retriever: { name: "bm25", implementationRevision: "fixture-revision" },
    candidateCardSerializationRevision: "fixture-card-v1",
    host: { package: "fixture-host", version: "1.0.0" },
    armOrder: "full_catalog_then_top_k",
    supplementalToolsEnabled: false,
  };
}

describe("frozen final Selection runner", () => {
  it("checks run config before calls and records its identity", async () => {
    const catalogHash = computeCatalogHash([SKILL]);
    const goldSetHash = computeGoldSetHash(catalogHash, [CASE]);
    const config = runConfig(goldSetHash);
    const expectedRunConfigHash = computeEvaluationRunConfigHash(config);
    let calls = 0;
    const report = await runFrozenFinalSelectionPaired({
      catalog: [SKILL],
      cases: [CASE],
      expectedCatalogHash: catalogHash,
      expectedCatalogSnapshotHash: config.catalogSnapshotHash,
      expectedGoldSetHash: goldSetHash,
      expectedThresholdConfigHash: config.thresholdConfigHash,
      expectedRunConfigHash,
      runConfig: config,
      modelRevision: config.model.modelRevision,
      generatedAt: "2026-08-20T00:00:00.000Z",
      model: { provider: "fixture", modelId: "fixture", api: "fixture", thinkingLevel: "off", temperature: 0, maxTokens: 64, timeoutMs: 1000, maxRetries: 0 },
      complete: async () => {
        calls += 1;
        return {
          text: JSON.stringify({ selected_skill_ids: [SKILL.skillId] }),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
        };
      },
    });
    assert.equal(calls, 2);
    assert.equal(report.evidenceMode, "final_heldout_first_reveal");
    assert.equal(report.evaluationRunConfigHash, expectedRunConfigHash);
  });

  it("fails before provider calls when the run config hash drifts", async () => {
    const catalogHash = computeCatalogHash([SKILL]);
    const goldSetHash = computeGoldSetHash(catalogHash, [CASE]);
    const config = runConfig(goldSetHash);
    let calls = 0;
    await assert.rejects(
      runFrozenFinalSelectionPaired({
        catalog: [SKILL],
        cases: [CASE],
        expectedCatalogHash: catalogHash,
        expectedCatalogSnapshotHash: config.catalogSnapshotHash,
        expectedGoldSetHash: goldSetHash,
        expectedThresholdConfigHash: config.thresholdConfigHash,
        expectedRunConfigHash: `sha256:${"0".repeat(64)}`,
        runConfig: config,
        modelRevision: config.model.modelRevision,
        generatedAt: "2026-08-20T00:00:00.000Z",
        model: { provider: "fixture", modelId: "fixture", api: "fixture", thinkingLevel: "off", temperature: 0, maxTokens: 64, timeoutMs: 1000, maxRetries: 0 },
        complete: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      }),
      /final_selection_run_config_hash_mismatch/,
    );
    assert.equal(calls, 0);
  });
});
