# ADR-0009：Practice Store 事件文件与显式删除

## Status

Accepted — 2026-08-14

Supersedes only the Phase 0 persistence-medium choice of JSONL in
`docs/research/2026-08-14-phase0-project-baseline.md` §5. Other retention,
sensitivity, project-local and synchronization decisions remain unchanged.

## Context

Phase 0 selected project-local JSONL before the Store implementation existed. Phase 2 must
simultaneously provide append-only event identity, physical deletion, tenant/provenance
isolation, crash-recoverable deletion audit, and concurrent duplicate-ID rejection.

An append-only JSONL plus tombstone can hide an event but cannot delete its body. Physical
deletion requires rewriting or compacting the entire log, creating a larger mutation and
recovery boundary than the MVP needs.

## Decision

The MVP stores one immutable JSON object per `PracticeEvent` under a hashed tenant directory
and provenance partition. A tenant-local claim file is created with exclusive-create semantics
before the event file, so an `eventId` cannot be reused across provenance partitions.

Explicit deletion:

1. locates the event without exposing its body;
2. creates a content-free tombstone audit record;
3. physically removes the event body;
4. retains the claim and tombstone so the evidence ID cannot be silently reused;
5. returns only existing or already-invalidated evidence IDs for downstream cascade handling.

The Store root must resolve inside an explicitly supplied project root. Tenant names are used
only as SHA-256 inputs and never as path fragments. Production evidence queries read only the
`real` partition and exclude tombstoned evidence.

Every append must pass the Practice policy gate before any tenant, claim, or event file is
created. The stored attribution, failure class, and first attributable failure step use the
policy-normalized result rather than caller assertions.

This decision changes only the persistence layout. `PracticeEvent` remains append-only and its
schema, provenance meanings, sensitivity policy and proposal boundaries do not change.

## Consequences

### Positive

- Physical deletion is bounded to one event body and leaves a minimal audit marker.
- Duplicate IDs can be rejected atomically across provenance partitions.
- Tenant and provenance isolation are visible in the filesystem and directly testable.
- A failed deletion can be retried after the tombstone has already hidden the evidence.

### Negative

- Large catalogs create more files than JSONL.
- Cross-process append/delete stress and filesystem-specific durability are not yet benchmarked.
- A later database or compacted-log migration will require an explicit migration reader.

## Alternatives Considered

**Append-only JSONL plus tombstones only**

- Rejected: the original event body remains on disk after an explicit deletion request.

**JSONL rewritten during deletion**

- Rejected for MVP: deleting one event rewrites unrelated evidence and enlarges the crash and
  concurrency boundary.

**SQLite immediately**

- Rejected for MVP: adds a dependency and migration surface before access patterns and scale are
  measured.

## Verification

- append/round-trip and duplicate-ID tests;
- real/shadow/evaluation/synthetic partition tests;
- tenant hash and realpath escape tests;
- physical delete, tombstone, retry and non-reuse tests;
- policy-before-write tests proving rejected content creates no evidence files.
