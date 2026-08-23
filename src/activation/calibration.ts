/**
 * Phase 6 —— promotion 门槛 calibration set（冻结合成 fixture，不写真实事件）。
 *
 * 这 12 例已参与 query / threshold 调整（用于把 PROMOTION_THRESHOLDS 定值到 recall=0.9、
 * confuser=0.9、noSkill=1、goldPreserved=1），因此是 **calibration set**，不能作为最终
 * held-out 证据。最终 held-out 见 final-heldout.ts（untouched，跑后不得改 case）。
 *
 * 与 dev fixture（evaluate.test.ts / rerank.test.ts）不重复：不同 skill 集合与不同 query
 * 分布；四栏各 3 例（hard_confuser / no_skill / multi_skill / cross_language）。
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

export const CALIBRATION_SKILL_REV = "rev:" + "1".repeat(64);
export const CALIBRATION_GOLD_KEYSET_ID = "skill:" + "11".repeat(32);
export const CALIBRATION_GOLD_FETCH_ID = "skill:" + "22".repeat(32);
export const CALIBRATION_CONFUSER_LIMIT_ID = "skill:" + "33".repeat(32);
export const CALIBRATION_CONFUSER_WINDOW_ID = "skill:" + "44".repeat(32);
export const CALIBRATION_OTHER_MARKDOWN_ID = "skill:" + "55".repeat(32);

function record(id: string, name: string, description: string, aliases: string[] = []): SkillRecord {
  return {
    schemaVersion: 1,
    skillId: id,
    skillRevision: CALIBRATION_SKILL_REV,
    name,
    description,
    scope: "user",
    sourceLocator: "/calibration-fixture",
    sourceHash: "sha256:" + "66".repeat(32),
    disableModelInvocation: false,
    declaredAliases: aliases,
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2026-08-14T00:00:00.000Z",
  };
}

/** calibration skill 目录（与 dev fixture 的 skill 完全不重复）。 */
export const CALIBRATION_RECORDS: readonly SkillRecord[] = [
  record(CALIBRATION_GOLD_KEYSET_ID, "keyset-query-detector", "Detect keyset pagination in SQL queries using row-value comparison and return structured findings"),
  record(CALIBRATION_GOLD_FETCH_ID, "fetch-first-pagination-helper", "Detect SQL fetch first pagination syntax and output structured findings"),
  record(CALIBRATION_CONFUSER_LIMIT_ID, "limit-only-query-tool", "Filter SQL results with LIMIT clause only, no pagination support"),
  record(CALIBRATION_CONFUSER_WINDOW_ID, "window-function-analytics", "Use window functions for row numbering and analytics queries"),
  record(CALIBRATION_OTHER_MARKDOWN_ID, "markdown-table-formatter", "Format markdown tables and align columns"),
];

/** calibration 案例（四栏各 3 例；query/skill/分布与 dev 不重复）。 */
export const CALIBRATION_CASES: readonly EvaluationCase[] = [
  // hard_confuser：gold 不误杀 + confuser 不误召（查询聚焦 gold 独有特征，避免泛词命中 confuser 描述）。
  { id: "hc-k1", column: "hard_confuser", query: "check keyset pagination", expectedSkillIds: [CALIBRATION_GOLD_KEYSET_ID], confuserSkillIds: [CALIBRATION_CONFUSER_LIMIT_ID] },
  { id: "hc-f1", column: "hard_confuser", query: "fetch first rows pagination syntax", expectedSkillIds: [CALIBRATION_GOLD_FETCH_ID], confuserSkillIds: [CALIBRATION_CONFUSER_LIMIT_ID] },
  { id: "hc-k2", column: "hard_confuser", query: "detect row-value comparison pagination", expectedSkillIds: [CALIBRATION_GOLD_KEYSET_ID], confuserSkillIds: [CALIBRATION_CONFUSER_WINDOW_ID] },
  // no_skill：不误召。
  { id: "ns-p1", column: "no_skill", query: "how to cook pasta with tomatoes", expectedSkillIds: [] },
  { id: "ns-t1", column: "no_skill", query: "best hiking trails near seattle", expectedSkillIds: [] },
  { id: "ns-l1", column: "no_skill", query: "translate this song lyric to french", expectedSkillIds: [] },
  // multi_skill：多 gold 全召回。
  { id: "ms-1", column: "multi_skill", query: "pagination sql keyset fetch first", expectedSkillIds: [CALIBRATION_GOLD_KEYSET_ID, CALIBRATION_GOLD_FETCH_ID] },
  { id: "ms-2", column: "multi_skill", query: "sql pagination detection", expectedSkillIds: [CALIBRATION_GOLD_KEYSET_ID, CALIBRATION_GOLD_FETCH_ID] },
  { id: "ms-3", column: "multi_skill", query: "keyset row comparison pagination", expectedSkillIds: [CALIBRATION_GOLD_KEYSET_ID] },
  // cross_language：中文查询命中英文描述 + learned 中文 alias。
  { id: "cl-1", column: "cross_language", query: "检测 keyset 分页 sql", expectedSkillIds: [CALIBRATION_GOLD_KEYSET_ID] },
  { id: "cl-2", column: "cross_language", query: "检查 fetch first 分页语法", expectedSkillIds: [CALIBRATION_GOLD_FETCH_ID] },
  { id: "cl-3", column: "cross_language", query: "分页查询检测 keyset 用法", expectedSkillIds: [CALIBRATION_GOLD_KEYSET_ID] },
];

/** 冻结合成 overlay profile（绑定 keyset gold；learned alias 中英文命中；nearMiss 与 gold 查询不重叠）。 */
export const CALIBRATION_PROFILE: ActivationProfile = {
  schemaVersion: 1,
  profileId: "profile:calibration-keyset-gold",
  parentSkillId: CALIBRATION_GOLD_KEYSET_ID,
  parentSkillRevision: CALIBRATION_SKILL_REV,
  status: "shadow",
  learnedAliases: [
    { cueId: "cue:cal-alias-en", text: "keyset-pagination-check", evidenceIds: ["cal-obs-1"] },
    { cueId: "cue:cal-alias-zh", text: "分页检测", evidenceIds: ["cal-obs-1"] },
  ],
  positiveExamples: [{ cueId: "cue:cal-pos-1", features: ["keyset-row-value-query"], evidenceIds: ["cal-obs-1"] }],
  nearMissExamples: [{ cueId: "cue:cal-nm-1", features: ["limit-only-single-table"], evidenceIds: ["cal-obs-2"] }],
  environmentCues: [],
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

/** overlay 参数（与 dev 校准一致，避免引入额外自由度）。 */
export const CALIBRATION_OVERLAY_OPTIONS = {
  aliasBoost: 5,
  positiveBoost: 3,
  nearMissPenalty: 10,
} as const;

export interface CalibrationColumnSummary {
  column: EvaluationColumn;
  caseCount: number;
  recallAtK: number | "N/A";
  setRecall: number | "N/A";
  noSkillPrecision: number | "N/A";
  confuserNotRecalled: number | "N/A";
  goldPreservedInTopK: number | "N/A";
  /** 该栏是否达到冻结门槛（PROMOTION_THRESHOLDS）。 */
  meetsFrozenThreshold: boolean;
}

export interface CalibrationReport {
  /** 校准依据说明（案例数 + 冻结 profile/overlay）。 */
  basis: string;
  caseCount: number;
  learnedColumns: readonly CalibrationColumnSummary[];
  /** 全部栏达门槛 ⇒ 门槛保持；否则建议值（按每栏指标下界减容差）。 */
  thresholdsSupported: boolean;
  /** 不达标时给出建议门槛（达标时与冻结门槛相同）。 */
  suggestedThresholds: {
    recallAtK: number;
    noSkillPrecision: number;
    confuserNotRecalled: number;
    goldPreservedInTopK: number;
  };
  /** promotion gate 判定细节（达标原因 / 未达标 reasons）。 */
  promotionVerdict: { ok: boolean; reasons: readonly string[] };
}

function below(value: number | "N/A", threshold: number): boolean {
  return value !== "N/A" && value < threshold;
}

/**
 * 校准 runner：calibration set 上跑 static + learned overlay 分栏评估，判定冻结门槛支持性。
 * 门槛不支持时按每栏指标（有数据栏）下界减容差给出建议值。
 */
export function runCalibration(): CalibrationReport {
  const report = evaluateOverlay(CALIBRATION_CASES, CALIBRATION_RECORDS, CALIBRATION_PROFILE, CALIBRATION_OVERLAY_OPTIONS);
  const verdict = evaluateProfilePromotion(report);
  const threshold = PROMOTION_THRESHOLDS;

  const learnedColumns: CalibrationColumnSummary[] = report.learnedColumns.map((column) => ({
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

  // 建议值：有数据栏的指标下界（均值减 0.1 容差、且不低于 0——不为过门调低到无意义）。
  const evaluated = learnedColumns.filter((column) => column.caseCount > 0);
  const minOf = (pick: (c: (typeof learnedColumns)[number]) => number | "N/A", fallback: number): number => {
    const values = evaluated
      .map((column) => pick(column))
      .filter((value): value is number => value !== "N/A");
    if (values.length === 0) return fallback;
    return Math.max(0, Math.min(...values) - 0.1);
  };
  const suggestedThresholds = {
    recallAtK: minOf((c) => c.recallAtK, threshold.recallAtK),
    noSkillPrecision: minOf((c) => c.noSkillPrecision, threshold.noSkillPrecision),
    confuserNotRecalled: minOf((c) => c.confuserNotRecalled, threshold.confuserNotRecalled),
    goldPreservedInTopK: minOf((c) => c.goldPreservedInTopK, threshold.goldPreservedInTopK),
  };

  return {
    basis: `CALIBRATION_CASES (${CALIBRATION_CASES.length} 例：hard_confuser 3 / no_skill 3 / multi_skill 3 / cross_language 3) + 冻结合成 profile/overlay`,
    caseCount: CALIBRATION_CASES.length,
    learnedColumns,
    thresholdsSupported: verdict.ok,
    suggestedThresholds,
    promotionVerdict: { ok: verdict.ok, reasons: verdict.ok ? [] : verdict.reasons },
  };
}
