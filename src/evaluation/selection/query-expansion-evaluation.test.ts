import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { SkillRecord } from "../../core/contracts/index.ts";
import { FINAL_HELDOUT_CASES } from "./final-heldout-cases.ts";
import { QUERY_EXPANSION_EVAL_CASES } from "./query-expansion-cases.ts";
import { runQueryExpansionAblation } from "./query-expansion-evaluation.ts";

const catalog = loadSnapshotCatalog();

test("query expansion evaluation uses new balanced calibration/dev cases", () => {
  assert.equal(QUERY_EXPANSION_EVAL_CASES.length, 24);
  assert.equal(QUERY_EXPANSION_EVAL_CASES.filter((item) => item.partition === "calibration").length, 12);
  assert.equal(QUERY_EXPANSION_EVAL_CASES.filter((item) => item.partition === "dev").length, 12);
  assert.equal(QUERY_EXPANSION_EVAL_CASES.filter((item) => item.language === "zh").length, 12);
  assert.equal(QUERY_EXPANSION_EVAL_CASES.filter((item) => item.language === "en").length, 12);
  assert.equal(QUERY_EXPANSION_EVAL_CASES.filter((item) => item.labelType === "single").length, 12);
  assert.equal(QUERY_EXPANSION_EVAL_CASES.filter((item) => item.labelType === "multi").length, 4);
  assert.equal(QUERY_EXPANSION_EVAL_CASES.filter((item) => item.labelType === "no_skill").length, 8);
  const finalQueries = new Set(FINAL_HELDOUT_CASES.map((item) => item.query));
  assert.ok(QUERY_EXPANSION_EVAL_CASES.every((item) => !finalQueries.has(item.query)));
});

test("ablation reports Recall@K groups and No-Skill false positives", () => {
  const report = runQueryExpansionAblation({ catalog, cases: QUERY_EXPANSION_EVAL_CASES, topK: 5 });
  assert.equal(report.sourceMode, "evaluation_fixture");
  assert.equal(report.baseline.metrics.zh.goldCaseCount, 8);
  assert.equal(report.baseline.metrics.en.goldCaseCount, 8);
  assert.equal(report.baseline.metrics.single.goldCaseCount, 12);
  assert.equal(report.baseline.metrics.multi.goldCaseCount, 4);
  assert.equal(report.baseline.metrics.noSkill.noSkillCaseCount, 8);
  assert.equal(report.baseline.metrics.overall.goldAvailabilityRecallAtK, 0.5);
  assert.equal(report.queryExpansion.metrics.overall.goldAvailabilityRecallAtK, 1);
  assert.equal(report.baseline.metrics.zh.goldAvailabilityRecallAtK, 0);
  assert.equal(report.queryExpansion.metrics.zh.goldAvailabilityRecallAtK, 1);
  assert.equal(report.baseline.metrics.en.goldAvailabilityRecallAtK, 1);
  assert.equal(report.queryExpansion.metrics.en.goldAvailabilityRecallAtK, 1);
  assert.equal(report.baseline.metrics.single.goldAvailabilityRecallAtK, 0.5);
  assert.equal(report.queryExpansion.metrics.single.goldAvailabilityRecallAtK, 1);
  assert.equal(report.baseline.metrics.multi.goldAvailabilityRecallAtK, 0.5);
  assert.equal(report.queryExpansion.metrics.multi.goldAvailabilityRecallAtK, 1);
  assert.equal(report.baseline.metrics.noSkill.noSkillFalsePositiveRate, 0.75);
  assert.equal(report.queryExpansion.metrics.noSkill.noSkillFalsePositiveRate, 0.75);
});

function loadSnapshotCatalog(): SkillRecord[] {
  const snapshot = JSON.parse(readFileSync("docs/evaluation/2026-08-20-selection-catalog-snapshot.json", "utf8")) as {
    entries: Array<Pick<SkillRecord, "skillId" | "skillRevision" | "name" | "description">>;
  };
  return snapshot.entries.map((item) => ({
    ...item,
    schemaVersion: 1,
    scope: "user",
    sourceLocator: "fixture://catalog-snapshot",
    sourceHash: `sha256:${"0".repeat(64)}`,
    disableModelInvocation: false,
    declaredAliases: [],
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2026-08-20T00:00:00.000Z",
  }));
}
