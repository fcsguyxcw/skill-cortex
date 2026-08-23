import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FROZEN_STATS,
  HELDOUT_CASES,
  PAGINATION_CASES,
  TRAIN_CASES,
} from "./cases.ts";
import type { PaginationClass } from "./cases.ts";

const CLASSES: readonly PaginationClass[] = [
  "uses_offset",
  "uses_keyset",
  "no_pagination",
  "abstain",
];

describe("Phase 3 冻结案例（oracle）", () => {
  it("共 19 例：train 4 + heldout 15，分区不相交，id 唯一", () => {
    assert.equal(PAGINATION_CASES.length, FROZEN_STATS.total);
    assert.equal(TRAIN_CASES.length, FROZEN_STATS.train);
    assert.equal(HELDOUT_CASES.length, FROZEN_STATS.heldout);
    const trainIds = new Set(TRAIN_CASES.map((c) => c.id));
    const heldoutIds = new Set(HELDOUT_CASES.map((c) => c.id));
    for (const id of trainIds) {
      assert.ok(!heldoutIds.has(id), `train/heldout 分区必须不相交: ${id}`);
    }
    assert.equal(trainIds.size + heldoutIds.size, PAGINATION_CASES.length, "id 必须唯一");
  });

  it("每例 expected 均为冻结四类之一", () => {
    for (const c of PAGINATION_CASES) {
      assert.ok(CLASSES.includes(c.expected), `${c.id} expected=${c.expected} 非法`);
    }
  });

  it("held-out 冻结统计与文档一致（5 offset / 5 no_pagination / 2 keyset / 3 abstain）", () => {
    const byClass = new Map<PaginationClass, number>();
    for (const c of HELDOUT_CASES) {
      byClass.set(c.expected, (byClass.get(c.expected) ?? 0) + 1);
    }
    assert.equal(byClass.get("uses_offset"), FROZEN_STATS.heldoutByExpected.uses_offset);
    assert.equal(byClass.get("no_pagination"), FROZEN_STATS.heldoutByExpected.no_pagination);
    assert.equal(byClass.get("uses_keyset"), FROZEN_STATS.heldoutByExpected.uses_keyset);
    assert.equal(byClass.get("abstain"), FROZEN_STATS.heldoutByExpected.abstain);
    assert.equal(HELDOUT_CASES.filter((c) => c.expected === "uses_offset").length, FROZEN_STATS.heldoutOffset);
    assert.equal(HELDOUT_CASES.filter((c) => c.expected !== "uses_offset").length, FROZEN_STATS.heldoutNonOffset);
    assert.equal(HELDOUT_CASES.filter((c) => c.expected === "abstain").length, FROZEN_STATS.heldoutAbstain);
    assert.equal(HELDOUT_CASES.filter((c) => c.expected !== "abstain").length, FROZEN_STATS.heldoutNonAbstain);
  });

  it("关键 oracle 抽查（原样冻结，防意外改动）", () => {
    const byId = new Map(PAGINATION_CASES.map((c) => [c.id, c]));
    assert.equal(byId.get("H03")!.sql, "SELECT * FROM posts ORDER BY id OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY;"); // SQL 标准 FETCH
    assert.equal(byId.get("H04")!.sql, "SELECT * FROM (SELECT * FROM posts ORDER BY id LIMIT 20 OFFSET 40) AS page;"); // 子查询
    assert.equal(byId.get("H05")!.sql, "WITH page AS (SELECT * FROM posts ORDER BY id LIMIT 20 OFFSET 40) SELECT * FROM page;"); // CTE
    assert.equal(byId.get("H06")!.expected, "no_pagination"); // 字符串字面量 OFFSET
    assert.equal(byId.get("H07")!.expected, "no_pagination"); // 注释 OFFSET
    assert.equal(byId.get("H08")!.expected, "no_pagination"); // 列名 offset
    assert.equal(byId.get("H09")!.expected, "no_pagination"); // 窗口函数
    assert.equal(byId.get("H12")!.expected, "abstain"); // 残缺 LIMIT…OFFSET
    assert.equal(byId.get("H13")!.expected, "abstain");
    assert.equal(byId.get("H14")!.sql, ""); // 空串
    assert.equal(byId.get("H15")!.expected, "no_pagination"); // count(*)
    // T 系列规范形态
    assert.equal(byId.get("T01")!.expected, "uses_offset");
    assert.equal(byId.get("T02")!.expected, "uses_keyset");
    assert.equal(byId.get("T03")!.expected, "no_pagination");
    assert.equal(byId.get("T04")!.expected, "no_pagination");
  });
});
