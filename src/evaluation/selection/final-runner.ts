import type { SkillRecord } from "../../core/contracts/index.ts";
import {
  runRealSelectionPaired,
  type RealSelectionCompleter,
  type RealSelectionModelConfig,
  type RealSelectionReport,
} from "./real-model.ts";
import {
  computeEvaluationRunConfigHash,
  type EvaluationRunConfig,
} from "./run-config.ts";
import type { SelectionEvalCase } from "./paired.ts";

export interface RunFrozenFinalSelectionOptions {
  readonly catalog: readonly SkillRecord[];
  readonly cases: readonly SelectionEvalCase[];
  readonly expectedCatalogHash: string;
  readonly expectedCatalogSnapshotHash: string;
  readonly expectedGoldSetHash: string;
  readonly expectedThresholdConfigHash: string;
  readonly expectedRunConfigHash: string;
  readonly runConfig: EvaluationRunConfig;
  readonly modelRevision: string;
  readonly generatedAt: string;
  readonly model: RealSelectionModelConfig;
  readonly complete: RealSelectionCompleter;
}

export interface FrozenFinalSelectionReport extends RealSelectionReport {
  readonly evidenceMode: "final_heldout_first_reveal";
  readonly evaluationRunConfigHash: string;
  readonly evaluationRunConfig: EvaluationRunConfig;
}

/**
 * One-shot final-heldout entry point. All immutable identities are checked
 * before the first provider call; callers must enforce the revealed-set policy
 * after the resulting report is viewed.
 */
export async function runFrozenFinalSelectionPaired(
  options: RunFrozenFinalSelectionOptions,
): Promise<FrozenFinalSelectionReport> {
  if (options.runConfig.catalogSnapshotHash !== options.expectedCatalogSnapshotHash ||
      options.runConfig.goldSetHash !== options.expectedGoldSetHash ||
      options.runConfig.thresholdConfigHash !== options.expectedThresholdConfigHash) {
    throw new Error("final_selection_run_config_identity_mismatch");
  }
  if (options.runConfig.model.provider !== options.model.provider ||
      options.runConfig.model.modelId !== options.model.modelId ||
      options.runConfig.model.api !== options.model.api ||
      options.runConfig.model.modelRevision !== options.modelRevision ||
      options.runConfig.inference.reasoningLevel !== options.model.thinkingLevel ||
      options.runConfig.inference.temperature !== options.model.temperature ||
      options.runConfig.inference.maxTokens !== options.model.maxTokens ||
      options.runConfig.inference.timeoutMs !== options.model.timeoutMs ||
      options.runConfig.inference.maxRetries !== options.model.maxRetries) {
    throw new Error("final_selection_model_config_mismatch");
  }
  const runConfigHash = computeEvaluationRunConfigHash(options.runConfig);
  if (runConfigHash !== options.expectedRunConfigHash) {
    throw new Error("final_selection_run_config_hash_mismatch");
  }
  if (options.runConfig.topK < 1) {
    throw new Error("final_selection_run_config_top_k_invalid");
  }

  const report = await runRealSelectionPaired({
    catalog: options.catalog,
    cases: options.cases,
    expectedCatalogHash: options.expectedCatalogHash,
    expectedGoldSetHash: options.expectedGoldSetHash,
    topK: options.runConfig.topK,
    generatedAt: options.generatedAt,
    model: options.model,
    complete: options.complete,
  });
  return {
    ...report,
    evidenceMode: "final_heldout_first_reveal",
    evaluationRunConfigHash: runConfigHash,
    evaluationRunConfig: options.runConfig,
  };
}
