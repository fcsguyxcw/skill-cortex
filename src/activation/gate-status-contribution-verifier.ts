import { readFile } from "node:fs/promises";
import path from "node:path";

import type { EvidenceHook } from "../adapters/pi/practice-observer.ts";
import type { SkillRecord } from "../core/contracts/index.ts";
import type { PositiveContributionVerifier } from "./contribution-verifier.ts";

export const GATE_STATUS_SKILL_NAME = "skill-cortex-gate-status";
export const GATE_STATUS_OPERATION_CLASS = "read-gate-status-registry";
export const GATE_STATUS_PRACTICE_VERIFIER_ID = "gate-status-registry-read";
export const GATE_STATUS_CONTRIBUTION_VERIFIER_ID = "gate-status-exact-output";

const STATUSES = new Set([
  "blocked",
  "closed_keep_k5_full",
  "offline_pass_shadow_only",
  "pass_bounded_domain",
  "pass_project_local_host",
  "pass_evaluation_host",
]);

export interface GateStatusRegistry {
  schemaVersion: 1;
  gates: Array<{ gateId: string; status: string }>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function parseGateStatusRegistry(value: unknown): GateStatusRegistry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  if (!exactKeys(root, ["schemaVersion", "gates"]) || root.schemaVersion !== 1 || !Array.isArray(root.gates)) {
    return undefined;
  }
  if (root.gates.length !== 7) return undefined;
  const gates: GateStatusRegistry["gates"] = [];
  for (let index = 0; index < root.gates.length; index += 1) {
    const item = root.gates[index];
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const gate = item as Record<string, unknown>;
    const expectedId = `G${index + 1}`;
    if (
      !exactKeys(gate, ["gateId", "status"])
      || gate.gateId !== expectedId
      || typeof gate.status !== "string"
      || !STATUSES.has(gate.status)
    ) return undefined;
    gates.push({ gateId: gate.gateId, status: gate.status });
  }
  return { schemaVersion: 1, gates };
}

async function readRegistry(projectRoot: string): Promise<GateStatusRegistry | undefined> {
  try {
    const filePath = path.join(path.resolve(projectRoot), "config", "activation-memory-gates.json");
    return parseGateStatusRegistry(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

export function createGateStatusEvidenceHook(catalogRecords: () => readonly SkillRecord[]): EvidenceHook {
  return {
    async collect(run, selection) {
      const parent = catalogRecords().find((record) => record.name === GATE_STATUS_SKILL_NAME);
      if (
        parent === undefined
        || selection.skillId !== parent.skillId
        || selection.skillRevision !== parent.skillRevision
        || selection.sourceHash !== parent.sourceHash
        || !run.steps.some((step) => step.toolName === "read" && step.outcome === "ok")
      ) return undefined;
      return {
        steps: [{ actor: "agent", operationClass: GATE_STATUS_OPERATION_CLASS, outcome: "ok" }],
        verifierResults: [{
          verifierId: GATE_STATUS_PRACTICE_VERIFIER_ID,
          result: "pass",
          observedEffect: "gate-status-registry-read",
        }],
      };
    },
  };
}

export function createGateStatusContributionVerifiers(
  projectRoot: string,
  catalogRecords: readonly SkillRecord[],
): readonly PositiveContributionVerifier[] {
  const matches = catalogRecords.filter((record) => record.name === GATE_STATUS_SKILL_NAME);
  if (matches.length !== 1) return [];
  const parent = matches[0]!;
  return [{
    verifierId: GATE_STATUS_CONTRIBUTION_VERIFIER_ID,
    parentSkillId: parent.skillId,
    parentSkillRevision: parent.skillRevision,
    sourceHash: parent.sourceHash,
    requiredOperationClass: GATE_STATUS_OPERATION_CLASS,
    requiredPracticeVerifierId: GATE_STATUS_PRACTICE_VERIFIER_ID,
    async verify(_event, evidence) {
      const expected = await readRegistry(projectRoot);
      if (expected === undefined) return "unverified";
      try {
        const actual = parseGateStatusRegistry(JSON.parse(evidence.finalAssistantText));
        return actual !== undefined && JSON.stringify(actual) === JSON.stringify(expected)
          ? "verified_contribution"
          : "unverified";
      } catch {
        return "unverified";
      }
    },
  }];
}
