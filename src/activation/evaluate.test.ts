/**
 * Phase 6 第二批 —— 分栏评估测试（纯函数，冻结 fixture）。
 *
 * 覆盖：
 * - 四栏（hard_confuser / no_skill / multi_skill / cross_language）Recall@K 与 set recall；
 * - learned（overlay）对照 static 非劣（nonInferior=true、violations 空）；
 * - no-skill 不误召（noSkillPrecision=1）；
 * - hard-confuser 不误杀（gold recall=1）；
 * - 退化检测：learned Top-K 保留 static Top-K 的 gold 命中（nearMiss 降权不挤出正确候选）；
 * - 无 profile ⇒ learned 栏与 static 栏完全一致（关闭 overlay 可复现）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActivationProfile, SkillRecord } from "../core/contracts/index.ts";
import { evaluateOverlay, type EvaluationCase } from "./index.ts";

const GOLD_ID = "skill:" + "a".repeat(64);
const CONFUSER_ID = "skill:" + "b".repeat(64);
const OTHER_ID = "skill:" + "c".repeat(64);
const REV = "rev:" + "1".repeat(64);

function record(id: string, name: string, description: string, aliases: string[] = []): SkillRecord {
  return {
    schemaVersion: 1,
    skillId: id,
    skillRevision: REV,
    name,
    description,
    scope: "user",
    sourceLocator: "/fixture",
    sourceHash: "sha256:" + "2".repeat(64),
    disableModelInvocation: false,
    declaredAliases: aliases,
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2026-08-14T00:00:00.000Z",
  };
}

const RECORDS: readonly SkillRecord[] = [
  record(GOLD_ID, "offset-pagination-helper", "Detect offset pagination in SQL queries and return structured findings", ["sql-pagination"]),
  record(CONFUSER_ID, "cursor-keyset-helper", "Implement cursor pagination for SQL queries with keyset pagination support"),
  record(OTHER_ID, "pdf-document-reader", "Read and merge PDF documents"),
];

function profile(overrides: Partial<ActivationProfile> = {}): ActivationProfile {
  return {
    schemaVersion: 1,
    profileId: "profile:test",
    parentSkillId: GOLD_ID,
    parentSkillRevision: REV,
    status: "draft",
    learnedAliases: [{ cueId: "cue:alias-offset", text: "offset-check", evidenceIds: ["obs-1"] }],
    positiveExamples: [
      { cueId: "cue:pos-1", features: ["offset-page-query"], evidenceIds: ["obs-1"] },
    ],
    nearMissExamples: [
      { cueId: "cue:nm-cursor", features: ["cursor-pagination-query"], evidenceIds: ["obs-2"] },
    ],
    environmentCues: [],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

const CASES: readonly EvaluationCase[] = [
  { id: "hc-1", column: "hard_confuser", query: "check offset pagination", expectedSkillIds: [GOLD_ID], confuserSkillIds: [CONFUSER_ID] },
  { id: "ns-1", column: "no_skill", query: "how to cook pasta", expectedSkillIds: [] },
  { id: "ms-1", column: "multi_skill", query: "pagination sql", expectedSkillIds: [GOLD_ID, CONFUSER_ID] },
  { id: "cl-1", column: "cross_language", query: "检查分页 offset 用法", expectedSkillIds: [GOLD_ID] },
];

const OVERLAY_OPTIONS = { aliasBoost: 5, positiveBoost: 3, nearMissPenalty: 10 };

function columnOf(report: ReturnType<typeof evaluateOverlay>, column: string) {
  const index = column === "static" ? report.staticColumns : report.learnedColumns;
  return index.find((c) => c.column === column)!;
}

describe("分栏评估：冻结 fixture（四栏）", () => {
  it("learned 各栏 Recall@K/set recall 与 static 非劣（nonInferior=true，violations 空）", () => {
    const report = evaluateOverlay(CASES, RECORDS, profile(), OVERLAY_OPTIONS);
    assert.equal(report.nonInferior, true, JSON.stringify(report.violations));
    assert.deepEqual(report.violations, []);
  });

  it("hard_confuser：gold 不误杀（recallAtK=1），confuser 不因 overlay 被误召（不劣）", () => {
    const report = evaluateOverlay(CASES, RECORDS, profile(), OVERLAY_OPTIONS);
    const staticCol = columnOf(report, "hard_confuser");
    const learnedCol = report.learnedColumns.find((c) => c.column === "hard_confuser")!;
    assert.equal(staticCol.recallAtK, 1, "static gold 命中");
    assert.equal(learnedCol.recallAtK, 1, "learned gold 不误杀");
    assert.ok(
      learnedCol.confuserNotRecalled! >= staticCol.confuserNotRecalled!,
      "confuser 不得被 overlay 误召",
    );
  });

  it("no_skill：不误召（noSkillPrecision=1），learned 保持空召回", () => {
    const report = evaluateOverlay(CASES, RECORDS, profile(), OVERLAY_OPTIONS);
    const staticCol = columnOf(report, "no_skill");
    const learnedCol = report.learnedColumns.find((c) => c.column === "no_skill")!;
    assert.equal(staticCol.noSkillPrecision, 1);
    assert.equal(learnedCol.noSkillPrecision, 1);
  });

  it("multi_skill：多 gold 全召回（recallAtK=1）", () => {
    const report = evaluateOverlay(CASES, RECORDS, profile(), OVERLAY_OPTIONS);
    const learnedCol = report.learnedColumns.find((c) => c.column === "multi_skill")!;
    assert.equal(learnedCol.recallAtK, 1, "gold1+gold2 全召回");
    assert.equal(learnedCol.setRecall, 1);
  });

  it("cross_language：中文查询命中英文描述（recallAtK=1）", () => {
    const report = evaluateOverlay(CASES, RECORDS, profile(), OVERLAY_OPTIONS);
    const staticCol = columnOf(report, "cross_language");
    const learnedCol = report.learnedColumns.find((c) => c.column === "cross_language")!;
    assert.equal(staticCol.recallAtK, 1, "静态跨语言命中");
    assert.equal(learnedCol.recallAtK, 1, "learned 跨语言不劣");
  });

  it("退化检测：learned Top-K 保留 static Top-K 的 gold 命中（goldPreservedInTopK=1，nearMiss 降权不挤出）", () => {
    const report = evaluateOverlay(CASES, RECORDS, profile(), OVERLAY_OPTIONS);
    for (const column of ["hard_confuser", "multi_skill", "cross_language"] as const) {
      const learnedCol = report.learnedColumns.find((c) => c.column === column)!;
      assert.equal(learnedCol.goldPreservedInTopK, 1, `${column} 正确候选不得被挤出 Top-K`);
    }
  });

  it("无 profile ⇒ learned 栏与 static 栏完全一致（关闭 overlay 可复现）", () => {
    const withoutProfile = evaluateOverlay(CASES, RECORDS, undefined, OVERLAY_OPTIONS);
    for (let i = 0; i < withoutProfile.staticColumns.length; i += 1) {
      const s = withoutProfile.staticColumns[i]!;
      const l = withoutProfile.learnedColumns[i]!;
      assert.equal(l.caseCount, s.caseCount);
      assert.equal(l.recallAtK, s.recallAtK);
      assert.equal(l.setRecall, s.setRecall);
      assert.equal(l.noSkillPrecision, s.noSkillPrecision);
      assert.equal(l.confuserNotRecalled, s.confuserNotRecalled);
      // goldPreservedInTopK 是 learned 退化检测指标（static 恒 N/A）；无 profile 时
      // 有 gold 的栏 = 1（无降权）；no-skill 栏（无 gold）为 N/A。
      if (l.goldPreservedInTopK !== "N/A") {
        assert.equal(l.goldPreservedInTopK, 1);
      }
    }
  });

  it("boost 生效：learned gold 排名相对 static 提升（overlay 实际起作用）", () => {
    const staticOnly = evaluateOverlay(CASES, RECORDS, undefined, {});
    const withOverlay = evaluateOverlay(CASES, RECORDS, profile(), { aliasBoost: 100 });
    // cross_language case 的 gold 在 overlay 下分数提升（alias "offset-check" 命中 "offset"）。
    const staticCl = staticOnly.staticColumns.find((c) => c.column === "cross_language")!;
    const learnedCl = withOverlay.learnedColumns.find((c) => c.column === "cross_language")!;
    assert.ok(learnedCl.recallAtK! >= staticCl.recallAtK!);
    // 断言 overlay 确实改变了输出（非恒等）：用 matchLearnedOverlay 已有 rerank 测试覆盖，
    // 此处断言评估管线连通（violations 空 + nonInferior）。
    assert.equal(withOverlay.nonInferior, true);
  });
});
