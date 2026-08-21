import { createHash } from "node:crypto";

import type { SkillRecord } from "../../core/contracts/index.ts";
import { DEFAULT_QUERY_EXPANSION_RULES } from "../../discovery/query-expansion.ts";
import { computeGoldSetHash } from "../selection/paired.ts";
import {
  DEFAULT_MAX_MEMORY_CARD_CHARS,
  DEFAULT_MAX_MEMORY_ENTRIES_PER_SECTION,
  DEFAULT_MAX_MEMORY_TOTAL_CHARS,
} from "./memory-card.ts";
import {
  SELECTION_MEMORY_EXPERIMENT_CATALOG_HASH,
  SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS,
  SELECTION_MEMORY_FREEZE_HASH,
} from "./catalog.ts";
import { SELECTION_MEMORY_CALIBRATION_CASES } from "./calibration-cases.ts";
import {
  SELECTION_MEMORY_CATALOG_HASH,
  computeSelectionMemoryCaseSetHash,
  computeSelectionMemoryEvidenceHash,
} from "./evidence-cases.ts";
import { SELECTION_MEMORY_PROMPT_VERSION } from "./prompt.ts";
import { SELECTION_MEMORY_ARMS, SELECTION_MEMORY_RUNNER_VERSION } from "./runner.ts";

export const SELECTION_MEMORY_CALIBRATION_SYSTEM_PROMPT =
  "Select only the installed skills required for the task. Follow the exact JSON response contract.";

/** Computed from the 19 reconstructed snapshot records; pinned by tests below the config seam. */
export const SELECTION_MEMORY_CALIBRATION_CATALOG_CONTENT_HASH =
  "sha256:a06e22fed2885dee73f7ea7fe6a3802287604192b2dfe6c9ec7006df377828cd";

export interface SelectionCatalogSnapshotEntry {
  readonly skillId: string;
  readonly name: string;
  readonly skillRevision: string;
  readonly description: string;
}

export interface SelectionCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly catalogHash: string;
  readonly entries: readonly SelectionCatalogSnapshotEntry[];
}

export interface SelectionMemoryCalibrationConfig {
  readonly schemaVersion: 1;
  readonly protocol: "selection-memory-context-calibration-v1";
  readonly freezeHash: string;
  readonly parentCatalogHash: string;
  readonly experimentCatalogHash: string;
  readonly catalogContentHash: string;
  readonly evidenceHash: string;
  readonly calibrationCaseHash: string;
  readonly calibrationGoldSetHash: string;
  readonly queryExpansionRulesHash: string;
  readonly promptVersion: number;
  readonly runnerVersion: number;
  readonly systemPromptHash: string;
  readonly candidateScope: "user";
  readonly memoryLimits: {
    readonly entriesPerSection: number;
    readonly cardChars: number;
    readonly totalChars: number;
  };
  readonly layers: readonly ["selection_isolated", "retrieval_controlled"];
  readonly arms: typeof SELECTION_MEMORY_ARMS;
  readonly topK: number;
  readonly repeatCount: number;
  readonly expectedInvocationCount: number;
  readonly model: {
    readonly provider: "deepseek";
    readonly modelId: "deepseek-v4-flash";
    readonly api: "openai-completions";
    readonly thinkingLevel: "high";
    readonly temperature: 0;
    readonly maxTokens: 256;
    readonly timeoutMs: 120_000;
    readonly maxRetries: 0;
  };
  readonly report: {
    readonly file: "2026-08-20-selection-memory-context-calibration.json";
    readonly rawPromptsStored: false;
    readonly rawResponsesStored: false;
    readonly queriesStored: false;
  };
  readonly configHash: string;
}

const configWithoutHash: Omit<SelectionMemoryCalibrationConfig, "configHash"> = Object.freeze({
  schemaVersion: 1,
  protocol: "selection-memory-context-calibration-v1",
  freezeHash: SELECTION_MEMORY_FREEZE_HASH,
  parentCatalogHash: SELECTION_MEMORY_CATALOG_HASH,
  experimentCatalogHash: SELECTION_MEMORY_EXPERIMENT_CATALOG_HASH,
  catalogContentHash: SELECTION_MEMORY_CALIBRATION_CATALOG_CONTENT_HASH,
  evidenceHash: computeSelectionMemoryEvidenceHash(),
  calibrationCaseHash: computeSelectionMemoryCaseSetHash(SELECTION_MEMORY_CALIBRATION_CASES),
  calibrationGoldSetHash: computeGoldSetHash(
    SELECTION_MEMORY_CALIBRATION_CATALOG_CONTENT_HASH,
    SELECTION_MEMORY_CALIBRATION_CASES,
  ),
  queryExpansionRulesHash: hashQueryExpansionRules(),
  promptVersion: SELECTION_MEMORY_PROMPT_VERSION,
  runnerVersion: SELECTION_MEMORY_RUNNER_VERSION,
  systemPromptHash: sha256(SELECTION_MEMORY_CALIBRATION_SYSTEM_PROMPT),
  candidateScope: "user",
  memoryLimits: Object.freeze({
    entriesPerSection: DEFAULT_MAX_MEMORY_ENTRIES_PER_SECTION,
    cardChars: DEFAULT_MAX_MEMORY_CARD_CHARS,
    totalChars: DEFAULT_MAX_MEMORY_TOTAL_CHARS,
  }),
  layers: Object.freeze(["selection_isolated", "retrieval_controlled"] as const),
  arms: SELECTION_MEMORY_ARMS,
  topK: 5,
  repeatCount: 3,
  expectedInvocationCount: SELECTION_MEMORY_CALIBRATION_CASES.length * 2 * SELECTION_MEMORY_ARMS.length * 3,
  model: Object.freeze({
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    api: "openai-completions",
    thinkingLevel: "high",
    temperature: 0,
    maxTokens: 256,
    timeoutMs: 120_000,
    maxRetries: 0,
  }),
  report: Object.freeze({
    file: "2026-08-20-selection-memory-context-calibration.json",
    rawPromptsStored: false,
    rawResponsesStored: false,
    queriesStored: false,
  }),
});

export const SELECTION_MEMORY_CALIBRATION_CONFIG: SelectionMemoryCalibrationConfig = Object.freeze({
  ...configWithoutHash,
  configHash: hashCanonical(configWithoutHash),
});

export function computeSelectionMemoryCalibrationConfigHash(
  config: SelectionMemoryCalibrationConfig | Omit<SelectionMemoryCalibrationConfig, "configHash">,
): string {
  const { configHash: _ignored, ...semantic } = config as SelectionMemoryCalibrationConfig;
  return hashCanonical(semantic);
}

/** Reconstructs an evaluation-only catalog without reading installed Skill packages. */
export function buildFrozenCalibrationCatalog(snapshot: SelectionCatalogSnapshot): readonly SkillRecord[] {
  if (snapshot.schemaVersion !== 1 || snapshot.catalogHash !== SELECTION_MEMORY_CATALOG_HASH) {
    throw new Error("selection_memory_parent_catalog_mismatch");
  }
  const byId = new Map(snapshot.entries.map((entry) => [entry.skillId, entry]));
  if (byId.size !== snapshot.entries.length) throw new Error("selection_memory_snapshot_ids_not_unique");
  const missing = SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error("selection_memory_experiment_catalog_member_missing");

  return Object.freeze(SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS.map((skillId) => {
    const entry = byId.get(skillId)!;
    return Object.freeze({
      schemaVersion: 1 as const,
      skillId: entry.skillId,
      skillRevision: entry.skillRevision,
      name: entry.name,
      description: entry.description,
      scope: "user" as const,
      sourceLocator: `evaluation:snapshot:${entry.skillId}`,
      sourceHash: sha256(entry.description),
      disableModelInvocation: false,
      declaredAliases: [],
      declaredEffects: [],
      declaredPermissions: [],
      dependencyManifest: [],
      discoveredAt: "2000-01-01T00:00:00.000Z",
    });
  }));
}

function hashQueryExpansionRules(): string {
  return hashCanonical(DEFAULT_QUERY_EXPANSION_RULES.map((rule) => ({
    id: rule.id,
    patternSource: rule.pattern.source,
    patternFlags: rule.pattern.flags,
    addedTerms: [...rule.addedTerms],
  })));
}

function hashCanonical(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
