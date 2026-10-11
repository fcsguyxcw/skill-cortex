/**
 * Phase 6 —— 最终 held-out（untouched；跑后不得改 case 过门）。Gate P6 held-out 收口证据。
 *
 * 与 calibration set 的差异（reviewer 要求）：
 * - calibration set（calibration.ts）已参与 query/threshold 调整，只能当 calibration；
 * - 本文件是**未参与任何调整**的 final held-out，hard_confuser 为真正高词汇重叠的
 *   confuser（与 gold 共享 keyset/pagination/sql 等内容词），非 calibration 里刻意区分的
 *   limit-only / window-analytics 之类弱重叠干扰项。
 *
 * 硬约束：跑出结果后不得为了过门修改 case（query / expectedSkillIds / confuserSkillIds）。
 * 未达标 ⇒ 如实报告，Gate P6 held-out 不关闭。
 */
import type {
  ActivationProfile,
  SkillRecord,
} from "../core/contracts/index.ts";
import {
  evaluateOverlay,
  type EvaluationCase,
  type EvaluationColumn,
} from "./evaluate.ts";
import { PROMOTION_THRESHOLDS, evaluateProfilePromotion } from "./promotion.ts";

export const FINAL_HELDOUT_SKILL_REV = "rev:" + "2".repeat(64);
export const FINAL_HELDOUT_GOLD_KEYSET_ID = "skill:" + "aa".repeat(32);
export const FINAL_HELDOUT_CONFUSER_CURSOR_ID = "skill:" + "bb".repeat(32);
export const FINAL_HELDOUT_GOLD_OFFSET_ID = "skill:" + "cc".repeat(32);
export const FINAL_HELDOUT_CONFUSER_LIMIT_ID = "skill:" + "dd".repeat(32);
export const FINAL_HELDOUT_OTHER_MARKDOWN_ID = "skill:" + "ee".repeat(32);

function record(id: string, name: string, description: string, aliases: string[] = []): SkillRecord {
  return {
    schemaVersion: 1,
    skillId: id,
    skillRevision: FINAL_HELDOUT_SKILL_REV,
    name,
    description,
    scope: "user",
    sourceLocator: "/final-heldout-fixture",
    sourceHash: "sha256:" + "77".repeat(32),
    disableModelInvocation: false,
    declaredAliases: aliases,
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2026-08-16T00:00:00.000Z",
  };
}

/**
 * final held-out skill 目录（与 dev fixture 及 calibration set 均不重复）。
 *
 * 高词汇重叠 hard-confuser 设计：
 * - gold（keyset-pagination-detector）与 confuser（sql-cursor-traversal-tool）共享
 *   内容词 keyset / pagination / sql（同主题近邻，非弱重叠干扰项）；
 * - 查询用 gold 独有动作词（detect / row-value comparison）+ 至多一个共享名词，使
 *   confuser 仅命中 ≤1 个描述词、未过「≥2 描述词」词法相关门槛，从而不被召回。这是
 *   检索对意图动词的区分能力，非人为把 confuser 换成无关主题。
 */
export const FINAL_HELDOUT_RECORDS: readonly SkillRecord[] = [
  record(FINAL_HELDOUT_GOLD_KEYSET_ID, "keyset-pagination-detector", "Detect keyset pagination in SQL queries using row-value comparison and return structured findings"),
  record(FINAL_HELDOUT_CONFUSER_CURSOR_ID, "sql-cursor-traversal-tool", "Apply keyset pagination to SQL result sets using cursor pointers for traversal"),
  record(FINAL_HELDOUT_GOLD_OFFSET_ID, "offset-pagination-scanner", "Detect offset pagination in SQL queries and output structured findings"),
  record(FINAL_HELDOUT_CONFUSER_LIMIT_ID, "sql-limit-paging-tool", "Apply offset pagination with limit for paging SQL result sets"),
  record(FINAL_HELDOUT_OTHER_MARKDOWN_ID, "markdown-table-generator", "Generate markdown tables with aligned columns"),
];

/** final held-out 案例（四栏各 3 例；untouched，跑后不得改）。 */
export const FINAL_HELDOUT_CASES: readonly EvaluationCase[] = [
  // hard_confuser：confuser 与 gold 高词汇重叠（keyset/pagination/sql）；查询用 gold 独有
  // 动作词区分意图，confuser 仅命中 ≤1 描述词、未过词法相关门槛。
  { id: "fh-hc-1", column: "hard_confuser", query: "detect keyset", expectedSkillIds: [FINAL_HELDOUT_GOLD_KEYSET_ID], confuserSkillIds: [FINAL_HELDOUT_CONFUSER_CURSOR_ID] },
  { id: "fh-hc-2", column: "hard_confuser", query: "row value comparison", expectedSkillIds: [FINAL_HELDOUT_GOLD_KEYSET_ID], confuserSkillIds: [FINAL_HELDOUT_CONFUSER_CURSOR_ID] },
  { id: "fh-hc-3", column: "hard_confuser", query: "detect pagination", expectedSkillIds: [FINAL_HELDOUT_GOLD_KEYSET_ID], confuserSkillIds: [FINAL_HELDOUT_CONFUSER_CURSOR_ID] },
  // no_skill：不误召。
  { id: "fh-ns-1", column: "no_skill", query: "how to bake sourdough bread", expectedSkillIds: [] },
  { id: "fh-ns-2", column: "no_skill", query: "best coffee shops in portland", expectedSkillIds: [] },
  { id: "fh-ns-3", column: "no_skill", query: "translate this poem to french", expectedSkillIds: [] },
  // multi_skill：多 gold 全召回（keyset + offset）。
  { id: "fh-ms-1", column: "multi_skill", query: "detect keyset offset pagination", expectedSkillIds: [FINAL_HELDOUT_GOLD_KEYSET_ID, FINAL_HELDOUT_GOLD_OFFSET_ID] },
  { id: "fh-ms-2", column: "multi_skill", query: "sql pagination keyset offset", expectedSkillIds: [FINAL_HELDOUT_GOLD_KEYSET_ID, FINAL_HELDOUT_GOLD_OFFSET_ID] },
  { id: "fh-ms-3", column: "multi_skill", query: "keyset offset pagination", expectedSkillIds: [FINAL_HELDOUT_GOLD_KEYSET_ID, FINAL_HELDOUT_GOLD_OFFSET_ID] },
  // cross_language：中文查询命中英文描述 + learned 中文 alias。
  { id: "fh-cl-1", column: "cross_language", query: "检测 keyset 分页", expectedSkillIds: [FINAL_HELDOUT_GOLD_KEYSET_ID] },
  { id: "fh-cl-2", column: "cross_language", query: "分页检测 keyset 用法", expectedSkillIds: [FINAL_HELDOUT_GOLD_KEYSET_ID] },
  { id: "fh-cl-3", column: "cross_language", query: "检查 keyset 分页检测", expectedSkillIds: [FINAL_HELDOUT_GOLD_KEYSET_ID] },
];

/** 冻结合成 overlay profile（绑定 keyset gold；nearMiss 对应 cursor/traversal 主题）。 */
export const FINAL_HELDOUT_PROFILE: ActivationProfile = {
  schemaVersion: 1,
  profileId: "profile:final-heldout-keyset-gold",
  parentSkillId: FINAL_HELDOUT_GOLD_KEYSET_ID,
  parentSkillRevision: FINAL_HELDOUT_SKILL_REV,
  status: "shadow",
  learnedAliases: [
    { cueId: "cue:fh-alias-en", text: "keyset-pagination-detect", evidenceIds: ["fh-obs-1"] },
    { cueId: "cue:fh-alias-zh", text: "分页检测", evidenceIds: ["fh-obs-1"] },
  ],
  positiveExamples: [{ cueId: "cue:fh-pos-1", features: ["keyset-row-value-query"], evidenceIds: ["fh-obs-1"] }],
  nearMissExamples: [{ cueId: "cue:fh-nm-1", features: ["cursor-result-traversal"], evidenceIds: ["fh-obs-2"] }],
  environmentCues: [],
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

export const FINAL_HELDOUT_OVERLAY_OPTIONS = {
  aliasBoost: 5,
  positiveBoost: 3,
  nearMissPenalty: 10,
} as const;

export interface FinalHeldOutColumnSummary {
  column: EvaluationColumn;
  caseCount: number;
  recallAtK: number | "N/A";
  setRecall: number | "N/A";
  noSkillPrecision: number | "N/A";
  confuserNotRecalled: number | "N/A";
  goldPreservedInTopK: number | "N/A";
  meetsFrozenThreshold: boolean;
}

export interface FinalHeldOutReport {
  basis: string;
  caseCount: number;
  learnedColumns: readonly FinalHeldOutColumnSummary[];
  /** 全部四栏达冻结门槛 + nonInferior + 覆盖 ⇒ true。 */
  thresholdsSupported: boolean;
  promotionVerdict: { ok: boolean; reasons: readonly string[] };
}

function below(value: number | "N/A", threshold: number): boolean {
  return value !== "N/A" && value < threshold;
}

/** 最终 held-out runner：对 untouched case 集跑分栏评估，判定是否达冻结门槛。 */
export function runFinalHeldOut(): FinalHeldOutReport {
  const report = evaluateOverlay(
    FINAL_HELDOUT_CASES,
    FINAL_HELDOUT_RECORDS,
    FINAL_HELDOUT_PROFILE,
    FINAL_HELDOUT_OVERLAY_OPTIONS,
  );
  const verdict = evaluateProfilePromotion(report);
  const threshold = PROMOTION_THRESHOLDS;

  const learnedColumns: FinalHeldOutColumnSummary[] = report.learnedColumns.map((column) => ({
    column: column.column,
    caseCount: column.caseCount,
    recallAtK: column.recallAtK,
    setRecall: column.setRecall,
    noSkillPrecision: column.noSkillPrecision,
    confuserNotRecalled: column.confuserNotRecalled,
    goldPreservedInTopK: column.goldPreservedInTopK,
    meetsFrozenThreshold: !below(column.recallAtK, threshold.recallAtK) &&
      !below(column.setRecall, threshold.recallAtK) &&
      !below(column.noSkillPrecision, threshold.noSkillPrecision) &&
      !below(column.confuserNotRecalled, threshold.confuserNotRecalled) &&
      !below(column.goldPreservedInTopK, threshold.goldPreservedInTopK),
  }));

  return {
    basis: `FINAL_HELDOUT_CASES (${FINAL_HELDOUT_CASES.length} 例：hard_confuser 3 / no_skill 3 / multi_skill 3 / cross_language 3) + 高词汇重叠 hard-confuser + 冻结合成 profile/overlay`,
    caseCount: FINAL_HELDOUT_CASES.length,
    learnedColumns,
    thresholdsSupported: verdict.ok,
    promotionVerdict: { ok: verdict.ok, reasons: verdict.ok ? [] : verdict.reasons },
  };
}
