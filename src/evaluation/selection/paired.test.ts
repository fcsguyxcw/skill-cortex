import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EVAL_CASES } from "../phase1/cases.ts";
import { SKILL_FIXTURES } from "../phase1/fixtures.ts";
import {
  computeCatalogHash,
  computeGoldSetHash,
  parseSelectionResponse,
  runSelectionPaired,
  type SelectionInvocationRequest,
} from "./paired.ts";

const validResponse = (ids: readonly string[]): string =>
  JSON.stringify({ selected_skill_ids: ids });

describe("selection paired evaluation", () => {
  it("uses the same cases/catalog/invoker for full-catalog and top-k arms", async () => {
    const requests: SelectionInvocationRequest[] = [];
    const report = await runSelectionPaired({
      catalog: SKILL_FIXTURES,
      cases: EVAL_CASES,
      topK: 2,
      invoker: async (request) => {
        requests.push(request);
        return validResponse(request.arm === "full_catalog" ? request.visibleSkillIds : []);
      },
    });

    assert.equal(requests.length, EVAL_CASES.length * 2);
    assert.deepEqual(
      requests.filter((request) => request.arm === "full_catalog").map((request) => request.caseId),
      EVAL_CASES.map((item) => item.id),
    );
    assert.deepEqual(
      requests.filter((request) => request.arm === "top_k").map((request) => request.caseId),
      EVAL_CASES.map((item) => item.id),
    );
    assert.equal(report.sourceMode, "evaluation_fixture");
    assert.equal(report.fullCatalog.caseCount, EVAL_CASES.length);
    assert.equal(report.topK.caseCount, EVAL_CASES.length);
  });

  it("shows all descriptions only in full_catalog and only retrieved cards in top_k", async () => {
    const requests: SelectionInvocationRequest[] = [];
    await runSelectionPaired({
      catalog: SKILL_FIXTURES,
      cases: [EVAL_CASES[0]!],
      topK: 1,
      invoker: async (request) => {
        requests.push(request);
        return validResponse([]);
      },
    });

    const full = requests.find((request) => request.arm === "full_catalog")!;
    const top = requests.find((request) => request.arm === "top_k")!;
    for (const skill of SKILL_FIXTURES) {
      assert.match(full.prompt, new RegExp(escapeRegExp(skill.name)));
      assert.match(full.prompt, new RegExp(escapeRegExp(skill.description)));
    }
    assert.equal(full.visibleSkillIds.length, SKILL_FIXTURES.length);
    assert.equal(top.visibleSkillIds.length, 1);
    assert.match(top.prompt, /## Available skill candidates/);
    const hidden = SKILL_FIXTURES.find((skill) => !top.visibleSkillIds.includes(skill.skillId))!;
    assert.doesNotMatch(top.prompt, new RegExp(escapeRegExp(hidden.description)));
    assert.ok(top.prompt.length < full.prompt.length);
  });

  it("reports retrieval availability separately and treats no-skill as available", async () => {
    const report = await runSelectionPaired({
      catalog: SKILL_FIXTURES,
      cases: [
        EVAL_CASES.find((item) => item.id === "multi_complementary")!,
        EVAL_CASES.find((item) => item.id === "no_skill_greeting")!,
      ],
      topK: 1,
      invoker: async () => validResponse([]),
    });

    assert.equal(report.fullCatalog.retrievalGoldAvailable, 2);
    assert.equal(report.fullCatalog.retrievalGoldMiss, 0);
    assert.equal(report.topK.retrievalGoldAvailable, 1);
    assert.equal(report.topK.retrievalGoldMiss, 1);

    await assert.rejects(
      runSelectionPaired({
        catalog: SKILL_FIXTURES,
        cases: [
          {
            id: "unknown_gold",
            query: "merge two PDF files",
            goldSkillIds: ["not-in-catalog"],
          },
        ],
        topK: 1,
        invoker: async () => validResponse([]),
      }),
      /gold skill id is not present in catalog/,
    );
  });

  it("requires strict JSON and counts invalid/duplicate IDs without crediting exact-set", async () => {
    const report = await runSelectionPaired({
      catalog: SKILL_FIXTURES,
      cases: [EVAL_CASES.find((item) => item.id === "single_en_pdf")!],
      invoker: async (request) =>
        request.arm === "full_catalog"
          ? "prefix {\"selected_skill_ids\":[\"pdf\"]}"
          : JSON.stringify({ selected_skill_ids: ["pdf", "pdf"] }),
    });

    assert.equal(report.fullCatalog.strictParseFailures, 1);
    assert.equal(report.fullCatalog.invalidSkillIdCases, 0);
    assert.equal(report.fullCatalog.exactSetMatches, 0);
    assert.equal(report.fullCatalog.exactSetAccuracy, 0);
    assert.equal(report.topK.strictParseFailures, 0);
    assert.equal(report.topK.invalidSkillIdCases, 0);
    assert.equal(report.topK.duplicateSkillIdCases, 1);
    assert.equal(report.topK.exactSetAccuracy, 0);
  });

  it("compares sets without ordering and rejects duplicate selected IDs", async () => {
    const report = await runSelectionPaired({
      catalog: SKILL_FIXTURES,
      cases: [EVAL_CASES.find((item) => item.id === "multi_complementary")!],
      topK: 1,
      invoker: async (request) =>
        request.arm === "full_catalog"
          ? validResponse(["chart-visualization", "data-analysis"])
          : validResponse(["data-analysis", "data-analysis", "chart-visualization"]),
    });

    assert.equal(report.fullCatalog.exactSetMatches, 1);
    assert.equal(report.fullCatalog.exactSetAccuracy, 1);
    assert.equal(report.topK.duplicateSkillIdCases, 1);
    assert.equal(report.topK.unlistedSkillIdCases, 1);
    assert.equal(report.topK.exactSetMatches, 0);
    assert.equal(report.topK.exactSetAccuracy, 0);
  });

  it("counts a catalog-external selected ID as invalid and keeps gold-available accuracy separate", async () => {
    const report = await runSelectionPaired({
      catalog: SKILL_FIXTURES,
      cases: [EVAL_CASES.find((item) => item.id === "single_en_pdf")!],
      topK: 1,
      invoker: async (request) =>
        request.arm === "full_catalog"
          ? validResponse(["pdf"])
          : validResponse(["not-in-catalog"]),
    });

    assert.equal(report.topK.retrievalGoldAvailable, 1);
    assert.equal(report.topK.retrievalGoldMiss, 0);
    assert.equal(report.fullCatalog.exactSetAccuracy, 1);
    assert.equal(report.fullCatalog.exactSetAccuracyWhenGoldAvailable, 1);
    assert.equal(report.topK.invalidSkillIdCases, 1);
    assert.equal(report.topK.invalidSkillIds, 1);
    assert.equal(report.topK.unknownSkillIds, 1);
    assert.equal(report.topK.unlistedSkillIds, 0);
    assert.equal(report.topK.exactSetAccuracyWhenGoldAvailable, 0);
    assert.equal(report.topK.exactSetAccuracy, 0);
  });

  it("reports prompt/token totals and latency percentiles with an explicit estimate label", async () => {
    const report = await runSelectionPaired({
      catalog: SKILL_FIXTURES,
      cases: EVAL_CASES.slice(0, 3),
      topK: 2,
      invoker: async () => validResponse([]),
    });

    for (const arm of [report.fullCatalog, report.topK]) {
      assert.ok(arm.promptChars > 0);
      assert.ok(arm.estimatedTokens > 0);
      assert.equal(arm.tokenEstimateMethod, "ceil(promptChars / 4)");
      assert.ok(arm.latencyMeanMs >= 0);
      assert.ok(arm.latencyP50Ms >= 0);
      assert.ok(arm.latencyP95Ms >= arm.latencyP50Ms);
      assert.equal(arm.cases.length, 3);
      for (const result of arm.cases) {
        assert.equal(result.estimatedTokens, Math.ceil(result.promptChars / 4));
      }
    }
    assert.ok(report.fullCatalog.promptChars > report.topK.promptChars);
    assert.ok(report.fullCatalog.estimatedTokens > report.topK.estimatedTokens);
  });

  it("binds the report to stable catalog and gold-set hashes", async () => {
    const requests: SelectionInvocationRequest[] = [];
    const run = (catalog: typeof SKILL_FIXTURES, cases: typeof EVAL_CASES) =>
      runSelectionPaired({
        catalog,
        cases,
        invoker: async (request) => {
          requests.push(request);
          return validResponse([]);
        },
      });

    const first = await run(SKILL_FIXTURES, EVAL_CASES);
    const reversedCatalog = [...SKILL_FIXTURES].reverse();
    const reversedCases = [...EVAL_CASES].reverse();
    const reordered = await run(reversedCatalog, reversedCases);
    assert.match(first.catalogHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(first.goldSetHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first.catalogHash, reordered.catalogHash);
    assert.equal(first.goldSetHash, reordered.goldSetHash);

    const changedDescription = SKILL_FIXTURES.map((skill) =>
      skill.skillId === "pdf"
        ? { ...skill, description: `${skill.description} extra` }
        : skill,
    );
    const changedRevision = SKILL_FIXTURES.map((skill) =>
      skill.skillId === "pdf"
        ? { ...skill, skillRevision: `${skill.skillRevision}:next` }
        : skill,
    );
    assert.notEqual(computeCatalogHash(changedDescription), first.catalogHash);
    assert.notEqual(computeCatalogHash(changedRevision), first.catalogHash);
    const changedQuery = EVAL_CASES.map((item) =>
      item.id === "single_en_pdf"
        ? { ...item, query: `${item.query} now` }
        : item,
    );
    const changedGold = EVAL_CASES.map((item) =>
      item.id === "single_en_pdf"
        ? { ...item, goldSkillIds: ["docx"] }
        : item,
    );
    assert.notEqual(
      computeGoldSetHash(first.catalogHash, changedQuery),
      first.goldSetHash,
    );
    assert.notEqual(
      computeGoldSetHash(first.catalogHash, changedGold),
      first.goldSetHash,
    );
    assert.notEqual(
      computeGoldSetHash(computeCatalogHash(changedDescription), EVAL_CASES),
      first.goldSetHash,
    );
  });
});

describe("selection output parser", () => {
  it("accepts only the exact selected_skill_ids object shape", () => {
    assert.deepEqual(parseSelectionResponse('{"selected_skill_ids":[]}'), {
      ok: true,
      selectedSkillIds: [],
    });
    assert.equal(parseSelectionResponse('{"selected_skill_ids":[],"extra":1}').ok, false);
    assert.equal(parseSelectionResponse('{"selected_skill_ids":"pdf"}').ok, false);
    assert.equal(parseSelectionResponse("not json").ok, false);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
