import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { computeEvaluationRunConfigHash } from "./run-config.ts";
import {
  FINAL_EVALUATION_RUN_CONFIG,
  FINAL_SELECTION_SYSTEM_PROMPT,
  FROZEN_CATALOG_SNAPSHOT_ENTRIES_HASH,
  FROZEN_FINAL_EVALUATION_RUN_CONFIG_HASH,
} from "./final-run-config.ts";

const SNAPSHOT_PATH = path.join(
  process.cwd(),
  "docs",
  "evaluation",
  "2026-08-20-selection-catalog-snapshot.json",
);
const PAIRED_PATH = path.join(process.cwd(), "src", "evaluation", "selection", "paired.ts");

describe("frozen final Selection run config", () => {
  it("matches the frozen catalog snapshot and its own config hash", async () => {
    const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as {
      snapshotEntriesHash: string;
    };
    assert.equal(snapshot.snapshotEntriesHash, FROZEN_CATALOG_SNAPSHOT_ENTRIES_HASH);
    assert.equal(
      computeEvaluationRunConfigHash(FINAL_EVALUATION_RUN_CONFIG),
      FROZEN_FINAL_EVALUATION_RUN_CONFIG_HASH,
    );
  });

  it("binds the exact paired prompt implementation source", async () => {
    const pairedSource = await readFile(PAIRED_PATH, "utf8");
    const pairedSourceHash = `sha256:${createHash("sha256").update(pairedSource, "utf8").digest("hex")}`;
    assert.equal(
      pairedSourceHash,
      "sha256:6ecf652df6eb042bc82c26c34d627f1e749355a6274494a474093347ca705482",
    );
    const selectionPromptHash = `sha256:${createHash("sha256")
      .update(`${FINAL_SELECTION_SYSTEM_PROMPT}\n${pairedSourceHash}`, "utf8")
      .digest("hex")}`;
    assert.equal(selectionPromptHash, FINAL_EVALUATION_RUN_CONFIG.selectionPromptHash);
  });
});
