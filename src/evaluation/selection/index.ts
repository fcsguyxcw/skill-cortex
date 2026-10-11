export {
  buildSelectionPrompt,
  computeCatalogHash,
  computeGoldSetHash,
  estimateSelectionTokens,
  exactSkillSetEqual,
  formatFullCatalog,
  parseSelectionResponse,
  runSelectionPaired,
  SELECTION_SOURCE_MODE,
  ESTIMATED_TOKEN_METHOD,
} from "./paired.ts";

export type {
  ParsedSelectionResponse,
  RunSelectionPairedOptions,
  SelectionArm,
  SelectionArmReport,
  SelectionCaseResult,
  SelectionEvalCase,
  SelectionInvocationRequest,
  SelectionModelInvoker,
  SelectionPairedCaseResult,
  SelectionPairedReport,
  SelectionParseFailure,
  SelectionResponseParseResult,
} from "./paired.ts";

export {
  DEV_SELECTION_CASES,
  EXPECTED_CATALOG_HASH,
  FROZEN_GOLD_SET_HASH,
} from "./dev-cases.ts";
export type { FrozenSelectionDevCase } from "./dev-cases.ts";

export {
  REAL_SELECTION_SOURCE_MODE,
  runRealSelectionPaired,
} from "./real-model.ts";

export { computeEvaluationRunConfigHash } from "./run-config.ts";
export type { EvaluationRunConfig } from "./run-config.ts";

export {
  FINAL_SELECTION_THRESHOLD_CONFIG_HASH,
  FINAL_SELECTION_THRESHOLDS,
  hashThresholds,
} from "./final-thresholds.ts";

export { runFrozenFinalSelectionPaired } from "./final-runner.ts";
export type {
  FrozenFinalSelectionReport,
  RunFrozenFinalSelectionOptions,
} from "./final-runner.ts";

export { evaluateFinalSelection } from "./final-verdict.ts";
export type {
  FinalSelectionBreakdown,
  FinalSelectionBreakdownResult,
  FinalSelectionGateResult,
  FinalSelectionVerdict,
} from "./final-verdict.ts";

export {
  EXPECTED_CATALOG_HASH as FINAL_HELDOUT_EXPECTED_CATALOG_HASH,
  FINAL_HELDOUT_CASES,
  FROZEN_FINAL_HELDOUT_GOLD_SET_HASH,
} from "./final-heldout-cases.ts";
export type { FrozenSelectionFinalHeldoutCase } from "./final-heldout-cases.ts";

export {
  FINAL_EVALUATION_RUN_CONFIG,
  FINAL_SELECTION_SYSTEM_PROMPT,
  FROZEN_CATALOG_SNAPSHOT_ENTRIES_HASH,
  FROZEN_FINAL_EVALUATION_RUN_CONFIG_HASH,
} from "./final-run-config.ts";
export type {
  RealSelectionCallEvidence,
  RealSelectionCompleter,
  RealSelectionCompletion,
  RealSelectionModelConfig,
  RealSelectionReport,
  RunRealSelectionOptions,
  SelectionUsage,
  SelectionUsageSummary,
} from "./real-model.ts";

export { QUERY_EXPANSION_EVAL_CASES } from "./query-expansion-cases.ts";
export type {
  QueryExpansionEvalCase,
  QueryExpansionEvalLabel,
  QueryExpansionEvalPartition,
} from "./query-expansion-cases.ts";
export { runQueryExpansionAblation } from "./query-expansion-evaluation.ts";
export type {
  QueryExpansionAblationReport,
  RetrievalCaseResult,
  RetrievalMetricSlice,
  RetrievalVariantReport,
} from "./query-expansion-evaluation.ts";
