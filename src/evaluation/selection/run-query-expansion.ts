import { readFile } from "node:fs/promises";

import type { SkillRecord } from "../../core/contracts/index.ts";
import { QUERY_EXPANSION_EVAL_CASES } from "./query-expansion-cases.ts";
import { runQueryExpansionAblation } from "./query-expansion-evaluation.ts";

const snapshot = JSON.parse(
  await readFile("docs/evaluation/2026-08-20-selection-catalog-snapshot.json", "utf8"),
) as { entries: Array<Pick<SkillRecord, "skillId" | "skillRevision" | "name" | "description">> };
const catalog: SkillRecord[] = snapshot.entries.map((item) => ({
  ...item,
  schemaVersion: 1,
  scope: "user",
  sourceLocator: "fixture://catalog-snapshot",
  sourceHash: `sha256:${"0".repeat(64)}`,
  disableModelInvocation: false,
  declaredAliases: [],
  declaredEffects: [],
  declaredPermissions: [],
  dependencyManifest: [],
  discoveredAt: "2026-08-20T00:00:00.000Z",
}));

console.log(JSON.stringify(runQueryExpansionAblation({
  catalog,
  cases: QUERY_EXPANSION_EVAL_CASES,
  topK: 5,
}), null, 2));
