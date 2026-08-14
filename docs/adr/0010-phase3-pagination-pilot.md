# ADR-0010：Phase 3 使用只读 SQL pagination 检测 pilot

## Status

Accepted — 2026-08-14

Supersedes only the Phase 3 `docx` pilot choice and fixture-copy instruction in
`docs/research/2026-08-14-phase0-project-baseline.md` and
`docs/plans/2026-08-14-dual-memory-implementation-plan.md`. The Phase 2 synthetic
`docx` observation replay remains historical evaluation evidence and does not represent an
installed Skill copy or executable procedure.

## Context

Phase 0 selected the installed `docx` Skill before its redistribution terms and local runtime
were fully verified. Its `LICENSE.txt` prohibits retaining copies outside the provider's
Services, reproducing the materials, and creating derivative works. Copying it into a
project-local fixture or deriving an executable artifact from it would therefore violate the
pilot boundary. In addition, the default local `python` executable cannot currently import its
standard-library `encodings` module, so the proposed OOXML verifier is not runnable.

Phase 3 still needs a deterministic, replayable and independently verifiable partial-program
pilot. The installed `supabase-postgres-best-practices` Skill declares MIT licensing and has a
narrow pagination rule whose observable result can be evaluated without a database or external
side effect.

## Decision

Phase 3 uses only the `references/data-pagination.md` clause of the installed
`supabase-postgres-best-practices` Skill. The pilot procedure performs static inspection of
project-owned SQL input and reports whether a query uses OFFSET-based pagination.

The procedure boundary is:

- input: a bounded SQL string supplied by the evaluation fixture;
- output: structured findings or an explicit abstain result;
- allowed effect: deterministic in-memory analysis only;
- forbidden: executing SQL, connecting to a database, rewriting a query, modifying the
  installed Skill, or treating the procedure as an independently discoverable Skill;
- fallback: any unsupported syntax, uncertain classification, source mismatch or dependency
  mismatch returns to the parent Skill slow path or a legal abstain;
- verification: a frozen held-out corpus and expected structured results owned independently
  from the compiler implementation.

The installed Skill remains read-only. The repository records provenance, complete source
hashes and project-authored evaluation cases, but does not need to copy the Skill body or its
examples. The parent binding includes the `SKILL.md` hash, selected rule hash, declared version,
license identifier, detector schema/version and relevant runtime dependency hashes.

The pilot may compile only the detection decision. Advice, query rewriting, performance claims,
database-specific semantics and all other rules remain `llm_holes` or outside scope.

## Consequences

### Positive

- The pilot is read-only, deterministic and replayable without database credentials.
- Expected findings provide an external verifier independent of LLM self-evaluation.
- Source and dependency drift can invalidate one narrow procedure without affecting discovery.
- No proprietary Skill material is copied into the repository.

### Negative

- Static inspection cannot prove runtime query performance.
- A deliberately small SQL subset requires abstention on unsupported syntax.
- The pilot validates partial compilation mechanics, not arbitrary Skill compilation.

## Alternatives Considered

**Continue with the installed `docx` Skill without copying it**

- Rejected: creating a derived procedure is also prohibited, and the required local Python
  verifier is not runnable.

**Copy the `docx` Skill only into a gitignored fixture**

- Rejected: gitignore does not cure the license restriction on retaining or reproducing copies.

**Execute pagination queries against a local Postgres instance**

- Rejected for this pilot: it adds mutable infrastructure and database-dependent observations
  when static detection has a sufficient deterministic postcondition.

## Verification

- source inventory records complete SHA-256 values and license provenance;
- Evaluation Owner freezes train/held-out cases and thresholds before candidate results exist;
- held-out replay checks exact structured findings, abstentions, regressions and per-component
  cost;
- source or dependency fingerprint changes suspend the procedure before replay;
- repository scans confirm no installed Skill body or proprietary `docx` files were copied.

## References

- `docs/adr/0006-dual-memory-skill-architecture.md`
- `docs/adr/0008-practice-evidence-and-procedure-promotion.md`
- `docs/design/dual-memory-data-contracts.md`
- https://github.com/supabase/agent-skills
- https://github.com/supabase/agent-skills/blob/main/LICENSE
