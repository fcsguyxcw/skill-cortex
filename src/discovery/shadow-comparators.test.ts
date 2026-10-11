import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SkillCandidate } from "../core/contracts/index.ts";
import { observeCandidateBudgets, observeCardProjections, projectLightweightCards } from "./shadow-comparators.ts";

function candidates(count = 6): SkillCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    skillId: `skill-${index + 1}`, skillRevision: `rev-${index + 1}`, name: `Skill ${index + 1}`,
    description: index === 0 ? "x".repeat(500) + "😀" : "short description",
    scope: "project", retrievalScore: 10 - index, evidence: [],
  }));
}

describe("Candidate Budget shadow comparator", () => {
  it("并行记录 K=1/2/3/5 的确定性前缀，不输出推荐或改变输入", () => {
    const input = candidates();
    const before = structuredClone(input);
    const result = observeCandidateBudgets(input);
    assert.deepEqual(result.variants.map((item) => [item.budget, item.candidateSkillIds.length]),
      [[1, 1], [2, 2], [3, 3], [5, 5]]);
    assert.equal("decision" in result, false);
    assert.deepEqual(input, before);
  });
});

describe("Lightweight card shadow projection", () => {
  it("只截断作者 description，保留 identity/name，不生成 hint", () => {
    const input = candidates(2);
    const cards = projectLightweightCards(input, 120);
    assert.equal(cards[0]!.displayDescription.length, 120);
    assert.equal(cards[0]!.skillId, input[0]!.skillId);
    assert.equal("activationHint" in cards[0]!, false);
    assert.equal(input[0]!.description.length > 500, true, "不得修改原候选");
    const surrogate = [{ ...input[0]!, description: "a".repeat(119) + "😀" }];
    assert.equal(projectLightweightCards(surrogate, 120)[0]!.displayDescription.length, 119,
      "不得留下被截断的 UTF-16 高代理项");
    assert.throws(() => projectLightweightCards(input, 0), /card_projection_limit/);
  });
  it("同时记录 120/240/480 三臂字符成本与截断数", () => {
    const result = observeCardProjections(candidates(2));
    assert.deepEqual(result.variants.map((item) => item.maxDescriptionChars), [120, 240, 480]);
    assert.ok(result.variants.every((item) => item.totalDescriptionChars <= result.baselineDescriptionChars));
    assert.deepEqual(result.variants.map((item) => item.truncatedCandidateCount), [1, 1, 1]);
  });
});
