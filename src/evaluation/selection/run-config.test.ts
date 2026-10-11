import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeEvaluationRunConfigHash,
  type EvaluationRunConfig,
} from "./run-config.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

function config(): EvaluationRunConfig {
  return {
    schemaVersion: 1,
    catalogSnapshotHash: HASH_A,
    goldSetHash: HASH_B,
    thresholdConfigHash: HASH_C,
    model: {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      api: "openai-completions",
      modelRevision: "provider-reported-revision-1",
    },
    inference: {
      reasoningLevel: "high",
      temperature: 0,
      maxTokens: 256,
      timeoutMs: 120_000,
      maxRetries: 0,
    },
    selectionPromptHash: HASH_D,
    topK: 5,
    retriever: { name: "bm25", implementationRevision: "git:abc123" },
    candidateCardSerializationRevision: "candidate-card-v1",
    host: { package: "@earendil-works/pi-coding-agent", version: "0.84.1" },
    armOrder: "full_catalog_then_top_k",
    supplementalToolsEnabled: false,
  };
}

describe("EvaluationRunConfigHash", () => {
  it("is deterministic and changes when a tested-system field changes", () => {
    const base = config();
    const hash = computeEvaluationRunConfigHash(base);
    assert.match(hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(computeEvaluationRunConfigHash({ ...base }), hash);
    assert.notEqual(
      computeEvaluationRunConfigHash({ ...base, topK: 6 }),
      hash,
    );
    assert.notEqual(
      computeEvaluationRunConfigHash({
        ...base,
        model: { ...base.model, modelRevision: "provider-reported-revision-2" },
      }),
      hash,
    );
  });

  it("fails closed for missing reproducibility fields", () => {
    const base = config();
    assert.throws(
      () => computeEvaluationRunConfigHash({ ...base, selectionPromptHash: "missing" }),
      /evaluation_run_config_invalid:selectionPromptHash/,
    );
    assert.throws(
      () => computeEvaluationRunConfigHash({ ...base, topK: 0 }),
      /evaluation_run_config_invalid:topK/,
    );
    assert.throws(
      () => computeEvaluationRunConfigHash({
        ...base,
        model: { ...base.model, modelRevision: "" },
      }),
      /evaluation_run_config_invalid:model\.modelRevision/,
    );
  });
});
