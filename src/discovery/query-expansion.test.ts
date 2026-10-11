import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SkillRecord } from "../core/contracts/index.ts";
import { buildQueryExpansionIndex, expandQuery } from "./query-expansion.ts";

describe("static query expansion baseline", () => {
  it("adds explainable English terms for action-oriented Chinese requests", () => {
    const expanded = expandQuery("请比较两种架构方案并记录 ADR，再整理 API 变更说明。");
    assert.deepEqual(expanded.matchedRuleIds, ["zh_architecture", "zh_code_documentation"]);
    assert.match(expanded.expandedQuery, /architecture/);
    assert.match(expanded.expandedQuery, /API documentation/);
  });

  it("does not expand concept-only No-Skill questions", () => {
    for (const query of ["‘架构’这个词是什么意思？", "API 是哪几个英文单词的缩写？", "PDF 这三个字母代表什么？"]) {
      assert.deepEqual(expandQuery(query), {
        originalQuery: query,
        expandedQuery: query,
        matchedRuleIds: [],
        addedTerms: [],
      });
    }
  });

  it("retrieves through expansion and exposes its trace", () => {
    const record = skill("architecture-designer", "Design architecture and record ADR decisions");
    const index = buildQueryExpansionIndex([record]);
    const result = index.searchWithTrace("请比较两个架构方案并记录取舍");
    assert.equal(result.candidates[0]?.skillId, record.skillId);
    assert.deepEqual(result.expansion.matchedRuleIds, ["zh_architecture"]);
    assert.deepEqual(index.search("unrelated"), []);
  });

  it("supports an empty-rule ablation arm", () => {
    const record = skill("architecture-designer", "Design architecture and record ADR decisions");
    const index = buildQueryExpansionIndex([record], undefined, []);
    const result = index.searchWithTrace("请比较两个架构方案并记录取舍");
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.expansion.matchedRuleIds, []);
    assert.equal(result.expansion.expandedQuery, result.expansion.originalQuery);
  });
});

function skill(name: string, description: string): SkillRecord {
  return {
    schemaVersion: 1,
    skillId: `skill:${"1".repeat(64)}`,
    skillRevision: `rev:${"2".repeat(64)}`,
    name,
    description,
    scope: "user",
    sourceLocator: "fixture://query-expansion",
    sourceHash: `sha256:${"3".repeat(64)}`,
    disableModelInvocation: false,
    declaredAliases: [],
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2026-08-20T00:00:00.000Z",
  };
}
