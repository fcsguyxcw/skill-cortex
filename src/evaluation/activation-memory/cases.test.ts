import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { FINAL_HELDOUT_CASES } from "../selection/final-heldout-cases.ts";
import { QUERY_EXPANSION_EVAL_CASES } from "../selection/query-expansion-cases.ts";
import {
  ACTIVATION_MEMORY_CALIBRATION_CASES,
  ACTIVATION_MEMORY_CATALOG_HASH,
  ACTIVATION_MEMORY_EXPERIENCE_CASES,
  ACTIVATION_MEMORY_HELDOUT_CASES,
  ACTIVATION_MEMORY_NEGATIVE_CONTROLS,
  ACTIVATION_MEMORY_TARGET_SKILLS,
  computeActivationMemoryFixtureHash,
  FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH,
} from "./cases.ts";

const SNAPSHOT_PATH = path.join(process.cwd(), "docs", "evaluation", "2026-08-20-selection-catalog-snapshot.json");

interface CatalogSnapshot {
  catalogHash: string;
  entries: Array<{ skillId: string; name: string; skillRevision: string }>;
}

describe("activation-memory development fixture", () => {
  it("binds eight target skills to the frozen catalog ID and revision", async () => {
    const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as CatalogSnapshot;
    assert.equal(snapshot.catalogHash, ACTIVATION_MEMORY_CATALOG_HASH);
    assert.equal(ACTIVATION_MEMORY_TARGET_SKILLS.length, 8);
    assert.equal(new Set(ACTIVATION_MEMORY_TARGET_SKILLS.map((item) => item.skillId)).size, 8);

    const entryByName = new Map(snapshot.entries.map((entry) => [entry.name, entry]));
    for (const target of ACTIVATION_MEMORY_TARGET_SKILLS) {
      const entry = entryByName.get(target.name);
      assert.ok(entry, `catalog target missing: ${target.name}`);
      assert.equal(target.skillId, entry.skillId);
      assert.equal(target.skillRevision, entry.skillRevision);
    }
  });

  it("contains balanced, nested positive experience sequences", () => {
    assert.equal(ACTIVATION_MEMORY_EXPERIENCE_CASES.length, 64);
    assert.equal(new Set(ACTIVATION_MEMORY_EXPERIENCE_CASES.map((item) => item.id)).size, 64);
    assert.equal(ACTIVATION_MEMORY_EXPERIENCE_CASES.filter((item) => item.language === "zh").length, 32);
    assert.equal(ACTIVATION_MEMORY_EXPERIENCE_CASES.filter((item) => item.language === "en").length, 32);

    for (const target of ACTIVATION_MEMORY_TARGET_SKILLS) {
      const cases = ACTIVATION_MEMORY_EXPERIENCE_CASES.filter((item) => item.targetSkillId === target.skillId);
      assert.deepEqual(cases.map((item) => item.ordinal), [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.equal(cases.filter((item) => item.language === "zh").length, 4);
      assert.equal(cases.filter((item) => item.language === "en").length, 4);
      assert.equal(cases[0]?.language, target.earlyExperienceLanguage);
      assert.ok(cases.every((item) => item.targetSkillRevision === target.skillRevision));
      assert.ok(cases.every((item) => item.provenance === "evaluation_fixture"));
      assert.ok(cases.every((item) => item.expectedAttribution === "positive"));
    }
  });

  it("keeps calibration and untouched held-out structurally separate and balanced", () => {
    checkEvalPartition(ACTIVATION_MEMORY_CALIBRATION_CASES, "calibration");
    checkEvalPartition(ACTIVATION_MEMORY_HELDOUT_CASES, "heldout");

    const targetIds = new Set(ACTIVATION_MEMORY_TARGET_SKILLS.map((item) => item.skillId));
    const allEval = [...ACTIVATION_MEMORY_CALIBRATION_CASES, ...ACTIVATION_MEMORY_HELDOUT_CASES];
    assert.equal(new Set(allEval.map((item) => item.id)).size, 48);
    for (const item of allEval) {
      assert.equal(new Set(item.goldSkillIds).size, item.goldSkillIds.length);
      assert.equal(item.goldSkillIds.length === 0, item.labelType === "no_skill");
      assert.ok(item.goldSkillIds.every((skillId) => targetIds.has(skillId)), `unknown Gold ID: ${item.id}`);
    }
  });

  it("does not reuse final-heldout or query-expansion evaluation queries", () => {
    const prohibited = new Set([
      ...FINAL_HELDOUT_CASES.map((item) => item.query),
      ...QUERY_EXPANSION_EVAL_CASES.map((item) => item.query),
    ]);
    const fixtureQueries = [
      ...ACTIVATION_MEMORY_EXPERIENCE_CASES.map((item) => item.query),
      ...ACTIVATION_MEMORY_CALIBRATION_CASES.map((item) => item.query),
      ...ACTIVATION_MEMORY_HELDOUT_CASES.map((item) => item.query),
    ];
    assert.equal(new Set(fixtureQueries).size, fixtureQueries.length);
    for (const query of fixtureQueries) assert.equal(prohibited.has(query), false, `reused query: ${query}`);
  });

  it("defines each frozen negative-control mechanism once", () => {
    assert.equal(ACTIVATION_MEMORY_NEGATIVE_CONTROLS.length, 6);
    assert.deepEqual(
      new Set(ACTIVATION_MEMORY_NEGATIVE_CONTROLS.map((item) => item.kind)),
      new Set(["shuffled_profile", "unverified_success", "stale_revision", "deleted_evidence", "cross_scope", "near_miss_contamination"]),
    );
  });

  it("matches the catalog-bound frozen fixture hash", () => {
    assert.equal(computeActivationMemoryFixtureHash(), FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH);
  });
});

function checkEvalPartition(
  cases: readonly { partition: string; language: string; labelType: string }[],
  partition: "calibration" | "heldout",
): void {
  assert.equal(cases.length, 24);
  assert.ok(cases.every((item) => item.partition === partition));
  assert.equal(cases.filter((item) => item.language === "zh").length, 12);
  assert.equal(cases.filter((item) => item.language === "en").length, 12);
  assert.equal(cases.filter((item) => item.labelType === "single").length, 16);
  assert.equal(cases.filter((item) => item.labelType === "multi").length, 4);
  assert.equal(cases.filter((item) => item.labelType === "no_skill").length, 4);
}
