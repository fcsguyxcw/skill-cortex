import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { EvidenceHook } from "../adapters/pi/practice-observer.ts";
import type { SkillRecord } from "../core/contracts/index.ts";
import type { PositiveContributionVerifier } from "./contribution-verifier.ts";

export const MARKDOWN_LINK_AUDIT_SKILL_NAME = "markdown-relative-link-audit";
export const MARKDOWN_LINK_AUDIT_OPERATION_CLASS = "audit-project-markdown-links";
export const MARKDOWN_LINK_AUDIT_PRACTICE_VERIFIER_ID = "markdown-link-scan-complete";
export const MARKDOWN_LINK_AUDIT_CONTRIBUTION_VERIFIER_ID = "markdown-link-audit-exact-output";

export interface MarkdownLinkAuditResult {
  schemaVersion: 1;
  scope: "project-markdown";
  scannedFiles: string[];
  brokenLinks: Array<{ source: string; target: string }>;
}

const MARKDOWN_LINK_RE = /!?\[[^\]\r\n]*\]\((<[^>\r\n]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/iu;

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function projectRelative(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).replaceAll("\\", "/");
}

function compareText(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index]! < rightPoints[index]!) return -1;
    if (leftPoints[index]! > rightPoints[index]!) return 1;
  }
  return leftPoints.length < rightPoints.length ? -1 : leftPoints.length > rightPoints.length ? 1 : 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function safeSource(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\\")) return false;
  if (value !== "README.md" && (!value.startsWith("docs/") || !value.toLowerCase().endsWith(".md"))) return false;
  return !path.posix.isAbsolute(value) && !value.split("/").includes("..");
}

function safeTarget(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.includes("\\")
    && !path.posix.isAbsolute(value)
    && !URI_SCHEME_RE.test(value);
}

export function parseMarkdownLinkAuditResult(value: unknown): MarkdownLinkAuditResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  if (
    !exactKeys(root, ["schemaVersion", "scope", "scannedFiles", "brokenLinks"])
    || root.schemaVersion !== 1
    || root.scope !== "project-markdown"
    || !Array.isArray(root.scannedFiles)
    || !Array.isArray(root.brokenLinks)
  ) return undefined;

  const scannedFiles = root.scannedFiles;
  if (!scannedFiles.every(safeSource)) return undefined;
  if (new Set(scannedFiles).size !== scannedFiles.length) return undefined;
  if (scannedFiles.some((item, index) => index > 0 && compareText(scannedFiles[index - 1]!, item) >= 0)) return undefined;

  const brokenLinks: MarkdownLinkAuditResult["brokenLinks"] = [];
  for (const item of root.brokenLinks) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const link = item as Record<string, unknown>;
    if (!exactKeys(link, ["source", "target"]) || !safeSource(link.source) || !safeTarget(link.target)) return undefined;
    if (!scannedFiles.includes(link.source)) return undefined;
    brokenLinks.push({ source: link.source, target: link.target });
  }
  for (let index = 1; index < brokenLinks.length; index += 1) {
    const prior = brokenLinks[index - 1]!;
    const current = brokenLinks[index]!;
    if (compareText(prior.source, current.source) > 0) return undefined;
    if (prior.source === current.source && compareText(prior.target, current.target) >= 0) return undefined;
  }
  return {
    schemaVersion: 1,
    scope: "project-markdown",
    scannedFiles: [...scannedFiles],
    brokenLinks,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function markdownFiles(projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  const readme = path.join(projectRoot, "README.md");
  try {
    await readFile(readme, "utf8");
    files.push(readme);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }

  const docsRoot = path.join(projectRoot, "docs");
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(entryPath);
    }
  }
  await visit(docsRoot);
  return files.sort((left, right) => compareText(projectRelative(projectRoot, left), projectRelative(projectRoot, right)));
}

function withoutCodeBlocks(markdown: string): string {
  const kept: string[] = [];
  let fence: "```" | "~~~" | undefined;
  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trimStart();
    if (fence === undefined && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      fence = trimmed.startsWith("```") ? "```" : "~~~";
      continue;
    }
    if (fence !== undefined) {
      if (trimmed.startsWith(fence)) fence = undefined;
      continue;
    }
    kept.push(line.replace(/`[^`\r\n]*`/gu, ""));
  }
  return kept.join("\n");
}

function localTarget(rawTarget: string): string | undefined {
  const unwrapped = rawTarget.startsWith("<") && rawTarget.endsWith(">")
    ? rawTarget.slice(1, -1)
    : rawTarget;
  if (
    unwrapped === "" ||
    unwrapped.startsWith("#") ||
    unwrapped.startsWith("/") ||
    unwrapped.startsWith("\\") ||
    URI_SCHEME_RE.test(unwrapped)
  ) return undefined;
  const withoutFragment = unwrapped.split("#", 1)[0]!.split("?", 1)[0]!;
  if (withoutFragment === "") return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    decoded = withoutFragment;
  }
  if (/[\u0000-\u001f\u007f]/u.test(decoded)) throw new Error("invalid_link_target");
  return decoded;
}

export async function scanMarkdownRelativeLinks(projectRoot: string): Promise<MarkdownLinkAuditResult> {
  const root = await realpath(path.resolve(projectRoot));
  const files = await markdownFiles(root);
  const brokenLinks: MarkdownLinkAuditResult["brokenLinks"] = [];
  const seenBrokenLinks = new Set<string>();

  for (const filePath of files) {
    const source = projectRelative(root, filePath);
    const markdown = withoutCodeBlocks(await readFile(filePath, "utf8"));
    for (const match of markdown.matchAll(MARKDOWN_LINK_RE)) {
      const target = localTarget(match[1]!);
      if (target === undefined) continue;
      const resolved = path.resolve(path.dirname(filePath), target);
      let valid = isWithin(root, resolved);
      if (valid) {
        try {
          valid = isWithin(root, await realpath(resolved));
        } catch (error) {
          if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) valid = false;
          else throw error;
        }
      }
      if (!valid) {
        const key = `${source}\u0000${target}`;
        if (!seenBrokenLinks.has(key)) {
          seenBrokenLinks.add(key);
          brokenLinks.push({ source, target });
        }
      }
    }
  }

  brokenLinks.sort((left, right) => compareText(left.source, right.source) || compareText(left.target, right.target));
  return {
    schemaVersion: 1,
    scope: "project-markdown",
    scannedFiles: files.map((filePath) => projectRelative(root, filePath)),
    brokenLinks,
  };
}

export function createMarkdownLinkAuditEvidenceHook(
  projectRoot: string,
  catalogRecords: () => readonly SkillRecord[],
): EvidenceHook {
  return {
    async collect(run, selection) {
      const matches = catalogRecords().filter((record) => record.name === MARKDOWN_LINK_AUDIT_SKILL_NAME);
      if (matches.length !== 1) return undefined;
      const parent = matches[0]!;
      const successfulReads = run.steps.filter((step) => step.toolName === "read" && step.outcome === "ok");
      if (
        selection.skillId !== parent.skillId
        || selection.skillRevision !== parent.skillRevision
        || selection.sourceHash !== parent.sourceHash
        || successfulReads.some((step) => step.relativeReadPath === undefined)
      ) return undefined;
      let expectedSources: readonly string[];
      try {
        expectedSources = (await scanMarkdownRelativeLinks(projectRoot)).scannedFiles;
      } catch {
        return undefined;
      }
      const readPaths = new Set(successfulReads.map((step) => step.relativeReadPath!));
      if (!expectedSources.every((source) => readPaths.has(source))) return undefined;
      return {
        steps: [{ actor: "agent", operationClass: MARKDOWN_LINK_AUDIT_OPERATION_CLASS, outcome: "ok" }],
        verifierResults: [{
          verifierId: MARKDOWN_LINK_AUDIT_PRACTICE_VERIFIER_ID,
          result: "pass",
          observedEffect: "project-markdown-links-audited",
        }],
      };
    },
  };
}

export function createMarkdownLinkAuditContributionVerifiers(
  projectRoot: string,
  catalogRecords: readonly SkillRecord[],
): readonly PositiveContributionVerifier[] {
  const matches = catalogRecords.filter((record) => record.name === MARKDOWN_LINK_AUDIT_SKILL_NAME);
  if (matches.length !== 1) return [];
  const parent = matches[0]!;
  return [{
    verifierId: MARKDOWN_LINK_AUDIT_CONTRIBUTION_VERIFIER_ID,
    parentSkillId: parent.skillId,
    parentSkillRevision: parent.skillRevision,
    sourceHash: parent.sourceHash,
    requiredOperationClass: MARKDOWN_LINK_AUDIT_OPERATION_CLASS,
    requiredPracticeVerifierId: MARKDOWN_LINK_AUDIT_PRACTICE_VERIFIER_ID,
    async verify(_event, evidence) {
      try {
        const actual = parseMarkdownLinkAuditResult(JSON.parse(evidence.finalAssistantText));
        if (actual === undefined) return "unverified";
        const expected = await scanMarkdownRelativeLinks(projectRoot);
        return JSON.stringify(actual) === JSON.stringify(expected)
          ? "verified_contribution"
          : "unverified";
      } catch {
        return "unverified";
      }
    },
  }];
}
