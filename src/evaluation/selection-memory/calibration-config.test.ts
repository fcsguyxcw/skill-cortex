import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { computeCatalogHash, computeGoldSetHash } from "../selection/paired.ts";
import {
  SELECTION_MEMORY_CALIBRATION_CONFIG,
  buildFrozenCalibrationCatalog,
  computeSelectionMemoryCalibrationConfigHash,
  type SelectionCatalogSnapshot,
} from "./calibration-config.ts";
import { SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS, SELECTION_MEMORY_FREEZE_HASH } from "./catalog.ts";
import { SELECTION_MEMORY_CALIBRATION_CASES } from "./calibration-cases.ts";
import { computeSelectionMemoryCaseSetHash, computeSelectionMemoryEvidenceHash } from "./evidence-cases.ts";

const EXPECTED_CALIBRATION_CONFIG_HASH =
  "sha256:25cbdea78cf416bb2c3591e6531b37c81917826a8334cd369a5c685930b41972";

describe("selection Memory-as-Context frozen calibration config", () => {
  it("reconstructs exactly the controlled 19-Skill catalog from the frozen parent snapshot", () => {
    const snapshot = JSON.parse(readFileSync(
      "docs/evaluation/2026-08-20-selection-catalog-snapshot.json",
      "utf8",
    )) as SelectionCatalogSnapshot;
    const catalog = buildFrozenCalibrationCatalog(snapshot);
    assert.equal(catalog.length, 19);
    assert.deepEqual(catalog.map((item) => item.skillId).sort(), [...SELECTION_MEMORY_EXPERIMENT_CATALOG_SKILL_IDS]);
    assert.equal(computeCatalogHash(catalog), SELECTION_MEMORY_CALIBRATION_CONFIG.catalogContentHash);
    assert.ok(catalog.every((item) => item.scope === "user"));
  });

  it("binds every semantic input before a billable call", () => {
    const config = SELECTION_MEMORY_CALIBRATION_CONFIG;
    assert.equal(config.freezeHash, SELECTION_MEMORY_FREEZE_HASH);
    assert.equal(config.evidenceHash, computeSelectionMemoryEvidenceHash());
    assert.equal(config.calibrationCaseHash, computeSelectionMemoryCaseSetHash(SELECTION_MEMORY_CALIBRATION_CASES));
    assert.equal(config.calibrationGoldSetHash, computeGoldSetHash(config.catalogContentHash, SELECTION_MEMORY_CALIBRATION_CASES));
    assert.equal(config.repeatCount, 3);
    assert.equal(config.topK, 5);
    assert.deepEqual(config.layers, ["selection_isolated", "retrieval_controlled"]);
    assert.deepEqual(config.arms, ["description_only", "positive_memory", "structured_memory"]);
    assert.equal(config.expectedInvocationCount, 540);
    assert.equal(config.model.provider, "deepseek");
    assert.equal(config.model.modelId, "deepseek-v4-flash");
    assert.equal(config.model.api, "openai-completions");
    assert.equal(config.configHash, computeSelectionMemoryCalibrationConfigHash(config));
  });

  it("has a hard-coded config identity and changes when a frozen field changes", () => {
    assert.equal(SELECTION_MEMORY_CALIBRATION_CONFIG.configHash, EXPECTED_CALIBRATION_CONFIG_HASH);
    const changed = {
      ...SELECTION_MEMORY_CALIBRATION_CONFIG,
      topK: 4,
    };
    assert.notEqual(
      computeSelectionMemoryCalibrationConfigHash(changed),
      SELECTION_MEMORY_CALIBRATION_CONFIG.configHash,
    );
  });
});
