import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEV_SELECTION_CASES,
  EXPECTED_CATALOG_HASH,
  FROZEN_GOLD_SET_HASH,
} from "./dev-cases.ts";
import { computeGoldSetHash } from "./paired.ts";

describe("frozen selection dev Gold v1", () => {
  it("contains 14 unique cases with the frozen label distribution", () => {
    assert.equal(DEV_SELECTION_CASES.length, 14);
    assert.equal(new Set(DEV_SELECTION_CASES.map((item) => item.id)).size, 14);
    assert.equal(new Set(DEV_SELECTION_CASES.map((item) => item.query)).size, 14);
    assert.equal(DEV_SELECTION_CASES.filter((item) => item.labelType === "single").length, 10);
    assert.equal(DEV_SELECTION_CASES.filter((item) => item.labelType === "multi").length, 2);
    assert.equal(DEV_SELECTION_CASES.filter((item) => item.labelType === "no_skill").length, 2);
    for (const item of DEV_SELECTION_CASES) {
      assert.equal(new Set(item.goldSkillIds).size, item.goldSkillIds.length);
      assert.equal(item.goldSkillIds.length === 0, item.labelType === "no_skill");
    }
  });

  it("matches the user-confirmed catalog-bound Gold hash", () => {
    assert.equal(
      computeGoldSetHash(EXPECTED_CATALOG_HASH, DEV_SELECTION_CASES),
      FROZEN_GOLD_SET_HASH,
    );
  });
});
