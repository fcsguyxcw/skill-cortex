import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { SkillRecord } from "../../core/contracts/index.ts";
import { DEV_SELECTION_CASES } from "../selection/dev-cases.ts";
import { FINAL_HELDOUT_CASES } from "../selection/final-heldout-cases.ts";
import {
  FROZEN_CANDIDATE_BUDGET_CONFIG_HASH,
  computeFrozenCandidateBudgetConfigHash,
  runFrozenCandidateBudgetEvaluation,
} from "./frozen-evaluation.ts";

const snapshot = JSON.parse(readFileSync(
  "docs/evaluation/2026-08-20-selection-catalog-snapshot.json",
  "utf8",
)) as {
  catalogHash: string;
  entries: Array<Pick<SkillRecord, "skillId" | "skillRevision" | "name" | "description">>;
};
const catalog: SkillRecord[] = snapshot.entries.map((item) => ({
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

describe("G3 Candidate Budget frozen evaluation（evaluation-only）", () => {
  it("配置 hash 冻结", () => {
    assert.equal(computeFrozenCandidateBudgetConfigHash(), FROZEN_CANDIDATE_BUDGET_CONFIG_HASH);
  });

  it("dev：K=3 保持 K=5 的 overall/multi availability，并降低候选与字符", () => {
    const report = runFrozenCandidateBudgetEvaluation({
      catalog,
      catalogHash: snapshot.catalogHash,
      cases: DEV_SELECTION_CASES,
      partition: "dev",
    });
    const k3 = report.budgets.find((item) => item.budget === 3)!;
    const k5 = report.budgets.find((item) => item.budget === 5)!;
    assert.equal(report.supportedBudget, 3);
    assert.equal(report.supportedBudgetPreservesBaseline, true);
    assert.equal(k3.goldFullSetAvailableCount, 10);
    assert.equal(k3.goldFullSetAvailableCount, k5.goldFullSetAvailableCount);
    assert.equal(k3.multiFullSetAvailableCount, 2);
    assert.equal(k3.multiFullSetAvailableCount, k5.multiFullSetAvailableCount);
    assert.equal(k3.totalCandidateCount, 28);
    assert.equal(k5.totalCandidateCount, 40);
    assert.ok(k3.candidateCountReductionFromBaseline >= 0.3);
    assert.ok(k3.descriptionCharReductionFromBaseline > 0.32);
    assert.equal(report.cardProjectionAtSupportedBudget.supportedDescriptionLimit, null);
  });

  it("frozen replay：K=3 保持 K=5 的 overall/multi/hard-confuser Gold availability", () => {
    const report = runFrozenCandidateBudgetEvaluation({
      catalog,
      catalogHash: snapshot.catalogHash,
      cases: FINAL_HELDOUT_CASES,
      partition: "frozen_replay",
    });
    const k3 = report.budgets.find((item) => item.budget === 3)!;
    const k5 = report.budgets.find((item) => item.budget === 5)!;
    assert.equal(report.supportedBudgetPreservesBaseline, true);
    assert.equal(k3.goldFullSetAvailableCount, 11);
    assert.equal(k3.goldFullSetAvailableCount, k5.goldFullSetAvailableCount);
    assert.equal(k3.multiFullSetAvailableCount, 1);
    assert.equal(k3.multiFullSetAvailableCount, k5.multiFullSetAvailableCount);
    assert.equal(k3.hardGoldFullSetAvailableCount, 9);
    assert.equal(k3.hardGoldFullSetAvailableCount, k5.hardGoldFullSetAvailableCount);
    assert.equal(k3.totalCandidateCount, 48);
    assert.equal(k5.totalCandidateCount, 71);
    assert.ok(k3.candidateCountReductionFromBaseline > 0.32);
    assert.ok(k3.descriptionCharReductionFromBaseline > 0.37);
  });

  it("卡片投影只证明字符缩减，不选择 description limit", () => {
    const report = runFrozenCandidateBudgetEvaluation({
      catalog,
      catalogHash: snapshot.catalogHash,
      cases: FINAL_HELDOUT_CASES,
      partition: "frozen_replay",
    });
    assert.equal(report.cardProjectionAtSupportedBudget.baselineDescriptionChars, 14143);
    assert.deepEqual(
      report.cardProjectionAtSupportedBudget.variants.map((item) => item.maxDescriptionChars),
      [120, 240, 480],
    );
    assert.equal(report.cardProjectionAtSupportedBudget.supportedDescriptionLimit, null);
    assert.ok(report.cardProjectionAtSupportedBudget.variants.every((item) =>
      item.totalDescriptionChars < report.cardProjectionAtSupportedBudget.baselineDescriptionChars),
    );
  });

  it("catalog/gold partition drift 均 fail closed", () => {
    assert.throws(() => runFrozenCandidateBudgetEvaluation({
      catalog,
      catalogHash: `sha256:${"f".repeat(64)}`,
      cases: DEV_SELECTION_CASES,
      partition: "dev",
    }), /candidate_budget_catalog_hash_mismatch/);
    assert.throws(() => runFrozenCandidateBudgetEvaluation({
      catalog,
      catalogHash: snapshot.catalogHash,
      cases: FINAL_HELDOUT_CASES,
      partition: "dev",
    }), /candidate_budget_gold_set_hash_mismatch/);
  });
});
