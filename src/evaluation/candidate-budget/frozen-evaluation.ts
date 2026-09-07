import { createHash } from "node:crypto";

import type { SkillRecord } from "../../core/contracts/index.ts";
import {
  buildIndex,
  observeCardProjections,
  SHADOW_CANDIDATE_BUDGETS,
} from "../../discovery/index.ts";
import {
  EXPECTED_CATALOG_HASH,
  FROZEN_GOLD_SET_HASH,
} from "../selection/dev-cases.ts";
import { FROZEN_FINAL_HELDOUT_GOLD_SET_HASH } from "../selection/final-heldout-cases.ts";
import { computeGoldSetHash, type SelectionEvalCase } from "../selection/paired.ts";

export type CandidateBudgetEvaluationPartition = "dev" | "frozen_replay";

export interface CandidateBudgetEvaluationCase extends SelectionEvalCase {
  readonly labelType: "single" | "multi" | "no_skill";
  readonly hardConfuser?: boolean;
}

export const FROZEN_CANDIDATE_BUDGET_CONFIG = Object.freeze({
  schemaVersion: 1 as const,
  sourceMode: "evaluation_fixture" as const,
  catalogHash: EXPECTED_CATALOG_HASH,
  devGoldSetHash: FROZEN_GOLD_SET_HASH,
  replayGoldSetHash: FROZEN_FINAL_HELDOUT_GOLD_SET_HASH,
  retriever: "bm25" as const,
  baselineBudget: 5 as const,
  budgets: SHADOW_CANDIDATE_BUDGETS,
  offlineSupportedBudget: 3 as const,
  cardDescriptionLimits: [120, 240, 480] as const,
});

export const FROZEN_CANDIDATE_BUDGET_CONFIG_HASH =
  "sha256:f829bae90b0410db27d53d46e00240a12950e28b8ad2834854d55aba954057dd";

export interface CandidateBudgetMetrics {
  readonly budget: 1 | 2 | 3 | 5;
  readonly totalCandidateCount: number;
  readonly totalDescriptionChars: number;
  readonly candidateCountReductionFromBaseline: number;
  readonly descriptionCharReductionFromBaseline: number;
  readonly goldCaseCount: number;
  readonly goldFullSetAvailableCount: number;
  readonly goldFullSetAvailability: number | null;
  readonly multiCaseCount: number;
  readonly multiFullSetAvailableCount: number;
  readonly multiFullSetAvailability: number | null;
  readonly hardGoldCaseCount: number;
  readonly hardGoldFullSetAvailableCount: number;
  readonly hardGoldFullSetAvailability: number | null;
}

export interface CandidateBudgetEvaluationReport {
  readonly schemaVersion: 1;
  readonly evidenceLevel: "offline_component";
  readonly partition: CandidateBudgetEvaluationPartition;
  readonly configHash: string;
  readonly caseCount: number;
  readonly budgets: readonly CandidateBudgetMetrics[];
  readonly supportedBudget: 3;
  readonly supportedBudgetPreservesBaseline: boolean;
  readonly cardProjectionAtSupportedBudget: {
    readonly baselineDescriptionChars: number;
    readonly variants: ReadonlyArray<{
      readonly maxDescriptionChars: 120 | 240 | 480;
      readonly totalDescriptionChars: number;
      readonly descriptionCharReduction: number;
      readonly truncatedCandidateCount: number;
    }>;
    readonly supportedDescriptionLimit: null;
  };
}

export function computeFrozenCandidateBudgetConfigHash(): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(FROZEN_CANDIDATE_BUDGET_CONFIG), "utf8")
    .digest("hex")}`;
}

export function runFrozenCandidateBudgetEvaluation(options: {
  readonly catalog: readonly SkillRecord[];
  readonly catalogHash: string;
  readonly cases: readonly CandidateBudgetEvaluationCase[];
  readonly partition: CandidateBudgetEvaluationPartition;
}): CandidateBudgetEvaluationReport {
  validateInput(options);
  const index = buildIndex(options.catalog);
  const rankedByCase = options.cases.map((item) => ({
    item,
    candidates: index.search(item.query, { limit: FROZEN_CANDIDATE_BUDGET_CONFIG.baselineBudget }),
  }));
  const rawMetrics = FROZEN_CANDIDATE_BUDGET_CONFIG.budgets.map((budget) =>
    metricsForBudget(rankedByCase, budget),
  );
  const baseline = rawMetrics.find((item) => item.budget === FROZEN_CANDIDATE_BUDGET_CONFIG.baselineBudget)!;
  const budgets = rawMetrics.map((item) => Object.freeze({
    ...item,
    candidateCountReductionFromBaseline: reduction(item.totalCandidateCount, baseline.totalCandidateCount),
    descriptionCharReductionFromBaseline: reduction(item.totalDescriptionChars, baseline.totalDescriptionChars),
  }));
  const supported = budgets.find((item) =>
    item.budget === FROZEN_CANDIDATE_BUDGET_CONFIG.offlineSupportedBudget,
  )!;
  const supportedCards = rankedByCase.flatMap(({ candidates }) =>
    candidates.slice(0, FROZEN_CANDIDATE_BUDGET_CONFIG.offlineSupportedBudget),
  );
  const projection = observeCardProjections(supportedCards);

  return Object.freeze({
    schemaVersion: 1,
    evidenceLevel: "offline_component",
    partition: options.partition,
    configHash: FROZEN_CANDIDATE_BUDGET_CONFIG_HASH,
    caseCount: options.cases.length,
    budgets: Object.freeze(budgets),
    supportedBudget: FROZEN_CANDIDATE_BUDGET_CONFIG.offlineSupportedBudget,
    supportedBudgetPreservesBaseline:
      supported.goldFullSetAvailableCount === baseline.goldFullSetAvailableCount
      && supported.multiFullSetAvailableCount === baseline.multiFullSetAvailableCount
      && supported.hardGoldFullSetAvailableCount === baseline.hardGoldFullSetAvailableCount,
    cardProjectionAtSupportedBudget: Object.freeze({
      baselineDescriptionChars: projection.baselineDescriptionChars,
      variants: Object.freeze(projection.variants.map((variant) => Object.freeze({
        ...variant,
        descriptionCharReduction: reduction(
          variant.totalDescriptionChars,
          projection.baselineDescriptionChars,
        ),
      }))),
      supportedDescriptionLimit: null,
    }),
  });
}

function metricsForBudget(
  rankedByCase: ReadonlyArray<{
    readonly item: CandidateBudgetEvaluationCase;
    readonly candidates: ReturnType<ReturnType<typeof buildIndex>["search"]>;
  }>,
  budget: 1 | 2 | 3 | 5,
): Omit<CandidateBudgetMetrics, "candidateCountReductionFromBaseline" | "descriptionCharReductionFromBaseline"> {
  const cases = rankedByCase.map(({ item, candidates }) => {
    const bounded = candidates.slice(0, budget);
    const ids = new Set(bounded.map((candidate) => candidate.skillId));
    return {
      item,
      bounded,
      fullSetAvailable: item.goldSkillIds.length > 0
        && item.goldSkillIds.every((skillId) => ids.has(skillId)),
    };
  });
  const gold = cases.filter(({ item }) => item.goldSkillIds.length > 0);
  const multi = cases.filter(({ item }) => item.labelType === "multi");
  const hardGold = gold.filter(({ item }) => item.hardConfuser === true);
  return {
    budget,
    totalCandidateCount: cases.reduce((sum, item) => sum + item.bounded.length, 0),
    totalDescriptionChars: cases.reduce((sum, item) =>
      sum + item.bounded.reduce((candidateSum, candidate) => candidateSum + candidate.description.length, 0), 0),
    goldCaseCount: gold.length,
    goldFullSetAvailableCount: gold.filter((item) => item.fullSetAvailable).length,
    goldFullSetAvailability: rate(gold.filter((item) => item.fullSetAvailable).length, gold.length),
    multiCaseCount: multi.length,
    multiFullSetAvailableCount: multi.filter((item) => item.fullSetAvailable).length,
    multiFullSetAvailability: rate(multi.filter((item) => item.fullSetAvailable).length, multi.length),
    hardGoldCaseCount: hardGold.length,
    hardGoldFullSetAvailableCount: hardGold.filter((item) => item.fullSetAvailable).length,
    hardGoldFullSetAvailability: rate(hardGold.filter((item) => item.fullSetAvailable).length, hardGold.length),
  };
}

function validateInput(options: {
  readonly catalog: readonly SkillRecord[];
  readonly catalogHash: string;
  readonly cases: readonly CandidateBudgetEvaluationCase[];
  readonly partition: CandidateBudgetEvaluationPartition;
}): void {
  if (options.catalogHash !== FROZEN_CANDIDATE_BUDGET_CONFIG.catalogHash) {
    throw new Error("candidate_budget_catalog_hash_mismatch");
  }
  if (computeFrozenCandidateBudgetConfigHash() !== FROZEN_CANDIDATE_BUDGET_CONFIG_HASH) {
    throw new Error("candidate_budget_config_hash_mismatch");
  }
  const expectedGoldHash = options.partition === "dev"
    ? FROZEN_CANDIDATE_BUDGET_CONFIG.devGoldSetHash
    : FROZEN_CANDIDATE_BUDGET_CONFIG.replayGoldSetHash;
  if (computeGoldSetHash(options.catalogHash, options.cases) !== expectedGoldHash) {
    throw new Error("candidate_budget_gold_set_hash_mismatch");
  }
  const catalogIds = new Set(options.catalog.map((item) => item.skillId));
  if (catalogIds.size !== options.catalog.length) throw new Error("candidate_budget_catalog_duplicate");
  if (options.cases.some((item) => item.goldSkillIds.some((skillId) => !catalogIds.has(skillId)))) {
    throw new Error("candidate_budget_gold_not_in_catalog");
  }
}

function reduction(value: number, baseline: number): number {
  return baseline === 0 ? 0 : 1 - value / baseline;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
