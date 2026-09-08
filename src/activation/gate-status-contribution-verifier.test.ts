import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import type { SkillRecord } from "../core/contracts/index.ts";
import { createGateStatusContributionVerifiers, parseGateStatusRegistry } from "./gate-status-contribution-verifier.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const RECORD: SkillRecord = {
  schemaVersion: 1,
  skillId: `skill:${"1".repeat(64)}`,
  skillRevision: `rev:${"2".repeat(64)}`,
  sourceHash: `sha256:${"3".repeat(64)}`,
  name: "skill-cortex-gate-status",
  description: "Report gates.",
  sourceLocator: path.join(ROOT, "skills", "skill-cortex-gate-status"),
  scope: "project",
  disableModelInvocation: false,
  declaredAliases: [],
  declaredEffects: [],
  declaredPermissions: [],
  dependencyManifest: [],
  discoveredAt: "2026-09-07T00:00:00.000Z",
};
const VALID = {
  schemaVersion: 1 as const,
  gates: [
    { gateId: "G1", status: "pass_bounded_domain" },
    { gateId: "G2", status: "offline_pass_shadow_only" },
    { gateId: "G3", status: "closed_keep_k5_full" },
    { gateId: "G4", status: "pass_project_local_host" },
    { gateId: "G5", status: "pass_project_local_host" },
    { gateId: "G6", status: "pass_evaluation_host" },
    { gateId: "G7", status: "blocked" },
  ],
};

describe("gate-status contribution verifier", () => {
  it("accepts only the exact ordered schema", () => {
    assert.deepEqual(parseGateStatusRegistry(VALID), VALID);
    assert.equal(parseGateStatusRegistry({ ...VALID, extra: true }), undefined);
    assert.equal(parseGateStatusRegistry({ ...VALID, gates: [...VALID.gates].reverse() }), undefined);
    assert.equal(parseGateStatusRegistry({ ...VALID, gates: VALID.gates.slice(0, 6) }), undefined);
  });

  it("re-reads authoritative state and rejects wrong, malformed, or drifted output", async (t) => {
    const root = await mkdtemp(path.join(ROOT, ".tmp-gate-status-verifier-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "config"), { recursive: true });
    await writeFile(path.join(root, "config", "activation-memory-gates.json"), JSON.stringify(VALID));
    const verifier = createGateStatusContributionVerifiers(root, [RECORD])[0]!;
    const event = {} as Parameters<typeof verifier.verify>[0];
    const evidence = (finalAssistantText: string) => ({ userPrompt: "status", finalAssistantText });
    assert.equal(await verifier.verify(event, evidence(JSON.stringify(VALID))), "verified_contribution");
    assert.equal(await verifier.verify(event, evidence('{"schemaVersion":1,"gates":[]}')), "unverified");
    await writeFile(path.join(root, "config", "activation-memory-gates.json"), "{}");
    assert.equal(await verifier.verify(event, evidence(JSON.stringify(VALID))), "unverified");
  });

  it("ambiguous or missing named parent produces no registration", () => {
    assert.deepEqual(createGateStatusContributionVerifiers(ROOT, []), []);
    assert.deepEqual(createGateStatusContributionVerifiers(ROOT, [RECORD, RECORD]), []);
  });
});
