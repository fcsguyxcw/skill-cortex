/**
 * Phase 3 OFFSET pagination 检测 pilot：冻结案例（oracle）。
 *
 * 来源：docs/evaluation/2026-08-14-phase3-pagination-thresholds.md §4（Evaluation Owner
 * 在查看任何候选 procedure 结果之前冻结；标签不可变）。本模块是 verifier 的独立判定基准，
 * 只含输入 sql + 冻结 expected，不预填任何候选 finding，也不导入候选 procedure。
 * 测试 SQL 全部为项目原创（posts 表分页形态），未复制外部正文。
 */

export type PaginationClass = "uses_offset" | "uses_keyset" | "no_pagination" | "abstain";
export type CasePartition = "train" | "heldout";

export interface PaginationCase {
  id: string;
  partition: CasePartition;
  sql: string;
  expected: PaginationClass;
}

/** 冻结案例清单（19 例：train 4 + heldout 15）。逐字对应阈值文档 §4。 */
export const PAGINATION_CASES: readonly PaginationCase[] = [
  // train（规范形态；调参/编写 procedure 可用）
  { id: "T01", partition: "train", sql: "SELECT * FROM posts ORDER BY id LIMIT 20 OFFSET 40;", expected: "uses_offset" },
  { id: "T02", partition: "train", sql: "SELECT * FROM posts WHERE id > $1 ORDER BY id LIMIT 20;", expected: "uses_keyset" },
  { id: "T03", partition: "train", sql: "SELECT * FROM posts WHERE author_id = $1;", expected: "no_pagination" },
  { id: "T04", partition: "train", sql: "SELECT id, title FROM posts ORDER BY created_at DESC LIMIT 10;", expected: "no_pagination" },
  // heldout（验收；边角全部集中于此；标签不可变）
  { id: "H01", partition: "heldout", sql: "SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;", expected: "uses_offset" },
  { id: "H02", partition: "heldout", sql: "SELECT * FROM posts ORDER BY id LIMIT $1 OFFSET $2;", expected: "uses_offset" },
  { id: "H03", partition: "heldout", sql: "SELECT * FROM posts ORDER BY id OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY;", expected: "uses_offset" },
  { id: "H04", partition: "heldout", sql: "SELECT * FROM (SELECT * FROM posts ORDER BY id LIMIT 20 OFFSET 40) AS page;", expected: "uses_offset" },
  { id: "H05", partition: "heldout", sql: "WITH page AS (SELECT * FROM posts ORDER BY id LIMIT 20 OFFSET 40) SELECT * FROM page;", expected: "uses_offset" },
  { id: "H06", partition: "heldout", sql: "SELECT 'OFFSET 20' AS hint;", expected: "no_pagination" },
  { id: "H07", partition: "heldout", sql: "SELECT * FROM posts; -- legacy OFFSET 20 removed", expected: "no_pagination" },
  { id: "H08", partition: "heldout", sql: 'SELECT "offset", id FROM posts;', expected: "no_pagination" },
  { id: "H09", partition: "heldout", sql: "SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM posts;", expected: "no_pagination" },
  { id: "H10", partition: "heldout", sql: "SELECT * FROM posts WHERE (created_at, id) > ($1, $2) ORDER BY created_at, id LIMIT 20;", expected: "uses_keyset" },
  { id: "H11", partition: "heldout", sql: "SELECT * FROM posts WHERE created_at < $1 ORDER BY created_at DESC LIMIT 20;", expected: "uses_keyset" },
  { id: "H12", partition: "heldout", sql: "SELECT * FROM posts ORDER BY id LIMIT 20 OFFSET;", expected: "abstain" },
  { id: "H13", partition: "heldout", sql: "SELECT * FROM posts OFFSET;", expected: "abstain" },
  { id: "H14", partition: "heldout", sql: "", expected: "abstain" },
  { id: "H15", partition: "heldout", sql: "SELECT count(*) FROM posts;", expected: "no_pagination" },
];

export const TRAIN_CASES: readonly PaginationCase[] = PAGINATION_CASES.filter(
  (c) => c.partition === "train",
);
export const HELDOUT_CASES: readonly PaginationCase[] = PAGINATION_CASES.filter(
  (c) => c.partition === "heldout",
);

/** 冻结统计（阈值文档 §4 底部；供自检与测试断言，不作为指标输入）。 */
export const FROZEN_STATS = {
  total: 19,
  train: 4,
  heldout: 15,
  heldoutByExpected: {
    uses_offset: 5, // H01–H05
    no_pagination: 5, // H06–H09, H15
    uses_keyset: 2, // H10–H11
    abstain: 3, // H12–H14
  },
  heldoutOffset: 5, // |H_offset|
  heldoutNonOffset: 10, // |H_nonoffset|
  heldoutAbstain: 3, // |H_abstain|
  heldoutNonAbstain: 12, // |H_nonabstain|
} as const;
