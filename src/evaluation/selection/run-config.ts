import { createHash } from "node:crypto";

export interface EvaluationRunConfig {
  readonly schemaVersion: 1;
  readonly catalogSnapshotHash: string;
  readonly goldSetHash: string;
  readonly thresholdConfigHash: string;
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
    readonly api: string;
    readonly modelRevision: string;
  };
  readonly inference: {
    readonly reasoningLevel: string;
    readonly temperature: number;
    readonly maxTokens: number;
    readonly timeoutMs: number;
    readonly maxRetries: number;
  };
  readonly selectionPromptHash: string;
  readonly topK: number;
  readonly retriever: {
    readonly name: string;
    readonly implementationRevision: string;
  };
  readonly candidateCardSerializationRevision: string;
  readonly host: {
    readonly package: string;
    readonly version: string;
  };
  readonly armOrder: "full_catalog_then_top_k" | "interleaved";
  readonly supplementalToolsEnabled: boolean;
}

/**
 * Hashes the immutable system/run configuration separately from Gold identity.
 * Explicit field order keeps the result stable across caller object ordering.
 */
export function computeEvaluationRunConfigHash(config: EvaluationRunConfig): string {
  assertSha256(config.catalogSnapshotHash, "catalogSnapshotHash");
  assertSha256(config.goldSetHash, "goldSetHash");
  assertSha256(config.thresholdConfigHash, "thresholdConfigHash");
  assertSha256(config.selectionPromptHash, "selectionPromptHash");
  assertNonEmpty(config.model.provider, "model.provider");
  assertNonEmpty(config.model.modelId, "model.modelId");
  assertNonEmpty(config.model.api, "model.api");
  assertNonEmpty(config.model.modelRevision, "model.modelRevision");
  assertNonEmpty(config.inference.reasoningLevel, "inference.reasoningLevel");
  assertPositiveInteger(config.inference.maxTokens, "inference.maxTokens");
  assertPositiveInteger(config.inference.timeoutMs, "inference.timeoutMs");
  if (!Number.isFinite(config.inference.temperature)) {
    throw new Error("evaluation_run_config_invalid:inference.temperature");
  }
  if (!Number.isInteger(config.inference.maxRetries) || config.inference.maxRetries < 0) {
    throw new Error("evaluation_run_config_invalid:inference.maxRetries");
  }
  assertPositiveInteger(config.topK, "topK");
  assertNonEmpty(config.retriever.name, "retriever.name");
  assertNonEmpty(config.retriever.implementationRevision, "retriever.implementationRevision");
  assertNonEmpty(config.candidateCardSerializationRevision, "candidateCardSerializationRevision");
  assertNonEmpty(config.host.package, "host.package");
  assertNonEmpty(config.host.version, "host.version");

  const canonical = {
    schemaVersion: config.schemaVersion,
    catalogSnapshotHash: config.catalogSnapshotHash,
    goldSetHash: config.goldSetHash,
    thresholdConfigHash: config.thresholdConfigHash,
    model: {
      provider: config.model.provider,
      modelId: config.model.modelId,
      api: config.model.api,
      modelRevision: config.model.modelRevision,
    },
    inference: {
      reasoningLevel: config.inference.reasoningLevel,
      temperature: config.inference.temperature,
      maxTokens: config.inference.maxTokens,
      timeoutMs: config.inference.timeoutMs,
      maxRetries: config.inference.maxRetries,
    },
    selectionPromptHash: config.selectionPromptHash,
    topK: config.topK,
    retriever: {
      name: config.retriever.name,
      implementationRevision: config.retriever.implementationRevision,
    },
    candidateCardSerializationRevision: config.candidateCardSerializationRevision,
    host: {
      package: config.host.package,
      version: config.host.version,
    },
    armOrder: config.armOrder,
    supplementalToolsEnabled: config.supplementalToolsEnabled,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

function assertSha256(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`evaluation_run_config_invalid:${field}`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`evaluation_run_config_invalid:${field}`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new Error(`evaluation_run_config_invalid:${field}`);
  }
}
