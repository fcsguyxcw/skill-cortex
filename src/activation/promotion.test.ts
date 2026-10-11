/**
 * Phase 6 第三批 —— promotion gate 测试（Gate P6 判门，纯函数）。
 *
 * 覆盖：
 * - 达标 report（nonInferior=true + 各栏 recall 达门槛）⇒ ok；
 * - nonInferior=false（overlay 退化）⇒ 拒绝 overlay_not_non_inferior + violations；
 * - 单栏 recall 低于冻结门槛 ⇒ 拒绝（reasons 可审计）；
 * - N/A 栏（no-skill 无 gold）不虚判（noSkillPrecision 单独判）；
 * - 门槛覆盖（自定义 thresholds）；与 evaluateOverlay 集成：真实报告消费。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OverlayEvaluationReport } from "./index.ts";
import {
  evaluateOverlay,
  evaluateProfilePromotion,
  FROZEN_REQUIRED_COLUMNS,
  PROMOTION_THRESHOLDS,
} from "./index.ts";

function column(overrides: Partial<OverlayEvaluationReport["learnedColumns"][number]> = {}) {
  return {
    column: "hard_confuser" as const,
    caseCount: 1,
    recallAtK: 1,
    setRecall: 1,
    noSkillPrecision: "N/A" as const,
    confuserNotRecalled: 1,
    goldPreservedInTopK: 1,
    ...overrides,
  };
}

function reportOf(overrides: Partial<OverlayEvaluationReport> = {}): OverlayEvaluationReport {
  return {
    staticColumns: [column()],
    learnedColumns: [
      column({ column: "hard_confuser" }),
      column({ column: "no_skill", caseCount: 1, recallAtK: "N/A", setRecall: "N/A", noSkillPrecision: 1 }),
      column({ column: "multi_skill", recallAtK: 1, setRecall: 1 }),
      column({ column: "cross_language", recallAtK: 1, setRecall: 1 }),
    ],
    nonInferior: true,
    violations: [],
    ...overrides,
  };
}

describe("promotion gate：达标/拒绝", () => {
  it("nonInferior + 各栏达门槛 ⇒ ok", () => {
    const verdict = evaluateProfilePromotion(reportOf());
    assert.deepEqual(verdict, { ok: true });
  });

  it("nonInferior=false ⇒ 拒绝 overlay_not_non_inferior + 明细 violations", () => {
    const verdict = evaluateProfilePromotion(
      reportOf({ nonInferior: false, violations: ["cross_language.recallAtK: learned=0.5 < static=1"] }),
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.reasons[0]!.startsWith("overlay_not_non_inferior"));
      assert.ok(verdict.reasons.some((reason) => reason.includes("cross_language.recallAtK")));
    }
  });

  it("recall 低于冻结门槛 ⇒ 拒绝（reasons 可审计）", () => {
    const verdict = evaluateProfilePromotion(
      reportOf({
        learnedColumns: [
          column({ column: "hard_confuser", recallAtK: 0.5, setRecall: 0.5 }),
          column({ column: "no_skill", caseCount: 1, recallAtK: "N/A", setRecall: "N/A", noSkillPrecision: 1 }),
          column({ column: "multi_skill", recallAtK: 1, setRecall: 1 }),
          column({ column: "cross_language", recallAtK: 1, setRecall: 1 }),
        ],
      }),
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(
        verdict.reasons.some((reason) => reason.startsWith("hard_confuser.recallAtK")),
        JSON.stringify(verdict.reasons),
      );
    }
  });

  it("N/A 栏不虚判：no_skill 栏 recallAtK=N/A 但 noSkillPrecision=1 ⇒ 通过", () => {
    const verdict = evaluateProfilePromotion(
      reportOf({
        learnedColumns: [
          column({ column: "hard_confuser" }),
          column({ column: "no_skill", caseCount: 1, recallAtK: "N/A", setRecall: "N/A", noSkillPrecision: 1 }),
          column({ column: "multi_skill" }),
          column({ column: "cross_language" }),
        ],
      }),
    );
    assert.deepEqual(verdict, { ok: true });
  });

  it("四栏覆盖：缺任一栏 ⇒ 拒绝 column_not_covered（不虚判）", () => {
    const missingNoSkill = reportOf({
      learnedColumns: [
        column({ column: "hard_confuser" }),
        column({ column: "multi_skill" }),
        column({ column: "cross_language" }),
      ],
    });
    const verdict = evaluateProfilePromotion(missingNoSkill);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(
        verdict.reasons.includes("column_not_covered:no_skill"),
        JSON.stringify(verdict.reasons),
      );
    }

    const empty = reportOf({ learnedColumns: [] });
    const emptyVerdict = evaluateProfilePromotion(empty);
    assert.equal(emptyVerdict.ok, false);
    if (!emptyVerdict.ok) {
      for (const column of ["hard_confuser", "no_skill", "multi_skill", "cross_language"]) {
        assert.ok(emptyVerdict.reasons.includes(`column_not_covered:${column}`));
      }
    }
  });

  it("no-skill 误召 ⇒ 拒绝 noSkillPrecision 门槛", () => {
    const verdict = evaluateProfilePromotion(
      reportOf({
        learnedColumns: [
          column({ column: "hard_confuser" }),
          column({ column: "no_skill", caseCount: 1, recallAtK: "N/A", setRecall: "N/A", noSkillPrecision: 0 }),
          column({ column: "multi_skill" }),
          column({ column: "cross_language" }),
        ],
      }),
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.ok(verdict.reasons.some((reason) => reason.includes("noSkillPrecision")));
  });

  it("退化检测：gold 被挤出 Top-K ⇒ 拒绝 goldPreservedInTopK 门槛", () => {
    const verdict = evaluateProfilePromotion(
      reportOf({
        learnedColumns: [
          column({ column: "hard_confuser", goldPreservedInTopK: 0.5 }),
          column({ column: "no_skill", caseCount: 1, recallAtK: "N/A", setRecall: "N/A", noSkillPrecision: 1 }),
          column({ column: "multi_skill", goldPreservedInTopK: 0.5 }),
          column({ column: "cross_language" }),
        ],
      }),
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.reasons.some((reason) => reason.includes("goldPreservedInTopK")));
    }
  });

  it("自定义门槛覆盖：更严 recallAtK 拒绝本应通过的报告", () => {
    const verdict = evaluateProfilePromotion(reportOf(), { recallAtK: 1, goldPreservedInTopK: 1 });
    assert.deepEqual(verdict, { ok: true });
    const stricter = evaluateProfilePromotion(reportOf(), {
      recallAtK: PROMOTION_THRESHOLDS.recallAtK,
      goldPreservedInTopK: 1,
    });
    assert.deepEqual(stricter, { ok: true });
  });

  it("requiredColumns 降级：real-skill 冻结 gate 只要求 hard_confuser + no_skill（缺 multi_skill/cross_language 仍通过）", () => {
    const twoColumn = reportOf({
      learnedColumns: [
        column({ column: "hard_confuser" }),
        column({ column: "no_skill", caseCount: 1, recallAtK: "N/A", setRecall: "N/A", noSkillPrecision: 1 }),
      ],
    });
    // 缺省（四栏）⇒ 拒绝（缺 multi_skill / cross_language）。
    const defaultVerdict = evaluateProfilePromotion(twoColumn);
    assert.equal(defaultVerdict.ok, false);
    if (!defaultVerdict.ok) {
      assert.ok(defaultVerdict.reasons.includes("column_not_covered:multi_skill"));
      assert.ok(defaultVerdict.reasons.includes("column_not_covered:cross_language"));
    }
    // 冻结 gate（FROZEN_REQUIRED_COLUMNS）⇒ 通过（multi_skill/cross_language 非必覆盖）。
    const frozenVerdict = evaluateProfilePromotion(twoColumn, {
      requiredColumns: FROZEN_REQUIRED_COLUMNS,
    });
    assert.deepEqual(frozenVerdict, { ok: true });
  });
});

describe("promotion gate：与 evaluateOverlay 集成（冻结 fixture）", () => {
  it("达标 fixture 的评估报告通过 promotion gate（ok）", () => {
    // 复用 evaluate.test.ts 的 fixture 形状（最小三 record + 四栏 case）。
    const GOLD_ID = "skill:" + "a".repeat(64);
    const CONFUSER_ID = "skill:" + "b".repeat(64);
    const REV = "rev:" + "1".repeat(64);
    const record = (
      id: string,
      name: string,
      description: string,
      aliases: string[] = [],
    ) => ({
      schemaVersion: 1 as const,
      skillId: id,
      skillRevision: REV,
      name,
      description,
      scope: "user" as const,
      sourceLocator: "/fixture",
      sourceHash: "sha256:" + "2".repeat(64),
      disableModelInvocation: false,
      declaredAliases: aliases,
      declaredEffects: [],
      declaredPermissions: [],
      dependencyManifest: [],
      discoveredAt: "2026-08-14T00:00:00.000Z",
    });
    const records = [
      record(GOLD_ID, "offset-pagination-helper", "Detect offset pagination in SQL queries and return structured findings", ["sql-pagination"]),
      record(CONFUSER_ID, "cursor-keyset-helper", "Implement cursor pagination for SQL queries with keyset pagination support"),
      record("skill:" + "c".repeat(64), "pdf-document-reader", "Read and merge PDF documents"),
    ];
    const profile = {
      schemaVersion: 1 as const,
      profileId: "profile:test123",
      parentSkillId: GOLD_ID,
      parentSkillRevision: REV,
      status: "shadow" as const,
      learnedAliases: [{ cueId: "cue:a1", text: "offset-check", evidenceIds: ["obs-1"] }],
      positiveExamples: [{ cueId: "cue:p1", features: ["offset-page-query"], evidenceIds: ["obs-1"] }],
      nearMissExamples: [{ cueId: "cue:n1", features: ["cursor-query"], evidenceIds: ["obs-2"] }],
      environmentCues: [],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const cases = [
      { id: "hc-1", column: "hard_confuser" as const, query: "check offset pagination", expectedSkillIds: [GOLD_ID], confuserSkillIds: [CONFUSER_ID] },
      { id: "ns-1", column: "no_skill" as const, query: "how to cook pasta", expectedSkillIds: [] },
      { id: "ms-1", column: "multi_skill" as const, query: "pagination sql", expectedSkillIds: [GOLD_ID, CONFUSER_ID] },
      { id: "cl-1", column: "cross_language" as const, query: "检查分页 offset 用法", expectedSkillIds: [GOLD_ID] },
    ];
    const report = evaluateOverlay(cases, records, profile, { aliasBoost: 5, positiveBoost: 3, nearMissPenalty: 10 });
    assert.equal(report.nonInferior, true);
    const verdict = evaluateProfilePromotion(report);
    assert.deepEqual(verdict, { ok: true });
  });
});
