import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { DEV_SELECTION_CASES } from "./dev-cases.ts";
import {
  EXPECTED_CATALOG_HASH,
  FINAL_HELDOUT_CASES,
  FROZEN_FINAL_HELDOUT_GOLD_SET_HASH,
} from "./final-heldout-cases.ts";
import { computeGoldSetHash } from "./paired.ts";

const SNAPSHOT_PATH = path.join(
  process.cwd(),
  "docs",
  "evaluation",
  "2026-08-20-selection-catalog-snapshot.json",
);

interface CatalogSnapshot {
  catalogHash: string;
  entries: Array<{
    skillId: string;
    name: string;
    skillRevision: string;
    description: string;
  }>;
}

const EXPECTED_GOLD_NAMES_BY_CASE = Object.freeze({
  S02: ["pdf"],
  S03: ["xlsx"],
  S04: ["security-auditor"],
  S05: ["academic-paper-review"],
  S06: ["backtest-expert"],
  S07: ["vercel-deploy"],
  S08: ["tts"],
  T02: ["docx"],
  T03: ["chart-visualization"],
  T04: ["architecture-designer"],
  T05: ["systematic-literature-review"],
  T06: ["aminer-data-search"],
  T07: ["fitness-coach"],
  T08: ["amap-lbs-skill"],
  T09: ["feishu-perm"],
  M03: ["data-analysis", "chart-visualization"],
  M05: ["architecture-designer", "domain-modeling"],
  M04: ["research", "code-documentation"],
  M06: ["video-frames", "image-generation"],
  M07: ["tts", "video-generation"],
  N01: [],
  N02: [],
  N03: [],
  N04: [],
  N05: [],
  N06: [],
  N07: [],
  N08: [],
  N09: [],
  N10: [],
});

describe("frozen selection final-heldout Gold v1", () => {
  it("contains the 30 ACCEPT cases with the frozen distribution", () => {
    assert.equal(FINAL_HELDOUT_CASES.length, 30);
    assert.equal(new Set(FINAL_HELDOUT_CASES.map((item) => item.id)).size, 30);
    assert.equal(new Set(FINAL_HELDOUT_CASES.map((item) => item.query)).size, 30);
    assert.equal(FINAL_HELDOUT_CASES.filter((item) => item.labelType === "single").length, 15);
    assert.equal(FINAL_HELDOUT_CASES.filter((item) => item.labelType === "multi").length, 5);
    assert.equal(FINAL_HELDOUT_CASES.filter((item) => item.labelType === "no_skill").length, 10);
    assert.equal(FINAL_HELDOUT_CASES.filter((item) => item.language === "zh").length, 15);
    assert.equal(FINAL_HELDOUT_CASES.filter((item) => item.language === "en").length, 15);
    assert.equal(FINAL_HELDOUT_CASES.filter((item) => item.hardConfuser).length, 21);

    for (const item of FINAL_HELDOUT_CASES) {
      assert.equal(new Set(item.goldSkillIds).size, item.goldSkillIds.length);
      assert.equal(item.goldSkillIds.length === 0, item.labelType === "no_skill");
      assert.equal(typeof item.hardConfuser, "boolean");
    }

    const rejectedIds = new Set(["S01", "S09", "T01", "M01", "M02", "M08"]);
    assert.equal(
      FINAL_HELDOUT_CASES.some((item) => rejectedIds.has(item.id)),
      false,
    );
  });

  it("does not reuse a DEV_SELECTION_CASES query", () => {
    const devQueries = new Set(DEV_SELECTION_CASES.map((item) => item.query));
    for (const item of FINAL_HELDOUT_CASES) {
      assert.equal(devQueries.has(item.query), false, `query overlaps dev: ${item.id}`);
    }
  });

  it("maps each Gold name to the exact ID in the frozen catalog snapshot", async () => {
    const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as CatalogSnapshot;
    assert.equal(snapshot.catalogHash, EXPECTED_CATALOG_HASH);
    const idByName = new Map(snapshot.entries.map((entry) => [entry.name, entry.skillId]));
    for (const item of FINAL_HELDOUT_CASES) {
      const names = EXPECTED_GOLD_NAMES_BY_CASE[item.id as keyof typeof EXPECTED_GOLD_NAMES_BY_CASE];
      assert.ok(names, `missing expected Gold names for ${item.id}`);
      assert.deepEqual(
        item.goldSkillIds,
        names.map((name) => idByName.get(name)),
        `catalog ID mapping mismatch: ${item.id}`,
      );
    }
  });

  it("matches the frozen catalog-bound Gold hash", () => {
    assert.equal(
      computeGoldSetHash(EXPECTED_CATALOG_HASH, FINAL_HELDOUT_CASES),
      FROZEN_FINAL_HELDOUT_GOLD_SET_HASH,
    );
  });
});
