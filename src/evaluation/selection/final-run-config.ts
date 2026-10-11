import {
  computeEvaluationRunConfigHash,
  type EvaluationRunConfig,
} from "./run-config.ts";
import { FROZEN_FINAL_HELDOUT_GOLD_SET_HASH } from "./final-heldout-cases.ts";
import { FINAL_SELECTION_THRESHOLD_CONFIG_HASH } from "./final-thresholds.ts";

export const FROZEN_CATALOG_SNAPSHOT_ENTRIES_HASH =
  "sha256:e895d606e1a4b104987246a81fde19d5d93648232910795c0dc408556af5c4a1";
export const FINAL_SELECTION_SYSTEM_PROMPT =
  "Select only the installed skills required for the task. Follow the exact JSON response contract.";

export const FINAL_EVALUATION_RUN_CONFIG: EvaluationRunConfig = Object.freeze({
  schemaVersion: 1,
  catalogSnapshotHash: FROZEN_CATALOG_SNAPSHOT_ENTRIES_HASH,
  goldSetHash: FROZEN_FINAL_HELDOUT_GOLD_SET_HASH,
  thresholdConfigHash: FINAL_SELECTION_THRESHOLD_CONFIG_HASH,
  model: Object.freeze({
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    api: "openai-completions",
    // Provider does not expose an immutable backend revision. Preserve the
    // dated provider alias honestly instead of inventing a hidden version.
    modelRevision: "provider-alias:deepseek-v4-flash@2026-08-20",
  }),
  inference: Object.freeze({
    reasoningLevel: "high",
    temperature: 0,
    maxTokens: 256,
    timeoutMs: 120_000,
    maxRetries: 0,
  }),
  // Hash of FINAL_SELECTION_SYSTEM_PROMPT plus the frozen paired.ts source hash.
  selectionPromptHash:
    "sha256:414d48b0396ea342bf887b7ba38034553284472c7e78e01818355d050f0fa897",
  topK: 5,
  retriever: Object.freeze({
    name: "bm25",
    implementationRevision:
      "bm25.ts@sha256:eb2867e1cb220574b240c756d54d7143a79566fe85691fa7c487bbf499ccf2d4+tokenize.ts@sha256:3bafcd975eacc4bf43f548e381a869155c218685ea262bb4a2f383018d69a9cc",
  }),
  candidateCardSerializationRevision:
    "candidate-card.ts@sha256:5e33b93b506ad094f4304f60c6f08ea04deb0215c040383b1812b05ad4e2a273",
  host: Object.freeze({
    package: "@earendil-works/pi-coding-agent",
    version: "0.84.1",
  }),
  armOrder: "full_catalog_then_top_k",
  supplementalToolsEnabled: false,
});

export const FROZEN_FINAL_EVALUATION_RUN_CONFIG_HASH =
  "sha256:30dbdaa057ba98c2fdbb622108e0d16a1fce1c8ba5ba8af53360768550e3ab7b";

if (computeEvaluationRunConfigHash(FINAL_EVALUATION_RUN_CONFIG) !==
    FROZEN_FINAL_EVALUATION_RUN_CONFIG_HASH) {
  throw new Error("frozen_final_evaluation_run_config_hash_mismatch");
}
