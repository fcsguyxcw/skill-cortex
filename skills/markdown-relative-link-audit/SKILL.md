---
name: markdown-relative-link-audit
description: Audit broken relative file links in this project's README.md and docs Markdown files. Use for repository documentation link-health checks, not external URL or anchor validation.
---

# Markdown Relative-Link Audit

Audit only `README.md` and Markdown files under `docs/` in the current project.

Use read-only tools to inspect Markdown files and determine whether each relative file target exists. Ignore:

- URL schemes such as `http:`, `https:`, `mailto:`, and `data:`;
- fragment-only links beginning with `#`;
- links inside fenced or inline code;
- external URL availability and anchor correctness.

Do not read a target outside the current project. Treat a relative target that escapes the project as broken.

Return only strict JSON with exactly this shape:

```json
{"schemaVersion":1,"scope":"project-markdown","scannedFiles":["README.md","docs/example.md"],"brokenLinks":[{"source":"README.md","target":"docs/missing.md"}]}
```

Sort `scannedFiles` by code-point order. Sort `brokenLinks` first by `source`, then by `target`, also by code-point order. Use forward slashes in every path. Do not add Markdown fences, commentary, counts, absolute paths, or extra fields. If the audit cannot be completed, report the failure instead of guessing or returning the success schema.
