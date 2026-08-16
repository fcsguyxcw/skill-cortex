/**
 * Phase 6 后续 —— held-out 门槛校准测试（Gate P6 冻结门槛定值）。
 *
 * 覆盖：
 * - HELDOUT_CASES 规模：四栏各 ≥3 例（共 12 例）；
 * - 与 dev fixture（evaluate.test.ts / rerank.test.ts）不重复：skill 目录与 query 均不重叠
 *   （防过拟合——held-out 用于验证冻结门槛，不得参与拟合）；
 * - 校准 runner：runHeldOutCalibration 输出分栏统计，各栏达冻结门槛（thresholdsSupported=true）；
 * - 冻结门槛值 = held-out 结果下界减 0.1 容差（recallAtK/confuserNotRecalled/
 *   goldPreservedInTopK → 0.9；noSkillPrecision 安全硬边界保持 1）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROMOTION_THRESHOLDS } from "./promotion.ts";
import {
  HELDOUT_CASES,
  HELDOUT_RECORDS,
  runHeldOutCalibration,
} from "./index.ts";

describe("held-out fixture：规模与 dev 不重复", () => {
  it("四栏各 ≥3 例（共 12 例）", () => {
    assert.equal(HELDOUT_CASES.length, 12);
    for (const column of ["hard_confuser", "no_skill", "multi_skill", "cross_language"] as const) {
      const count = HELDOUT_CASES.filter((c) => c.column === column).length;
      assert.ok(count >= 3, `${column} 必须 ≥3 例（实际 ${count}）`);
    }
  });

  it("skill 目录与 dev fixture 不重复（不同 skillId/name/描述）", () => {
    // dev fixture 的 skill（evaluate.test.ts / rerank.test.ts）：offset-pagination-helper /
    // cursor-keyset-helper / pdf-document-reader。
    const devNames = ["offset-pagination-helper", "cursor-keyset-helper", "pdf-document-reader"];
    for (const record of HELDOUT_RECORDS) {
      assert.ok(!devNames.includes(record.name), `held-out 不得复用 dev skill：${record.name}`);
    }
  });

  it("query 与 dev fixture 不重复（不同查询分布）", () => {
    // dev fixture 的 query（evaluate.test.ts CASES + rerank.test.ts）。
    const devQueries = [
      "check offset pagination",
      "how to cook pasta",
      "pagination sql",
      "检查分页 offset 用法",
      "check pagination sql",
      "offset-check syntax",
      "cursor pagination query",
      "offset page query",
      "check offset pagination sql",
      "pdf document reading",
    ];
    for (const case_ of HELDOUT_CASES) {
      assert.ok(!devQueries.includes(case_.query), `held-out 不得复用 dev query：${case_.query}`);
    }
  });
});

describe("held-out 校准：分栏统计与冻结门槛", () => {
  it("校准 runner：12 例四栏全达标（thresholdsSupported=true，verdict ok）", () => {
    const report = runHeldOutCalibration();
    assert.equal(report.caseCount, 12);
    assert.equal(report.thresholdsSupported, true, JSON.stringify(report.promotionVerdict));
    assert.deepEqual(report.promotionVerdict, { ok: true, reasons: [] });

    const byColumn = new Map(report.learnedColumns.map((c) => [c.column, c]));
    for (const column of ["hard_confuser", "multi_skill", "cross_language"] as const) {
      const c = byColumn.get(column)!;
      assert.equal(c.recallAtK, 1, `${column} recall`);
      assert.equal(c.setRecall, 1, `${column} setRecall`);
      assert.equal(c.goldPreservedInTopK, 1, `${column} 退化检测`);
      assert.equal(c.meetsFrozenThreshold, true);
    }
    const noSkill = byColumn.get("no_skill")!;
    assert.equal(noSkill.noSkillPrecision, 1, "no-skill 不误召");
    assert.equal(noSkill.meetsFrozenThreshold, true);
  });

  it("冻结门槛 = held-out 结果下界减 0.1 容差（recall/confuser/preserved=0.9；noSkill 硬边界=1）", () => {
    assert.equal(PROMOTION_THRESHOLDS.recallAtK, 0.9);
    assert.equal(PROMOTION_THRESHOLDS.confuserNotRecalled, 0.9);
    assert.equal(PROMOTION_THRESHOLDS.goldPreservedInTopK, 0.9);
    assert.equal(PROMOTION_THRESHOLDS.noSkillPrecision, 1, "no-skill 安全硬边界不放松");
  });

  it("校准依据可追溯：basis 注明案例数与冻结 profile/overlay", () => {
    const report = runHeldOutCalibration();
    assert.match(report.basis, /HELDOUT_CASES \(12 例/);
    assert.match(report.basis, /hard_confuser 3 \/ no_skill 3 \/ multi_skill 3 \/ cross_language 3/);
  });
});
