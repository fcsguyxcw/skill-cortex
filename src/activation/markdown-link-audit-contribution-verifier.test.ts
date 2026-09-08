import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import type { SkillRecord } from "../core/contracts/index.ts";
import {
  createMarkdownLinkAuditContributionVerifiers,
  createMarkdownLinkAuditEvidenceHook,
  MARKDOWN_LINK_AUDIT_OPERATION_CLASS,
  MARKDOWN_LINK_AUDIT_PRACTICE_VERIFIER_ID,
  parseMarkdownLinkAuditResult,
  scanMarkdownRelativeLinks,
} from "./markdown-link-audit-contribution-verifier.ts";
import type { AttributableSelection, RunCollector } from "../adapters/pi/practice-observer.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const RECORD: SkillRecord = {
  schemaVersion: 1,
  skillId: `skill:${"4".repeat(64)}`,
  skillRevision: `rev:${"5".repeat(64)}`,
  sourceHash: `sha256:${"6".repeat(64)}`,
  name: "markdown-relative-link-audit",
  description: "Audit project Markdown relative links.",
  sourceLocator: path.join(ROOT, "skills", "markdown-relative-link-audit"),
  scope: "project",
  disableModelInvocation: false,
  declaredAliases: [],
  declaredEffects: [],
  declaredPermissions: [],
  dependencyManifest: [],
  discoveredAt: "2026-09-08T00:00:00.000Z",
};

describe("Markdown relative-link audit", () => {
  it("scans only project Markdown files and reports broken local targets deterministically", async (t) => {
    const root = await mkdtemp(path.join(ROOT, ".tmp-markdown-link-audit-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "asset.txt"), "ok");
    await writeFile(
      path.join(root, "README.md"),
      [
        "[good](docs/good.md)",
        "[missing](docs/missing.md)",
        "[web](https://example.com)",
        "[anchor](#section)",
        "```md",
        "[example only](docs/not-real.md)",
        "```",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "docs", "good.md"),
      "[asset](../asset.txt)\n[outside](../../outside.md)\n",
    );

    assert.deepEqual(await scanMarkdownRelativeLinks(root), {
      schemaVersion: 1,
      scope: "project-markdown",
      scannedFiles: ["README.md", "docs/good.md"],
      brokenLinks: [
        { source: "README.md", target: "docs/missing.md" },
        { source: "docs/good.md", target: "../../outside.md" },
      ],
    });
  });

  it("deduplicates repeated broken links and fails closed when the bounded docs scope cannot be enumerated", async (t) => {
    const duplicateRoot = await mkdtemp(path.join(ROOT, ".tmp-markdown-link-duplicate-"));
    const unreadableRoot = await mkdtemp(path.join(ROOT, ".tmp-markdown-link-unreadable-"));
    t.after(() => Promise.all([
      rm(duplicateRoot, { recursive: true, force: true }),
      rm(unreadableRoot, { recursive: true, force: true }),
    ]));
    await writeFile(path.join(duplicateRoot, "README.md"), "[one](missing.md)\n[two](missing.md)\n");
    assert.deepEqual((await scanMarkdownRelativeLinks(duplicateRoot)).brokenLinks, [
      { source: "README.md", target: "missing.md" },
    ]);

    await writeFile(path.join(unreadableRoot, "README.md"), "# Readme\n");
    await writeFile(path.join(unreadableRoot, "docs"), "not a directory\n");
    await assert.rejects(() => scanMarkdownRelativeLinks(unreadableRoot));

    await rm(path.join(unreadableRoot, "docs"));
    await writeFile(path.join(unreadableRoot, "README.md"), "[invalid target](%00)\n");
    await assert.rejects(() => scanMarkdownRelativeLinks(unreadableRoot));
  });

  it("accepts only the exact safe and deterministically ordered result schema", () => {
    const valid = {
      schemaVersion: 1,
      scope: "project-markdown",
      scannedFiles: ["README.md", "docs/guide.md"],
      brokenLinks: [{ source: "README.md", target: "docs/missing.md" }],
    };
    assert.deepEqual(parseMarkdownLinkAuditResult(valid), valid);
    assert.equal(parseMarkdownLinkAuditResult({ ...valid, extra: true }), undefined);
    assert.equal(parseMarkdownLinkAuditResult({ ...valid, scannedFiles: [...valid.scannedFiles].reverse() }), undefined);
    assert.equal(parseMarkdownLinkAuditResult({ ...valid, scannedFiles: ["C:\\secret.md"] }), undefined);
    assert.equal(parseMarkdownLinkAuditResult({ ...valid, brokenLinks: [{ source: "../outside.md", target: "x.md" }] }), undefined);

    const codePointOrdered = {
      ...valid,
      scannedFiles: ["README.md", "docs/\uE000.md", "docs/𐀀.md"],
    };
    assert.deepEqual(parseMarkdownLinkAuditResult(codePointOrdered), codePointOrdered);
    assert.equal(parseMarkdownLinkAuditResult({
      ...codePointOrdered,
      scannedFiles: ["README.md", "docs/𐀀.md", "docs/\uE000.md"],
    }), undefined);
  });

  it("re-scans authoritative files and rejects fenced, wrong, or drifted output", async (t) => {
    const root = await mkdtemp(path.join(ROOT, ".tmp-markdown-link-verifier-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "README.md"), "[missing](missing.md)\n");
    const expected = await scanMarkdownRelativeLinks(root);
    const verifier = createMarkdownLinkAuditContributionVerifiers(root, [RECORD])[0]!;
    const event = {} as Parameters<typeof verifier.verify>[0];
    const evidence = (finalAssistantText: string) => ({ userPrompt: "audit links", finalAssistantText });

    assert.equal(await verifier.verify(event, evidence(JSON.stringify(expected))), "verified_contribution");
    assert.equal(await verifier.verify(event, evidence(`\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``)), "unverified");
    assert.equal(await verifier.verify(event, evidence('{"schemaVersion":1}')), "unverified");
    await writeFile(path.join(root, "missing.md"), "now valid\n");
    assert.equal(await verifier.verify(event, evidence(JSON.stringify(expected))), "unverified");
  });

  it("does not register a verifier for a missing or ambiguous parent Skill", () => {
    assert.deepEqual(createMarkdownLinkAuditContributionVerifiers(ROOT, []), []);
    assert.deepEqual(createMarkdownLinkAuditContributionVerifiers(ROOT, [RECORD, RECORD]), []);
  });

  it("emits Practice evidence only when successful project-local reads cover every scanned Markdown source", async (t) => {
    const root = await mkdtemp(path.join(ROOT, ".tmp-markdown-link-evidence-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "[guide](docs/guide.md)\n");
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n");
    const hook = createMarkdownLinkAuditEvidenceHook(root, () => [RECORD]);
    const selection: AttributableSelection = {
      skillId: RECORD.skillId,
      skillRevision: RECORD.skillRevision,
      sourceHash: RECORD.sourceHash,
    };
    const run = { steps: [
      { stepId: "step-1", toolName: "read", outcome: "ok", relativeReadPath: "README.md" },
      { stepId: "step-2", toolName: "read", outcome: "ok", relativeReadPath: "docs/guide.md" },
    ] } as RunCollector;
    assert.deepEqual(await hook.collect(run, selection), {
      steps: [{ actor: "agent", operationClass: MARKDOWN_LINK_AUDIT_OPERATION_CLASS, outcome: "ok" }],
      verifierResults: [{
        verifierId: MARKDOWN_LINK_AUDIT_PRACTICE_VERIFIER_ID,
        result: "pass",
        observedEffect: "project-markdown-links-audited",
      }],
    });
    assert.equal(await hook.collect({ steps: [run.steps[0]] } as unknown as RunCollector, selection), undefined);
    assert.equal(await hook.collect({ steps: [
      ...run.steps,
      { stepId: "step-3", toolName: "read", outcome: "ok" },
    ] } as RunCollector, selection), undefined);
    assert.equal(await hook.collect(run, { ...selection, sourceHash: `sha256:${"7".repeat(64)}` }), undefined);
  });
});
