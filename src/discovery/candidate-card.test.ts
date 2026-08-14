import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatCandidateCards } from "./candidate-card.ts";
import type { SkillCandidate } from "../core/contracts/index.ts";

function candidate(skillId: string, name: string, description: string): SkillCandidate {
  return {
    skillId,
    skillRevision: `rev:${skillId}`,
    name,
    description,
    scope: "user",
    retrievalScore: 1,
    evidence: [{ kind: "declared_text", field: "name" }],
  };
}

describe("formatCandidateCards", () => {
  it("renders an explicit empty marker for no candidates", () => {
    assert.equal(formatCandidateCards([]), "(no matching skills)");
  });

  it("renders skillId, name, scope, revision and full description for each candidate", () => {
    const text = formatCandidateCards([
      candidate("a", "pdf", "Read PDF documents"),
      candidate("b", "docx", "Create word documents"),
    ]);
    assert.match(text, /## Available skill candidates/);
    assert.match(text, /1\. pdf \[skillId=a, scope=user, revision=rev:a\]/);
    assert.match(text, /Read PDF documents/);
    assert.match(text, /2\. docx \[skillId=b, scope=user, revision=rev:b\]/);
    assert.match(text, /Create word documents/);
  });

  it("is deterministic", () => {
    const input = [candidate("a", "pdf", "Read PDF documents")];
    assert.equal(formatCandidateCards(input), formatCandidateCards([...input]));
  });
});
