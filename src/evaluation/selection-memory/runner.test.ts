import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SkillCandidate, SkillRecord } from "../../core/contracts/index.ts";
import { runSelectionMemoryEvaluation } from "./runner.ts";
import { SELECTION_MEMORY_TARGET_SKILLS, selectionMemoryCase } from "./evidence-cases.ts";

const A = `skill:${"a".repeat(64)}`;
const B = `skill:${"b".repeat(64)}`;
const C = `skill:${"c".repeat(64)}`;

const CATALOG = [record(A, "alpha"), record(B, "beta"), record(C, "gamma")];
const CASES = [
  selectionMemoryCase("T1", "calibration", "zh", "中文安全任务", [A], [A, B], true),
  selectionMemoryCase("T2", "calibration", "en", "English combined task", [A, B], [A, B], true),
  selectionMemoryCase("T3", "calibration", "en", "What does this term mean?", [], [A, B], false),
] as const;

describe("selection Memory-as-Context runner", () => {
  it("calls every case/arm/repeat with fixed candidates and keeps raw text out of the report", async () => {
    const requests: Array<{ caseId: string; arm: string; repeatIndex: number; ids: string[]; inventory: string }> = [];
    const report = await runSelectionMemoryEvaluation({
      layer: "selection_isolated",
      catalog: CATALOG,
      cases: CASES,
      repeatCount: 3,
      invoker: async (request) => {
        requests.push({
          caseId: request.caseId,
          arm: request.arm,
          repeatIndex: request.repeatIndex,
          ids: [...request.visibleSkillIds],
          inventory: request.candidateInventory,
        });
        const selected = request.caseId === "T1" ? [A] : request.caseId === "T2" ? [A, B] : [];
        return {
          text: JSON.stringify({ selected_skill_ids: selected }),
          latencyMs: 5,
          usage: { inputTokens: 20, outputTokens: 4, reasoningTokens: 2, totalTokens: 26 },
        };
      },
    });

    assert.equal(requests.length, 27);
    for (const caseId of CASES.map((item) => item.id)) {
      const perCase = requests.filter((item) => item.caseId === caseId);
      assert.equal(new Set(perCase.map((item) => item.ids.join("+"))).size, 1);
      assert.equal(new Set(perCase.map((item) => item.inventory)).size, 1);
    }
    assert.equal(report.arms.structured_memory.exactSetAccuracy, 1);
    assert.equal(report.slices.no_skill.structured_memory.noSkillFalsePositiveRate, 0);
    assert.equal(report.arms.structured_memory.repeatAgreementMean, 1);
    assert.equal(report.arms.structured_memory.pairwiseSetJaccardMean, 1);
    assert.equal(report.arms.structured_memory.usage.totalTokens, 234);
    const serialized = JSON.stringify(report);
    for (const hidden of [...CASES.map((item) => item.query), "selected_skill_ids", "<skill_memory>"]) {
      assert.equal(serialized.includes(hidden), false, hidden);
    }
  });

  it("classifies strict parse, unknown, unlisted, and duplicate failures", async () => {
    const outputs = [
      "not-json",
      JSON.stringify({ selected_skill_ids: [`skill:${"d".repeat(64)}`] }),
      JSON.stringify({ selected_skill_ids: [C] }),
      JSON.stringify({ selected_skill_ids: [A, A] }),
    ];
    let call = 0;
    const report = await runSelectionMemoryEvaluation({
      layer: "selection_isolated",
      catalog: CATALOG,
      cases: [CASES[0]],
      repeatCount: 4,
      invoker: async () => ({ text: outputs[call++ % outputs.length]!, latencyMs: 1 }),
    });
    const summary = report.arms.description_only;
    assert.equal(summary.strictParseFailures, 1);
    assert.equal(summary.unknownSkillIdCalls, 1);
    assert.equal(summary.unlistedSkillIdCalls, 1);
    assert.equal(summary.duplicateSkillIdCalls, 1);
    assert.equal(summary.exactSetAccuracy, 0);
  });

  it("reports Layer B Gold availability without supplementing retrieval", async () => {
    const report = await runSelectionMemoryEvaluation({
      layer: "retrieval_controlled",
      catalog: CATALOG,
      cases: [CASES[1]],
      repeatCount: 1,
      retrieveCandidates: () => [candidate(CATALOG[0]!)],
      invoker: async () => ({ text: JSON.stringify({ selected_skill_ids: [A] }), latencyMs: 1 }),
    });
    assert.equal(report.goldAvailability.availableCases, 0);
    assert.equal(report.goldAvailability.missedCases, 1);
    assert.equal(report.arms.description_only.exactSetAccuracyWhenGoldAvailable, 0);
    assert.equal(report.cases[0]!.candidateSkillIds.includes(B), false);
  });

  it("projects controlled evidence for a target Skill and exposes only numeric Memory diagnostics", async () => {
    const target = SELECTION_MEMORY_TARGET_SKILLS[0]!;
    const targetRecord = record(target.skillId, target.name, target.skillRevision);
    const evalCase = selectionMemoryCase(
      "T4",
      "calibration",
      "en",
      "Choose service boundaries and record the decision.",
      [target.skillId],
      [target.skillId],
      true,
    );
    const report = await runSelectionMemoryEvaluation({
      layer: "selection_isolated",
      catalog: [targetRecord],
      cases: [evalCase],
      repeatCount: 1,
      invoker: async () => ({
        text: JSON.stringify({ selected_skill_ids: [target.skillId] }),
        latencyMs: 1,
      }),
    });
    assert.equal(report.cases[0]!.memoryCardCount, 1);
    assert.equal(report.arms.description_only.memoryCharsMean, 0);
    assert.ok(report.arms.positive_memory.memoryCharsMean > 0);
    assert.ok(report.arms.structured_memory.memoryCharsMean > report.arms.positive_memory.memoryCharsMean);
    assert.deepEqual(report.arms.structured_memory.memoryOmissionReasons, {});
  });
});

function record(skillId: string, name: string, skillRevision = `rev:${skillId.slice(-64)}`): SkillRecord {
  return {
    schemaVersion: 1,
    skillId,
    skillRevision,
    name,
    description: `${name} description`,
    scope: "project",
    sourceLocator: `fixture:${name}`,
    sourceHash: `sha256:${skillId.slice(-64)}`,
    disableModelInvocation: false,
    declaredAliases: [],
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2000-01-01T00:00:00.000Z",
  };
}

function candidate(skill: SkillRecord): SkillCandidate {
  return {
    skillId: skill.skillId,
    skillRevision: skill.skillRevision,
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    retrievalScore: 1,
    evidence: [{ kind: "declared_text", field: "description" }],
  };
}
