# 01 — Establish the real Markdown link-audit verifier path

**What to build:** A project-local Markdown relative-link audit Skill that runs through the real production entry and receives a positive assessment only when an independent deterministic scan exactly verifies its strict result.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] The Skill freezes bounded scope, strict result schema, deterministic ordering, and failure behavior.
- [x] A second exact-bound verifier registration coexists with the unchanged gate-status verifier.
- [x] A real AgentSession covers exposure, Skill load, bounded reads, PracticeEvent persistence, verifier execution, and assessment persistence.
- [x] Malformed, fenced, partial, extra-field, stale-binding, missing-load, missing-read, ambiguous-registration, and scanner-disagreement cases create no assessment.
- [x] Raw prompt, final output, document body, and absolute paths are absent from every persisted artifact.
- [x] Existing gate-status and frozen-path isolation regressions remain green.
