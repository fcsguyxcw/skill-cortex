import assert from "node:assert/strict";
import test from "node:test";

import type { SelectionPairedCaseResult } from "./paired.ts";
import { evaluateFinalSelection } from "./final-verdict.ts";
import type { FrozenFinalSelectionReport } from "./final-runner.ts";

test("final selection verdict applies frozen gates and breakdowns", () => {
  const report = fixtureReport([
    pairedCase("S", true, true, true),
    pairedCase("N", true, true, true),
  ], 1000, 100);
  const verdict = evaluateFinalSelection(report, [
    caseMetadata("S", "single", "en", true),
    caseMetadata("N", "no_skill", "zh", false),
  ]);

  assert.equal(verdict.passed, true);
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.gates.actualInputTokenReduction.actual, 0.9);
  assert.equal(verdict.breakdowns.single.caseCount, 1);
  assert.equal(verdict.breakdowns.no_skill.caseCount, 1);
  assert.equal(verdict.breakdowns.hard_confuser.caseCount, 1);
  assert.equal(verdict.breakdowns.overall.topKExactSetAccuracy, 1);
});

test("final selection verdict fails closed on unavailable usage and regressions", () => {
  const report = fixtureReport([
    pairedCase("S", true, true, false),
    pairedCase("N", true, true, false),
  ], 0, 0, false);
  const verdict = evaluateFinalSelection(report, [
    caseMetadata("S", "single", "en", true),
    caseMetadata("N", "no_skill", "zh", false),
  ]);

  assert.equal(verdict.passed, false);
  assert.ok(verdict.failures.includes("pairedExactSetRegressionWhenGoldAvailable"));
  assert.ok(verdict.failures.includes("noSkillAccuracyRegression"));
  assert.ok(verdict.failures.includes("actualInputTokenReduction"));
  assert.equal(verdict.gates.actualInputTokenReduction.actual, null);
});

function caseMetadata(
  id: string,
  labelType: "single" | "multi" | "no_skill",
  language: "zh" | "en",
  hardConfuser: boolean,
) {
  return { id, query: `query-${id}`, goldSkillIds: [], labelType, language, hardConfuser };
}

function pairedCase(
  caseId: string,
  retrievalGoldAvailable: boolean,
  fullMatch: boolean,
  topKMatch: boolean,
): SelectionPairedCaseResult {
  const base = {
    caseId,
    goldSkillIds: [],
    retrievedSkillIds: [],
    strictParseFailure: false,
    selectedSkillIds: [],
    unknownSkillIds: [],
    unlistedSkillIds: [],
    duplicateSkillIds: [],
    promptChars: 1,
    estimatedTokens: 1,
    latencyMs: 1,
  };
  return {
    caseId,
    fullCatalog: {
      ...base,
      arm: "full_catalog",
      retrievalGoldAvailable: true,
      exactSetMatch: fullMatch,
    },
    topK: {
      ...base,
      arm: "top_k",
      retrievalGoldAvailable,
      exactSetMatch: topKMatch,
    },
  };
}

function fixtureReport(
  cases: readonly SelectionPairedCaseResult[],
  fullInput: number,
  topKInput: number,
  usageAvailable = true,
): Pick<FrozenFinalSelectionReport, "paired" | "usage"> {
  const arm = (name: "full_catalog" | "top_k") => {
    const selected = cases.map((item) => item[name === "full_catalog" ? "fullCatalog" : "topK"]);
    return {
      arm: name,
      caseCount: selected.length,
      cases: selected,
      retrievalGoldAvailable: selected.filter((item) => item.retrievalGoldAvailable).length,
      retrievalGoldMiss: selected.filter((item) => !item.retrievalGoldAvailable).length,
      retrievalGoldAvailability: selected.filter((item) => item.retrievalGoldAvailable).length / selected.length,
      retrievalGoldMissRate: selected.filter((item) => !item.retrievalGoldAvailable).length / selected.length,
      strictParseFailures: 0,
      unknownSkillIds: 0,
      unknownSkillIdCases: 0,
      unlistedSkillIds: 0,
      unlistedSkillIdCases: 0,
      invalidSkillIds: 0,
      invalidSkillIdCases: 0,
      duplicateSkillIds: 0,
      duplicateSkillIdCases: 0,
      exactSetMatches: selected.filter((item) => item.exactSetMatch).length,
      exactSetAccuracy: selected.filter((item) => item.exactSetMatch).length / selected.length,
      exactSetAccuracyWhenGoldAvailable: 1,
      promptChars: 1,
      estimatedTokens: 1,
      tokenEstimateMethod: "ceil(promptChars / 4)" as const,
      promptCharsMean: 1,
      estimatedTokensMean: 1,
      latencyMeanMs: 1,
      latencyP50Ms: 1,
      latencyP95Ms: 1,
    };
  };
  const usage = (input: number) => ({
    available: usageAvailable,
    callCount: cases.length,
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: input,
    costTotal: 0,
  });
  return {
    paired: {
      schemaVersion: 1,
      catalogHash: "catalog",
      goldSetHash: "gold",
      catalogSize: 1,
      caseCount: cases.length,
      topKLimit: 5,
      fullCatalog: arm("full_catalog"),
      topK: arm("top_k"),
      cases: [...cases],
    },
    usage: {
      fullCatalog: usage(fullInput),
      topK: usage(topKInput),
      total: usage(fullInput + topKInput),
    },
  };
}
