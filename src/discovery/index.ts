export { tokenize } from "./tokenize.ts";
export {
  buildIndex,
  DEFAULT_BM25_PARAMS,
  DEFAULT_TOP_K,
  MAX_TOP_K,
} from "./bm25.ts";
export type {
  Bm25Params,
  DiscoveryIndex,
  SearchOptions,
} from "./bm25.ts";
export { formatCandidateCards } from "./candidate-card.ts";
export {
  observeCandidateBudgets,
  observeCardProjections,
  projectLightweightCards,
  SHADOW_CANDIDATE_BUDGETS,
  SHADOW_DESCRIPTION_LIMITS,
} from "./shadow-comparators.ts";
export {
  buildQueryExpansionIndex,
  DEFAULT_QUERY_EXPANSION_RULES,
  expandQuery,
} from "./query-expansion.ts";
export type {
  ExpandedDiscoveryIndex,
  QueryExpansionRule,
  QueryExpansionTrace,
} from "./query-expansion.ts";
