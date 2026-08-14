import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildIndex, DEFAULT_TOP_K, MAX_TOP_K } from "./bm25.ts";
import type { SkillRecord } from "../core/contracts/index.ts";

function mk(
  skillId: string,
  name: string,
  description: string,
  aliases: string[] = [],
): SkillRecord {
  return {
    schemaVersion: 1,
    skillId,
    skillRevision: `rev:${skillId}`,
    name,
    description,
    scope: "user",
    sourceLocator: `fixture://${skillId}`,
    sourceHash: "sha256:" + "0".repeat(64),
    disableModelInvocation: false,
    declaredAliases: aliases,
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2026-08-14T00:00:00.000Z",
  };
}

describe("bm25 discovery index", () => {
  it("returns empty for an empty query", () => {
    const index = buildIndex([mk("a", "pdf", "Read PDF documents")]);
    assert.deepEqual(index.search(""), []);
    assert.deepEqual(index.search("   "), []);
  });

  it("returns empty for a no-match query instead of the full catalog", () => {
    const index = buildIndex([mk("a", "pdf", "Read PDF documents")]);
    assert.deepEqual(index.search("zzzqqq no-such-term"), []);
  });

  it("returns full description, scope, revision, score and declared_text evidence", () => {
    const index = buildIndex([
      mk("a", "pdf", "Read PDF documents", ["PDF 处理"]),
      mk("b", "docx", "Create word documents"),
    ]);
    const results = index.search("pdf");
    assert.equal(results.length, 1);
    const candidate = results[0]!;
    assert.equal(candidate.skillId, "a");
    assert.equal(candidate.skillRevision, "rev:a");
    assert.equal(candidate.scope, "user");
    assert.equal(candidate.description, "Read PDF documents");
    assert.ok(candidate.retrievalScore > 0);

    const fields = candidate.evidence
      .filter((e) => e.kind === "declared_text")
      .map((e) => e.field);
    assert.deepEqual(fields, ["name", "description", "alias"]);
  });

  it("orders by score descending with skillId as stable tie-break", () => {
    const index = buildIndex([
      mk("zz", "tool", "A generic tool for tasks"),
      mk("aa", "tool", "A generic tool for tasks"),
    ]);
    const results = index.search("tool tasks", { limit: 10 });
    assert.deepEqual(
      results.map((r) => r.skillId),
      ["aa", "zz"],
    );
  });

  it("is bounded and never returns the full catalog", () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      mk(`s${i}`, `skill-${i}`, "shared unique term description"),
    );
    const index = buildIndex(records);

    const defaultResults = index.search("shared unique");
    assert.equal(defaultResults.length, DEFAULT_TOP_K);

    const unbounded = index.search("shared unique", { limit: 1000 });
    assert.equal(unbounded.length, MAX_TOP_K);
    assert.ok(unbounded.length < records.length);
  });

  it("clamps a small/negative limit to a single result", () => {
    const index = buildIndex([
      mk("a", "pdf", "Read PDF documents"),
      mk("b", "pdf-tools", "Create PDF documents"),
    ]);
    assert.equal(index.search("pdf", { limit: 0 }).length, 1);
    assert.equal(index.search("pdf", { limit: -3 }).length, 1);
  });

  it("applies the lexical relevance guard (name/alias or >=2 description terms)", () => {
    const index = buildIndex([
      mk("a", "docx", "Create word documents"),
      mk("b", "xlsx", "Recalculate formulas quickly"),
      mk("c", "pdf", "Read PDF documents", ["PDF 处理"]),
    ]);

    // A single common description term is below the guard.
    assert.deepEqual(index.search("create"), []);

    // Two distinct description terms pass the guard (name/alias not involved).
    assert.deepEqual(
      index.search("recalculate formulas").map((r) => r.skillId),
      ["b"],
    );

    // A single description term still fails without name/alias support.
    assert.deepEqual(index.search("recalculate").map((r) => r.skillId), []);

    // A single name term passes the guard.
    assert.deepEqual(index.search("docx").map((r) => r.skillId), ["a"]);

    // A single alias term passes the guard.
    assert.deepEqual(index.search("处理").map((r) => r.skillId), ["c"]);
  });

  it("reads only name/description/declaredAliases, ignoring effects/permissions/manifest", () => {
    const shared: Omit<SkillRecord, "skillId"> = {
      schemaVersion: 1,
      skillRevision: "rev:a",
      name: "pdf",
      description: "Read PDF documents",
      scope: "user",
      sourceLocator: "fixture://a",
      sourceHash: "sha256:" + "0".repeat(64),
      disableModelInvocation: false,
      declaredAliases: [],
      declaredEffects: [],
      declaredPermissions: [],
      dependencyManifest: [],
      discoveredAt: "2026-08-14T00:00:00.000Z",
    };

    const indexA = buildIndex([
      {
        ...shared,
        skillId: "a",
        declaredEffects: ["delete_files"],
        declaredPermissions: ["admin"],
        dependencyManifest: [{ locator: "x", contentHash: "y", role: "script" }],
        discoveredAt: "2020-01-01T00:00:00.000Z",
      },
    ]);
    const indexB = buildIndex([
      {
        ...shared,
        skillId: "a",
        declaredEffects: [],
        declaredPermissions: [],
        dependencyManifest: [],
        discoveredAt: "2030-01-01T00:00:00.000Z",
      },
    ]);

    assert.deepEqual(indexA.search("pdf"), indexB.search("pdf"));
  });

  it("is deterministic across rebuilds", () => {
    const records = [
      mk("a", "pdf", "Read PDF documents"),
      mk("b", "docx", "Create word documents"),
      mk("c", "xlsx", "Read Excel spreadsheets"),
    ];
    const indexA = buildIndex(records);
    const indexB = buildIndex([...records]);
    for (const query of ["pdf", "documents", "excel spreadsheets"]) {
      assert.deepEqual(indexA.search(query), indexB.search(query));
    }
  });
});
