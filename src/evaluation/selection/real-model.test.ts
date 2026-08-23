import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SkillRecord } from "../../core/contracts/index.ts";
import { computeCatalogHash, computeGoldSetHash } from "./paired.ts";
import {
  runRealSelectionPaired,
  type RealSelectionModelConfig,
  type SelectionUsage,
} from "./real-model.ts";

const CATALOG: readonly SkillRecord[] = [record("a", "alpha"), record("b", "beta")];
const CASES = [
  { id: "D1", query: "use alpha", goldSkillIds: [CATALOG[0]!.skillId] },
  { id: "D2", query: "nothing applies", goldSkillIds: [] },
] as const;
const CATALOG_HASH = computeCatalogHash(CATALOG);
const GOLD_HASH = computeGoldSetHash(CATALOG_HASH, CASES);
const MODEL: RealSelectionModelConfig = {
  provider: "fixture-provider",
  modelId: "fixture-model",
  api: "fixture-api",
  thinkingLevel: "high",
  temperature: 0,
  maxTokens: 128,
  timeoutMs: 1_000,
  maxRetries: 0,
};
const USAGE: SelectionUsage = {
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 1,
  totalTokens: 12,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

describe("real-model selection evidence wrapper", () => {
  it("retains only hashes/usage/parsed IDs and labels actual-provider evidence separately", async () => {
    const secretRawText = JSON.stringify({ selected_skill_ids: [CATALOG[0]!.skillId] });
    const report = await runRealSelectionPaired({
      catalog: CATALOG,
      cases: CASES,
      expectedCatalogHash: CATALOG_HASH,
      expectedGoldSetHash: GOLD_HASH,
      topK: 2,
      generatedAt: "2026-08-20T00:00:00.000Z",
      model: MODEL,
      complete: async (request) => ({
        text: request.caseId === "D1" ? secretRawText : '{"selected_skill_ids":[]}',
        usage: USAGE,
        stopReason: "stop",
        responseModel: "fixture-response-model",
      }),
    });

    assert.equal(report.sourceMode, "real_model");
    assert.equal(report.paired.catalogHash, CATALOG_HASH);
    assert.equal(report.paired.goldSetHash, GOLD_HASH);
    assert.equal(report.calls.length, 4);
    assert.equal(report.usage.total.input, 40);
    assert.equal(report.usage.total.totalTokens, 48);
    assert.equal(report.usage.total.available, true);
    assert.ok(report.calls.every((item) => item.rawOutputHash?.startsWith("sha256:")));
    assert.ok(!JSON.stringify(report).includes(secretRawText));
  });

  it("rejects catalog or Gold drift before calling the provider", async () => {
    let calls = 0;
    const complete = async () => {
      calls += 1;
      return {
        text: '{"selected_skill_ids":[]}',
        usage: USAGE,
        stopReason: "stop",
      };
    };

    await assert.rejects(
      runRealSelectionPaired({
        catalog: CATALOG,
        cases: CASES,
        expectedCatalogHash: "sha256:wrong",
        expectedGoldSetHash: GOLD_HASH,
        topK: 2,
        generatedAt: "2026-08-20T00:00:00.000Z",
        model: MODEL,
        complete,
      }),
      /selection_catalog_hash_mismatch/,
    );
    await assert.rejects(
      runRealSelectionPaired({
        catalog: CATALOG,
        cases: CASES,
        expectedCatalogHash: CATALOG_HASH,
        expectedGoldSetHash: "sha256:wrong",
        topK: 2,
        generatedAt: "2026-08-20T00:00:00.000Z",
        model: MODEL,
        complete,
      }),
      /selection_gold_set_hash_mismatch/,
    );
    assert.equal(calls, 0);
  });
});

function record(suffix: string, name: string): SkillRecord {
  return {
    schemaVersion: 1,
    skillId: `skill:${suffix.repeat(64)}`,
    skillRevision: `rev:${suffix.repeat(64)}`,
    name,
    description: `${name} description`,
    scope: "project",
    sourceLocator: `D:/fixture/${name}/SKILL.md`,
    sourceHash: `sha256:${suffix.repeat(64)}`,
    dependencyManifest: [],
    discoveredAt: "2026-08-20T00:00:00.000Z",
    declaredAliases: [],
    declaredPermissions: [],
    declaredEffects: [],
    disableModelInvocation: false,
  };
}
