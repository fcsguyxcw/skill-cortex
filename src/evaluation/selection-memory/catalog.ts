import { createHash } from "node:crypto";

import { SELECTION_MEMORY_CALIBRATION_CASES } from "./calibration-cases.ts";
import {
  SELECTION_MEMORY_CATALOG_HASH,
  computeSelectionMemoryCaseSetHash,
  computeSelectionMemoryEvidenceHash,
} from "./evidence-cases.ts";
import { SELECTION_MEMORY_HELDOUT_CASES } from "./heldout-cases.ts";

/**
 * Controlled experiment catalog: the union of every frozen candidate bundle.
 * The parent hash binds descriptions/revisions; this hash also binds membership.
 */
export const SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS: readonly string[] = Object.freeze(
  [...new Set([...SELECTION_MEMORY_CALIBRATION_CASES, ...SELECTION_MEMORY_HELDOUT_CASES]
    .flatMap((item) => item.candidateSkillIds))].sort(),
);

export const SELECTION_MEMORY_EXPERIMENT_CATALOG_HASH = `sha256:${createHash("sha256")
  .update(JSON.stringify({
    parentCatalogHash: SELECTION_MEMORY_CATALOG_HASH,
    skillIds: SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS,
  }), "utf8")
  .digest("hex")}`;

/** Final semantic identity. Confirmation metadata is recorded separately in the Gold document. */
export const SELECTION_MEMORY_FREEZE_HASH = `sha256:${createHash("sha256")
  .update(JSON.stringify({
    schemaVersion: 1,
    protocol: "selection-memory-context-v1",
    parentCatalogHash: SELECTION_MEMORY_CATALOG_HASH,
    experimentCatalogHash: SELECTION_MEMORY_EXPERIMENT_CATALOG_HASH,
    evidenceHash: computeSelectionMemoryEvidenceHash(),
    calibrationHash: computeSelectionMemoryCaseSetHash(SELECTION_MEMORY_CALIBRATION_CASES),
    heldoutHash: computeSelectionMemoryCaseSetHash(SELECTION_MEMORY_HELDOUT_CASES),
    combinedCaseSetHash: computeSelectionMemoryCaseSetHash([
      ...SELECTION_MEMORY_CALIBRATION_CASES,
      ...SELECTION_MEMORY_HELDOUT_CASES,
    ]),
  }), "utf8")
  .digest("hex")}`;
