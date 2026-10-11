/**
 * Phase 6 —— 最终 held-out 测试（untouched；跑后不得改 case 过门）。Gate P6 held-out 收口。
 *
 * 覆盖：
 * - FINAL_HELDOUT_CASES 规模：四栏各 ≥3 例（共 12 例）；
 * - 与 dev fixture 及 calibration set 均不重复（skill 目录 / query 均不重叠）；
 * - hard_confuser 真正高词汇重叠：confuser 与 gold 共享 ≥2 个内容词（非弱重叠干扰项）；
 * - runFinalHeldOut 达冻结门槛（thresholdsSupported=true，四栏全 meetsFrozenThreshold，
 *   verdict ok）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tokenize } from "../discovery/tokenize.ts";
import { CALIBRATION_CASES, CALIBRATION_RECORDS } from "./index.ts";
import {
  FINAL_HELDOUT_CASES,
  FINAL_HELDOUT_RECORDS,
  runFinalHeldOut,
} from "./index.ts";

describe("final held-out：规模与 dev / calibration 不重复", () => {
  it("四栏各 ≥3 例（共 12 例）", () => {
    assert.equal(FINAL_HELDOUT_CASES.length, 12);
    for (const column of ["hard_confuser", "no_skill", "multi_skill", "cross_language"] as const) {
      const count = FINAL_HELDOUT_CASES.filter((c) => c.column === column).length;
      assert.ok(count >= 3, `${column} 必须 ≥3 例（实际 ${count}）`);
    }
  });

  it("skill 目录与 dev fixture 及 calibration set 均不重复", () => {
    const devNames = ["offset-pagination-helper", "cursor-keyset-helper", "pdf-document-reader"];
    const calibrationNames = CALIBRATION_RECORDS.map((r) => r.name);
    for (const record of FINAL_HELDOUT_RECORDS) {
      assert.ok(!devNames.includes(record.name), `final-heldout 不得复用 dev skill：${record.name}`);
      assert.ok(!calibrationNames.includes(record.name), `final-heldout 不得复用 calibration skill：${record.name}`);
    }
  });

  it("query 与 dev fixture 及 calibration set 均不重复", () => {
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
    const calibrationQueries = CALIBRATION_CASES.map((c) => c.query);
    for (const case_ of FINAL_HELDOUT_CASES) {
      assert.ok(!devQueries.includes(case_.query), `final-heldout 不得复用 dev query：${case_.query}`);
      assert.ok(!calibrationQueries.includes(case_.query), `final-heldout 不得复用 calibration query：${case_.query}`);
    }
  });
});

describe("final held-out：高词汇重叠 hard-confuser", () => {
  it("confuser 与 gold 共享 ≥2 个内容词（真正高词汇重叠）", () => {
    const gold = FINAL_HELDOUT_RECORDS.find((r) => r.name === "keyset-pagination-detector")!;
    const confuser = FINAL_HELDOUT_RECORDS.find((r) => r.name === "sql-cursor-traversal-tool")!;
    const goldTokens = new Set(tokenize(`${gold.name} ${gold.description}`));
    const confuserTokens = tokenize(`${confuser.name} ${confuser.description}`);
    const shared = [...new Set(confuserTokens)].filter((term) => goldTokens.has(term));
    assert.ok(shared.length >= 2, `confuser 必须与 gold 高词汇重叠（实际共享 [${shared.join(", ")}]）`);
  });
});

describe("final held-out：达冻结门槛（untouched）", () => {
  it("runFinalHeldOut 四栏全达标 + verdict ok（thresholdsSupported=true）", () => {
    const report = runFinalHeldOut();
    assert.equal(report.caseCount, 12);
    assert.equal(report.thresholdsSupported, true, JSON.stringify(report.promotionVerdict));
    assert.deepEqual(report.promotionVerdict, { ok: true, reasons: [] });

    const byColumn = new Map(report.learnedColumns.map((c) => [c.column, c]));
    for (const column of ["hard_confuser", "no_skill", "multi_skill", "cross_language"] as const) {
      const c = byColumn.get(column)!;
      assert.equal(c.caseCount, 3, `${column} 覆盖 3 例`);
      assert.equal(c.meetsFrozenThreshold, true, `${column} 必须达冻结门槛`);
    }
    const hardConfuser = byColumn.get("hard_confuser")!;
    assert.equal(hardConfuser.recallAtK, 1, "hard-confuser gold 不误杀");
    assert.equal(hardConfuser.confuserNotRecalled, 1, "hard-confuser confuser 不误召");
    assert.equal(hardConfuser.goldPreservedInTopK, 1, "hard-confuser 无退化挤出");
    const noSkill = byColumn.get("no_skill")!;
    assert.equal(noSkill.noSkillPrecision, 1, "no-skill 不误召");
  });
});
