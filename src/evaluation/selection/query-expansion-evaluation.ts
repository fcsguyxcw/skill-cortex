import type { SkillRecord } from "../../core/contracts/index.ts";
import { buildIndex, type DiscoveryIndex } from "../../discovery/bm25.ts";
import { buildQueryExpansionIndex, type ExpandedDiscoveryIndex } from "../../discovery/query-expansion.ts";
import type { QueryExpansionEvalCase } from "./query-expansion-cases.ts";

export interface RetrievalMetricSlice {
  readonly caseCount: number;
  readonly goldCaseCount: number;
  readonly goldAvailableCases: number;
  readonly goldAvailabilityRecallAtK: number | null;
  readonly noSkillCaseCount: number;
  readonly noSkillFalsePositiveCases: number;
  readonly noSkillFalsePositiveRate: number | null;
}

export interface RetrievalCaseResult {
  readonly caseId: string;
  readonly partition: QueryExpansionEvalCase["partition"];
  readonly language: QueryExpansionEvalCase["language"];
  readonly labelType: QueryExpansionEvalCase["labelType"];
  readonly goldSkillIds: readonly string[];
  readonly candidateSkillIds: readonly string[];
  readonly goldAvailable: boolean;
  readonly noSkillFalsePositive: boolean;
  readonly matchedExpansionRuleIds: readonly string[];
}

export interface RetrievalVariantReport {
  readonly variant: "bm25" | "bm25_query_expansion";
  readonly topK: number;
  readonly cases: readonly RetrievalCaseResult[];
  readonly metrics: {
    readonly overall: RetrievalMetricSlice;
    readonly zh: RetrievalMetricSlice;
    readonly en: RetrievalMetricSlice;
    readonly single: RetrievalMetricSlice;
    readonly multi: RetrievalMetricSlice;
    readonly noSkill: RetrievalMetricSlice;
    readonly calibration: RetrievalMetricSlice;
    readonly dev: RetrievalMetricSlice;
  };
}

export interface QueryExpansionAblationReport {
  readonly schemaVersion: 1;
  readonly sourceMode: "evaluation_fixture";
  readonly caseCount: number;
  readonly baseline: RetrievalVariantReport;
  readonly queryExpansion: RetrievalVariantReport;
}

export function runQueryExpansionAblation(options: {
  readonly catalog: readonly SkillRecord[];
  readonly cases: readonly QueryExpansionEvalCase[];
  readonly topK?: number;
}): QueryExpansionAblationReport {
  validateCases(options.catalog, options.cases);
  const topK = options.topK ?? 5;
  const baseline = buildIndex(options.catalog);
  const expanded = buildQueryExpansionIndex(options.catalog);
  return {
    schemaVersion: 1,
    sourceMode: "evaluation_fixture",
    caseCount: options.cases.length,
    baseline: evaluateVariant("bm25", baseline, options.cases, topK),
    queryExpansion: evaluateVariant("bm25_query_expansion", expanded, options.cases, topK),
  };
}

function evaluateVariant(
  variant: RetrievalVariantReport["variant"],
  index: DiscoveryIndex | ExpandedDiscoveryIndex,
  cases: readonly QueryExpansionEvalCase[],
  topK: number,
): RetrievalVariantReport {
  const results = cases.map((item): RetrievalCaseResult => {
    const expanded = "searchWithTrace" in index
      ? index.searchWithTrace(item.query, { limit: topK })
      : { candidates: index.search(item.query, { limit: topK }), expansion: undefined };
    const candidateSkillIds = expanded.candidates.map((candidate) => candidate.skillId);
    return {
      caseId: item.id,
      partition: item.partition,
      language: item.language,
      labelType: item.labelType,
      goldSkillIds: [...item.goldSkillIds],
      candidateSkillIds,
      goldAvailable: item.goldSkillIds.length > 0 && item.goldSkillIds.every((id) => candidateSkillIds.includes(id)),
      noSkillFalsePositive: item.labelType === "no_skill" && candidateSkillIds.length > 0,
      matchedExpansionRuleIds: expanded.expansion?.matchedRuleIds ?? [],
    };
  });
  return {
    variant,
    topK,
    cases: results,
    metrics: {
      overall: summarize(results),
      zh: summarize(results.filter((item) => item.language === "zh")),
      en: summarize(results.filter((item) => item.language === "en")),
      single: summarize(results.filter((item) => item.labelType === "single")),
      multi: summarize(results.filter((item) => item.labelType === "multi")),
      noSkill: summarize(results.filter((item) => item.labelType === "no_skill")),
      calibration: summarize(results.filter((item) => item.partition === "calibration")),
      dev: summarize(results.filter((item) => item.partition === "dev")),
    },
  };
}

function summarize(cases: readonly RetrievalCaseResult[]): RetrievalMetricSlice {
  const goldCases = cases.filter((item) => item.labelType !== "no_skill");
  const noSkillCases = cases.filter((item) => item.labelType === "no_skill");
  const goldAvailableCases = goldCases.filter((item) => item.goldAvailable).length;
  const noSkillFalsePositiveCases = noSkillCases.filter((item) => item.noSkillFalsePositive).length;
  return {
    caseCount: cases.length,
    goldCaseCount: goldCases.length,
    goldAvailableCases,
    goldAvailabilityRecallAtK: goldCases.length === 0 ? null : goldAvailableCases / goldCases.length,
    noSkillCaseCount: noSkillCases.length,
    noSkillFalsePositiveCases,
    noSkillFalsePositiveRate: noSkillCases.length === 0 ? null : noSkillFalsePositiveCases / noSkillCases.length,
  };
}

function validateCases(catalog: readonly SkillRecord[], cases: readonly QueryExpansionEvalCase[]): void {
  const catalogIds = new Set(catalog.map((item) => item.skillId));
  if (catalogIds.size !== catalog.length) throw new Error("query_expansion_catalog_duplicate_skill_id");
  const caseIds = new Set<string>();
  for (const item of cases) {
    if (caseIds.has(item.id)) throw new Error("query_expansion_duplicate_case_id");
    caseIds.add(item.id);
    if (item.labelType === "no_skill" && item.goldSkillIds.length !== 0) throw new Error("query_expansion_no_skill_has_gold");
    if (item.labelType !== "no_skill" && item.goldSkillIds.length === 0) throw new Error("query_expansion_gold_missing");
    if (item.goldSkillIds.some((id) => !catalogIds.has(id))) throw new Error("query_expansion_gold_not_in_catalog");
  }
}
