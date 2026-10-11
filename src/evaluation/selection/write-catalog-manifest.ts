import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { createDiscoveryServices } from "../../adapters/pi/core.ts";
import { computeCatalogHash } from "./paired.ts";
import { EXPECTED_CATALOG_HASH } from "./dev-cases.ts";

const OUTPUT_FILE = "2026-08-20-selection-catalog-manifest.json";

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const loader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir: getAgentDir(),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const visibleSkills = loader
    .getSkills()
    .skills.filter((skill) => skill.disableModelInvocation !== true);
  const discovery = createDiscoveryServices({ topK: 5 });
  const ingest = await discovery.run("", visibleSkills);
  if (!ingest.ok || discovery.state.catalog === undefined) {
    throw new Error("catalog_manifest_ingest_failed");
  }
  const catalog = [...discovery.state.catalog.values()].map(({ record }) => record);
  const catalogHash = computeCatalogHash(catalog);
  if (catalogHash !== EXPECTED_CATALOG_HASH) {
    throw new Error(`catalog_manifest_hash_mismatch:${catalogHash}`);
  }
  const entries = catalog
    .map((record) => ({
      skillId: record.skillId,
      name: record.name,
      skillRevision: record.skillRevision,
      descriptionHash: sha256(record.description),
    }))
    .sort((left, right) => left.skillId.localeCompare(right.skillId));
  const manifestEntriesHash = sha256(JSON.stringify(entries));
  const manifest = {
    schemaVersion: 1,
    catalogHash,
    manifestEntriesHash,
    loader: {
      package: "@earendil-works/pi-coding-agent",
      version: "0.84.1",
      discoveredCount: loader.getSkills().skills.length,
      visibleRecordCount: entries.length,
      excludesDisableModelInvocation: true,
    },
    privacy: {
      sourcePathsStored: false,
      descriptionsStored: false,
    },
    entries,
  };
  const outputDir = path.join(projectRoot, "docs", "evaluation");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, OUTPUT_FILE);
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(JSON.stringify({
    output: path.relative(projectRoot, outputPath).replaceAll("\\", "/"),
    catalogHash,
    manifestEntriesHash,
    recordCount: entries.length,
  }));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

await main();
