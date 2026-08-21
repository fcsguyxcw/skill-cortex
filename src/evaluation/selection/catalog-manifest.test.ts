import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { EXPECTED_CATALOG_HASH } from "./dev-cases.ts";

const MANIFEST_PATH = path.join(
  process.cwd(),
  "docs",
  "evaluation",
  "2026-08-20-selection-catalog-manifest.json",
);
const SNAPSHOT_PATH = path.join(
  process.cwd(),
  "docs",
  "evaluation",
  "2026-08-20-selection-catalog-snapshot.json",
);

interface ManifestEntry {
  skillId: string;
  name: string;
  skillRevision: string;
  descriptionHash: string;
}

interface CatalogManifest {
  schemaVersion: number;
  catalogHash: string;
  manifestEntriesHash: string;
  loader: { visibleRecordCount: number };
  privacy: { sourcePathsStored: boolean; descriptionsStored: boolean };
  entries: ManifestEntry[];
}

interface CatalogSnapshot {
  schemaVersion: number;
  catalogHash: string;
  snapshotEntriesHash: string;
  loader: { visibleRecordCount: number };
  privacy: {
    sourcePathsStored: boolean;
    skillBodiesStored: boolean;
    descriptionsStored: boolean;
  };
  entries: Array<{
    skillId: string;
    name: string;
    skillRevision: string;
    description: string;
  }>;
}

describe("selection catalog manifest", () => {
  it("binds the 132-entry catalog without storing descriptions or paths", async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as CatalogManifest;
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.catalogHash, EXPECTED_CATALOG_HASH);
    assert.equal(manifest.loader.visibleRecordCount, 132);
    assert.equal(manifest.entries.length, 132);
    assert.deepEqual(manifest.privacy, {
      sourcePathsStored: false,
      descriptionsStored: false,
    });
    assert.equal(new Set(manifest.entries.map((entry) => entry.skillId)).size, 132);
    for (const entry of manifest.entries) {
      assert.deepEqual(Object.keys(entry), ["skillId", "name", "skillRevision", "descriptionHash"]);
      assert.match(entry.skillId, /^skill:[0-9a-f]{64}$/);
      assert.match(entry.skillRevision, /^rev:[0-9a-f]{64}$/);
      assert.match(entry.descriptionHash, /^sha256:[0-9a-f]{64}$/);
    }
    assert.equal(
      manifest.manifestEntriesHash,
      `sha256:${createHash("sha256").update(JSON.stringify(manifest.entries), "utf8").digest("hex")}`,
    );
  });

  it("stores a path-free reproducible description snapshot matching the integrity manifest", async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as CatalogManifest;
    const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as CatalogSnapshot;
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.catalogHash, EXPECTED_CATALOG_HASH);
    assert.equal(snapshot.loader.visibleRecordCount, 132);
    assert.equal(snapshot.entries.length, 132);
    assert.deepEqual(snapshot.privacy, {
      sourcePathsStored: false,
      skillBodiesStored: false,
      descriptionsStored: true,
    });
    assert.equal(
      snapshot.snapshotEntriesHash,
      `sha256:${createHash("sha256").update(JSON.stringify(snapshot.entries), "utf8").digest("hex")}`,
    );
    assert.deepEqual(
      snapshot.entries.map((entry) => ({
        skillId: entry.skillId,
        name: entry.name,
        skillRevision: entry.skillRevision,
        descriptionHash: `sha256:${createHash("sha256").update(entry.description, "utf8").digest("hex")}`,
      })),
      manifest.entries,
    );
  });
});
