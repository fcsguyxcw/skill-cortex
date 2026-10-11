/**
 * Phase 6 第二批 —— 分栏评估（纯函数，project-local；对照静态 discovery 冻结 fixture）。
 *
 * plan §11 任务 4 + 验证清单：
 * - 四栏：hard confuser（干扰项不误召、正确项不误杀）/ no-skill（不误召）/ multi-skill
 *   （多 gold 全召回）/ cross-language（跨语言查询命中）；
 * - 每栏分别报告 Recall@K 与 set recall，learned（overlay）对照 static 判定非劣
 *   （learned ≥ static − tolerance；violations 明确列出）；
 * - near-miss 降权不得把正确候选挤出 Top-K（退化检测：learned Top-K 保留 static Top-K
 *   中的 gold 命中）；
 * - 关闭 overlay（无 profile）⇒ learned 栏必须等于 static 栏（可复现）；
 * - 输出结构化结果，供后续 active promotion gate 使用（本模块不做 promotion）。
 */
import type {
  ActivationProfile,
  SkillCandidate,
  SkillRecord,
} from "../core/contracts/index.ts";
import { buildIndex } from "../discovery/bm25.ts";
import { rerankWithOverlay } from "./rerank.ts";

export type EvaluationColumn =
  | "hard_confuser"
  | "no_skill"
  | "multi_skill"
  | "cross_language";

export interface EvaluationCase {
  id: string;
  column: EvaluationColumn;
  query: string;
  /** gold：应被召回的 skillId 集（no-skill 栏为空）。 */
  expectedSkillIds: readonly string[];
  /** hard-confuser：干扰 skillId（不得被召回）。 */
  confuserSkillIds?: readonly string[];
}

export interface ColumnRecall {
  column: EvaluationColumn;
  caseCount: number;
  /** 正确命中数 / gold 数（gold 为空栏为 N/A）。 */
  recallAtK: number | "N/A";
  /** Top-K 集合与 gold 的交集比例（与 recallAtK 同值；保留独立字段便于分栏）。 */
  setRecall: number | "N/A";
  /** no-skill 栏：gold 为空的案例中预测为空（不误召）的比例。 */
  noSkillPrecision: number | "N/A";
  /** hard-confuser 栏：confuser 未被召回的比例（不误召干扰项）。 */
  confuserNotRecalled: number | "N/A";
  /** 退化检测：learned Top-K 保留 static Top-K 中 gold 命中的比例（1=无挤出）。 */
  goldPreservedInTopK: number | "N/A";
}

export interface OverlayEvaluationReport {
  staticColumns: readonly ColumnRecall[];
  learnedColumns: readonly ColumnRecall[];
  /** learned 各栏 recall/noSkillPrecision/confuserNotRecalled/goldPreserved 均不低于 static − tolerance。 */
  nonInferior: boolean;
  violations: readonly string[];
}

export interface EvaluateOptions {
  aliasBoost?: number;
  positiveBoost?: number;
  nearMissPenalty?: number;
  /** 非劣容差（默认 0：learned 必须 ≥ static）。 */
  tolerance?: number;
  topK?: number;
}

const COLUMNS: readonly EvaluationColumn[] = [
  "hard_confuser",
  "no_skill",
  "multi_skill",
  "cross_language",
];

function idSet(candidates: readonly SkillCandidate[]): ReadonlySet<string> {
  return new Set(candidates.map((candidate) => candidate.skillId));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function emptyColumn(column: EvaluationColumn): ColumnRecall {
  return {
    column,
    caseCount: 0,
    recallAtK: "N/A",
    setRecall: "N/A",
    noSkillPrecision: "N/A",
    confuserNotRecalled: "N/A",
    goldPreservedInTopK: "N/A",
  };
}

/** 单栏指标（某组案例在某运行下的聚合）。 */
function columnMetrics(
  column: EvaluationColumn,
  cases: readonly EvaluationCase[],
  predict: (query: string) => readonly SkillCandidate[],
  staticGoldHits?: Map<string, ReadonlySet<string>>,
): ColumnRecall {
  if (cases.length === 0) return emptyColumn(column);
  let recallSum = 0;
  let recallCases = 0;
  let noSkillCorrect = 0;
  let noSkillCases = 0;
  let confuserCorrect = 0;
  let confuserCases = 0;
  let preservedSum = 0;
  let preservedCases = 0;

  for (const case_ of cases) {
    const predicted = predict(case_.query);
    const predictedIds = idSet(predicted);
    const gold = new Set(case_.expectedSkillIds);
    if (gold.size > 0) {
      const hit = [...gold].filter((id) => predictedIds.has(id)).length;
      recallSum += ratio(hit, gold.size);
      recallCases += 1;
      // 退化检测：static Top-K 的 gold 命中是否仍被 learned Top-K 保留。
      const staticGold = staticGoldHits?.get(case_.id);
      if (staticGold !== undefined && staticGold.size > 0) {
        const preserved = [...staticGold].filter((id) => predictedIds.has(id)).length;
        preservedSum += ratio(preserved, staticGold.size);
        preservedCases += 1;
      }
    } else {
      // no-skill：期望空召回。
      noSkillCases += 1;
      if (predictedIds.size === 0) noSkillCorrect += 1;
    }
    if (case_.confuserSkillIds !== undefined && case_.confuserSkillIds.length > 0) {
      confuserCases += 1;
      const confuserHit = case_.confuserSkillIds.some((id) => predictedIds.has(id));
      if (!confuserHit) confuserCorrect += 1;
    }
  }

  return {
    column,
    caseCount: cases.length,
    recallAtK: recallCases === 0 ? "N/A" : recallSum / recallCases,
    setRecall: recallCases === 0 ? "N/A" : recallSum / recallCases,
    noSkillPrecision: noSkillCases === 0 ? "N/A" : noSkillCorrect / noSkillCases,
    confuserNotRecalled: confuserCases === 0 ? "N/A" : confuserCorrect / confuserCases,
    goldPreservedInTopK: preservedCases === 0 ? "N/A" : preservedSum / preservedCases,
  };
}

function comparable(value: number | "N/A"): number {
  return value === "N/A" ? 1 : value;
}

/**
 * 分栏评估：对每栏案例分别用静态 BM25 与 learned overlay rerank 预测，聚合指标并判定非劣。
 * 冻结 fixture 由调用方提供（合成/held-out records），不写真实事件。
 */
export function evaluateOverlay(
  cases: readonly EvaluationCase[],
  records: readonly SkillRecord[],
  profile: ActivationProfile | undefined,
  options: EvaluateOptions = {},
): OverlayEvaluationReport {
  const index = buildIndex(records);
  const topK = options.topK ?? 5;
  const tolerance = options.tolerance ?? 0;
  const staticCandidatesOf = (query: string): readonly SkillCandidate[] =>
    index.search(query, { limit: topK });

  // 静态 Top-K 的 gold 命中（退化检测基准）。
  const staticGoldHits = new Map<string, ReadonlySet<string>>();
  for (const case_ of cases) {
    const gold = new Set(case_.expectedSkillIds);
    if (gold.size === 0) continue;
    const predicted = idSet(staticCandidatesOf(case_.query));
    staticGoldHits.set(case_.id, new Set([...gold].filter((id) => predicted.has(id))));
  }

  const learnedCandidatesOf = (query: string): readonly SkillCandidate[] =>
    rerankWithOverlay(staticCandidatesOf(query), profile, query, {
      aliasBoost: options.aliasBoost,
      positiveBoost: options.positiveBoost,
      nearMissPenalty: options.nearMissPenalty,
    });

  const staticColumns = COLUMNS.map((column) =>
    columnMetrics(
      column,
      cases.filter((case_) => case_.column === column),
      staticCandidatesOf,
    ),
  );
  const learnedColumns = COLUMNS.map((column) =>
    columnMetrics(
      column,
      cases.filter((case_) => case_.column === column),
      learnedCandidatesOf,
      staticGoldHits,
    ),
  );

  const violations: string[] = [];
  for (let i = 0; i < COLUMNS.length; i += 1) {
    const column = COLUMNS[i]!;
    const staticCol = staticColumns[i]!;
    const learnedCol = learnedColumns[i]!;
    const checks: Array<[string, number | "N/A", number | "N/A"]> = [
      ["recallAtK", staticCol.recallAtK, learnedCol.recallAtK],
      ["setRecall", staticCol.setRecall, learnedCol.setRecall],
      ["noSkillPrecision", staticCol.noSkillPrecision, learnedCol.noSkillPrecision],
      ["confuserNotRecalled", staticCol.confuserNotRecalled, learnedCol.confuserNotRecalled],
      ["goldPreservedInTopK", staticCol.goldPreservedInTopK, learnedCol.goldPreservedInTopK],
    ];
    for (const [metric, staticValue, learnedValue] of checks) {
      if (staticValue === "N/A" && learnedValue === "N/A") continue;
      if (comparable(learnedValue) < comparable(staticValue) - tolerance) {
        violations.push(
          `${column}.${metric}: learned=${learnedValue} < static=${staticValue} (tolerance=${tolerance})`,
        );
      }
    }
  }

  return {
    staticColumns,
    learnedColumns,
    nonInferior: violations.length === 0,
    violations,
  };
}
