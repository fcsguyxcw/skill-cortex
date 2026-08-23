import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ACTIVATION_MEMORY_CALIBRATION_CASES,
  ACTIVATION_MEMORY_EXPERIENCE_CASES,
  ACTIVATION_MEMORY_HELDOUT_CASES,
} from "../activation-memory/cases.ts";
import { DEV_SELECTION_CASES } from "../selection/dev-cases.ts";
import { FINAL_HELDOUT_CASES } from "../selection/final-heldout-cases.ts";
import { measureQueryLeakage } from "../activation-memory/formation-contract.ts";
import { projectSelectionMemoryCard } from "./memory-card.ts";
import { SELECTION_MEMORY_CALIBRATION_CASES } from "./calibration-cases.ts";
import {
  SELECTION_MEMORY_CATALOG_HASH,
  SELECTION_MEMORY_EVIDENCE_CASES,
  SELECTION_MEMORY_TARGET_SKILLS,
  buildSelectionMemoryEvaluationProjection,
  computeSelectionMemoryCaseSetHash,
  computeSelectionMemoryEvidenceHash,
} from "./evidence-cases.ts";
import { SELECTION_MEMORY_HELDOUT_CASES } from "./heldout-cases.ts";
import {
  SELECTION_MEMORY_EXPERIMENT_CATALOG_HASH,
  SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS,
  SELECTION_MEMORY_FREEZE_HASH,
} from "./catalog.ts";

const EXPECTED_CATALOG_HASH =
  "sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7";
const EXPECTED_EXPERIMENT_CATALOG_HASH =
  "sha256:17307bc426e4ea973412cc706c25bf31b2fd4156a186a8fac077e6b0b6e06b8e";
const EXPECTED_FREEZE_HASH =
  "sha256:a974be7239f486eeb71f4f47d021c16731ba5da1fe1bc19877a68e1ccba2787f";

describe("selection Memory-as-Context Phase 2 data contract", () => {
  it("freezes two independent 30-case partitions with balanced quotas", () => {
    for (const [partition, cases] of [
      ["calibration", SELECTION_MEMORY_CALIBRATION_CASES],
      ["heldout", SELECTION_MEMORY_HELDOUT_CASES],
    ] as const) {
      assert.equal(cases.length, 30, partition);
      assert.deepEqual(count(cases.map((item) => item.labelType)), {
        single: 12,
        multi: 6,
        no_skill: 12,
      });
      assert.deepEqual(count(cases.map((item) => item.language)), { zh: 15, en: 15 });
      assert.ok(cases.filter((item) => item.hardConfuser).length >= 18);
      assert.ok(cases.every((item) => item.partition === partition));
    }
    assert.equal(SELECTION_MEMORY_CALIBRATION_CASES.filter((item) => item.hardConfuser).length, 22);
    assert.equal(SELECTION_MEMORY_HELDOUT_CASES.filter((item) => item.hardConfuser).length, 21);
  });

  it("keeps IDs/queries unique and every Layer A bundle fixed, bounded, and Gold-containing", () => {
    const allCases = [...SELECTION_MEMORY_CALIBRATION_CASES, ...SELECTION_MEMORY_HELDOUT_CASES];
    assert.equal(new Set(allCases.map((item) => item.id)).size, allCases.length);
    assert.equal(new Set(allCases.map((item) => normalize(item.query))).size, allCases.length);
    for (const item of allCases) {
      assert.equal(item.candidateSkillIds.length, 5, item.id);
      assert.equal(new Set(item.candidateSkillIds).size, 5, item.id);
      assert.equal(new Set(item.goldSkillIds).size, item.goldSkillIds.length, item.id);
      assert.ok(item.goldSkillIds.every((id) => item.candidateSkillIds.includes(id)), item.id);
      assert.equal(
        item.labelType,
        item.goldSkillIds.length === 0 ? "no_skill" : item.goldSkillIds.length === 1 ? "single" : "multi",
        item.id,
      );
    }
    const hash = computeSelectionMemoryCaseSetHash(allCases);
    assert.match(hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(computeSelectionMemoryCaseSetHash([...allCases].reverse()), hash);
  });

  it("binds target identities and all candidate IDs to the frozen catalog manifest", () => {
    const manifest = JSON.parse(readFileSync("docs/evaluation/2026-08-20-selection-catalog-manifest.json", "utf8")) as {
      catalogHash: string;
      entries: Array<{ skillId: string; skillRevision: string; name: string }>;
    };
    assert.equal(SELECTION_MEMORY_CATALOG_HASH, EXPECTED_CATALOG_HASH);
    assert.equal(manifest.catalogHash, EXPECTED_CATALOG_HASH);
    const byId = new Map(manifest.entries.map((entry) => [entry.skillId, entry]));
    for (const target of SELECTION_MEMORY_TARGET_SKILLS) {
      const entry = byId.get(target.skillId);
      assert.ok(entry, target.name);
      assert.equal(entry.name, target.name);
      assert.equal(entry.skillRevision, target.skillRevision);
    }
    for (const item of [...SELECTION_MEMORY_CALIBRATION_CASES, ...SELECTION_MEMORY_HELDOUT_CASES]) {
      for (const id of item.candidateSkillIds) assert.ok(byId.has(id), `${item.id}:${id}`);
    }
    const candidateUnion = [...new Set(
      [...SELECTION_MEMORY_CALIBRATION_CASES, ...SELECTION_MEMORY_HELDOUT_CASES]
        .flatMap((item) => item.candidateSkillIds),
    )].sort();
    assert.deepEqual(SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS, candidateUnion);
    assert.equal(SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS.length, 19);
    assert.ok(SELECTION_MEMORY_TARGET_SKILLS.every((target) =>
      SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS.includes(target.skillId)
    ));
    assert.equal(SELECTION_MEMORY_EXPERIMENT_CATALOG_HASH, EXPECTED_EXPERIMENT_CATALOG_HASH);
    assert.equal(SELECTION_MEMORY_FREEZE_HASH, EXPECTED_FREEZE_HASH);
  });

  it("stores controlled verified evidence rather than finished cards or raw task histories", () => {
    assert.equal(SELECTION_MEMORY_EVIDENCE_CASES.length, 48);
    assert.equal(new Set(SELECTION_MEMORY_EVIDENCE_CASES.map((item) => item.id)).size, 48);
    assert.match(computeSelectionMemoryEvidenceHash(), /^sha256:[0-9a-f]{64}$/);
    for (const target of SELECTION_MEMORY_TARGET_SKILLS) {
      const evidence = SELECTION_MEMORY_EVIDENCE_CASES.filter((item) => item.targetSkillId === target.skillId);
      assert.deepEqual(count(evidence.map((item) => item.evidenceClass)), {
        verified_positive: 2,
        near_miss: 1,
        boundary: 2,
        environment: 1,
      });
      assert.ok(evidence.every((item) => item.targetSkillRevision === target.skillRevision));
      assert.ok(evidence.every((item) => item.provenance === "evaluation_fixture"));
      assert.ok(evidence.every((item) => item.verification === "independent_fixture_review"));
      assert.equal(JSON.stringify(evidence).includes("rawQuery"), false);

      const projection = buildSelectionMemoryEvaluationProjection(target.skillId);
      const card = projectSelectionMemoryCard({
        candidate: { skillId: target.skillId, skillRevision: target.skillRevision },
        profile: projection.profile,
        tenantScopeHash: projection.tenantScopeHash,
        profileTenantScopeHash: projection.tenantScopeHash,
        sourceMode: "evaluation_fixture",
        boundaryExamples: projection.boundaryExamples,
      });
      assert.equal(card.ok, true, target.name);
      if (card.ok) {
        assert.equal(card.card.useWhen.length, 2);
        assert.equal(card.card.avoidWhen.length, 3);
        assert.equal(card.card.environmentRequirements.length, 1);
      }
    }
  });

  it("passes evidence/evaluation and calibration/heldout leakage audits", () => {
    const evidence = SELECTION_MEMORY_EVIDENCE_CASES.map((item) => ({
      id: item.id,
      text: item.evidenceClass === "environment"
        ? `${item.environmentKey ?? ""} ${item.environmentValueClass ?? ""}`
        : item.features.join(" "),
    }));
    const calibration = SELECTION_MEMORY_CALIBRATION_CASES.map((item) => ({ id: item.id, text: item.query }));
    const heldout = SELECTION_MEMORY_HELDOUT_CASES.map((item) => ({ id: item.id, text: item.query }));
    assert.equal(measureQueryLeakage(evidence, [...calibration, ...heldout]).passed, true);
    assert.equal(measureQueryLeakage(calibration, heldout).passed, true);
  });

  it("keeps held-out structure independent from calibration templates", () => {
    assert.ok(SELECTION_MEMORY_HELDOUT_CASES.slice(1).every((item, index) =>
      item.labelType !== SELECTION_MEMORY_HELDOUT_CASES[index]!.labelType
    ), "held-out labels must remain interleaved");

    const sameIndexLabelMatches = SELECTION_MEMORY_HELDOUT_CASES.filter((item, index) =>
      item.labelType === SELECTION_MEMORY_CALIBRATION_CASES[index]!.labelType
    ).length;
    assert.ok(sameIndexLabelMatches <= 12, `same-index label matches=${sameIndexLabelMatches}`);

    const calibrationPairs = new Set(SELECTION_MEMORY_CALIBRATION_CASES
      .filter((item) => item.labelType === "multi")
      .map((item) => [...item.goldSkillIds].sort().join("+")));
    const heldoutPairs = SELECTION_MEMORY_HELDOUT_CASES
      .filter((item) => item.labelType === "multi")
      .map((item) => [...item.goldSkillIds].sort().join("+"));
    assert.equal(heldoutPairs.filter((pair) => calibrationPairs.has(pair)).length, 0);

    const sameIndexNonEmptyGoldMatches = SELECTION_MEMORY_HELDOUT_CASES.filter((item, index) => {
      const calibration = SELECTION_MEMORY_CALIBRATION_CASES[index]!;
      return item.goldSkillIds.length > 0
        && calibration.goldSkillIds.length > 0
        && [...item.goldSkillIds].sort().join("+") === [...calibration.goldSkillIds].sort().join("+");
    }).length;
    assert.equal(sameIndexNonEmptyGoldMatches, 0);
  });

  it("keeps action cases free of direct Skill-label answer leakage", () => {
    const directLabels = /\b(?:audit|vulnerabilit(?:y|ies)|synthesi[sz]e|systematic literature review|chart|documentation)\b|审计|漏洞|系统综述|图表/iu;
    const actionCases = [...SELECTION_MEMORY_CALIBRATION_CASES, ...SELECTION_MEMORY_HELDOUT_CASES]
      .filter((item) => item.goldSkillIds.length > 0);
    for (const item of actionCases) assert.doesNotMatch(item.query, directLabels, item.id);
  });

  it("does not reuse prior Selection, Activation Memory, or QE development queries", () => {
    const priorQueries = [
      ...ACTIVATION_MEMORY_EXPERIENCE_CASES,
      ...ACTIVATION_MEMORY_CALIBRATION_CASES,
      ...ACTIVATION_MEMORY_HELDOUT_CASES,
      ...DEV_SELECTION_CASES,
      ...FINAL_HELDOUT_CASES,
    ].map((item) => ({ id: `prior:${item.id}`, text: item.query }));
    priorQueries.push(
      { id: "prior:qe-1", text: "请比较两种架构方案并记录 ADR，再整理 API 变更说明。" },
      { id: "prior:qe-2", text: "‘架构’这个词是什么意思？" },
      { id: "prior:qe-3", text: "API 是哪几个英文单词的缩写？" },
      { id: "prior:qe-4", text: "PDF 这三个字母代表什么？" },
    );
    const current = [...SELECTION_MEMORY_CALIBRATION_CASES, ...SELECTION_MEMORY_HELDOUT_CASES]
      .map((item) => ({ id: item.id, text: item.query }));
    const report = measureQueryLeakage(priorQueries, current);
    assert.equal(report.passed, true, JSON.stringify(report.violations));
  });

  it("keeps frozen Gold v1 synchronized with every case and binding hash", () => {
    const document = readFileSync("docs/evaluation/2026-08-20-selection-memory-context-gold-v1.md", "utf8");
    const protocol = readFileSync("docs/evaluation/2026-08-20-selection-memory-context-protocol.md", "utf8");
    assert.match(document, /FROZEN — 用户已确认；未运行 retriever 或模型/);
    assert.match(document, /Gold label、Gold metadata 和答案标记绝不暴露给模型/);
    assert.match(document, /Layer A 与 Layer B 的指标分别报告和解释/);
    assert.match(document, /## 5\. Independent held-out draft/);
    assert.match(protocol, /Gold label、Gold\s*metadata 和任何答案标记绝不进入模型 prompt/);
    assert.match(protocol, /Layer A 与 Layer B 必须分别报告、分别解释；不得相加、平均或合并成一个 accuracy/);
    assert.match(protocol, /不能宣称完整 132-Skill runtime end-to-end/);
    assert.match(document, /Gold 不能对完整 132-Skill catalog 宣称唯一/);
    for (const item of [...SELECTION_MEMORY_CALIBRATION_CASES, ...SELECTION_MEMORY_HELDOUT_CASES]) {
      assert.ok(document.includes(`| ${item.id} |`), item.id);
      assert.ok(document.includes(item.query), item.id);
    }
    assert.ok(document.includes(computeSelectionMemoryEvidenceHash()));
    assert.ok(document.includes(SELECTION_MEMORY_EXPERIMENT_CATALOG_HASH));
    assert.ok(document.includes(SELECTION_MEMORY_FREEZE_HASH));
    assert.ok(document.includes(computeSelectionMemoryCaseSetHash(SELECTION_MEMORY_CALIBRATION_CASES)));
    assert.ok(document.includes(computeSelectionMemoryCaseSetHash(SELECTION_MEMORY_HELDOUT_CASES)));
    assert.ok(document.includes(computeSelectionMemoryCaseSetHash([
      ...SELECTION_MEMORY_CALIBRATION_CASES,
      ...SELECTION_MEMORY_HELDOUT_CASES,
    ])));
  });
});

function count(values: readonly string[]): Record<string, number> {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]));
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
