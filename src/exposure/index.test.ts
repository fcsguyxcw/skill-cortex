import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SkillCandidate, SkillRecord } from "../core/contracts/index.ts";
import { observeExposure } from "./index.ts";

const record = {
  skillId: "skill:" + "1".repeat(64), skillRevision: "rev:" + "2".repeat(64),
  name: "PDF", description: "Read PDF documents", scope: "project", sourceLocator: "x",
  sourceHash: "sha256:" + "3".repeat(64), disableModelInvocation: false,
  declaredAliases: ["文档读取"], declaredEffects: [], declaredPermissions: [],
  dependencyManifest: [], discoveredAt: "2026-08-23T00:00:00.000Z", schemaVersion: 1,
} satisfies SkillRecord;

function candidate(): SkillCandidate {
  return { skillId: record.skillId, skillRevision: record.skillRevision, name: record.name,
    description: record.description, scope: record.scope, retrievalScore: 4.2,
    evidence: [{ kind: "declared_text", field: "name" }, { kind: "learned_cue", cueId: "c1" }] };
}

describe("observeExposure shadow-only", () => {
  it("只投影候选数/分数/匹配字段，不产生 active decision", () => {
    const observation = observeExposure("please use PDF", [record], [candidate(), { ...candidate(), retrievalScore: 2 }]);
    assert.deepEqual(observation, { baselineWouldInject: true, candidateCount: 2, topScore: 4.2,
      secondScore: 2, topMatchFields: ["name", "learned_cue"], exactDeclaredReference: true });
    assert.equal("decision" in observation, false);
    assert.equal(JSON.stringify(observation).includes("please use"), false);
  });

  it("空候选保持 baseline 不注入；精确声明引用与召回独立", () => {
    assert.deepEqual(observeExposure("请使用文档读取", [record], []), {
      baselineWouldInject: false, candidateCount: 0, topMatchFields: [], exactDeclaredReference: true,
    });
  });

  it("ASCII 名称不做单词内误匹配，不维护任务类别规则", () => {
    assert.equal(observeExposure("edit a pdfdocument", [record], []).exactDeclaredReference, false);
    assert.equal(observeExposure("用PDF处理", [record], []).exactDeclaredReference, true);
  });
});
