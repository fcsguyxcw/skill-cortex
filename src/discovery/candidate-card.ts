/**
 * Pure candidate-card prompt formatting.
 *
 * Receives only the bounded Top-K candidates and emits a deterministic text
 * block. Each card carries `skillId`, `name`, `scope`, `revision`, and the full
 * author description (data contract §4.2 / ADR-0007 candidate-card fields). It
 * can never inject the full catalog because it is not given access to it.
 * No side effects, no LLM.
 */

import type { SkillCandidate } from "../core/contracts/index.ts";

export function formatCandidateCards(
  candidates: readonly SkillCandidate[],
): string {
  if (candidates.length === 0) {
    return "(no matching skills)";
  }

  const lines: string[] = [];
  candidates.forEach((candidate, index) => {
    lines.push(
      `${index + 1}. ${candidate.name} [skill_id=${candidate.skillId}, scope=${candidate.scope}, skill_revision=${candidate.skillRevision}]`,
    );
    lines.push(`   ${candidate.description}`);
  });

  return ["## Available skill candidates", "", ...lines].join("\n");
}
