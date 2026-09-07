---
name: skill-cortex-gate-status
description: Report the authoritative G1-G7 Activation Memory gate states for this Skill Cortex repository. Use only for current gate or ticket status questions in this project.
---

# Skill Cortex Gate Status

Read `config/activation-memory-gates.json` from the current project with the read tool.

Return only strict JSON with exactly the same `schemaVersion` and ordered `gates` array. Each gate
must contain only `gateId` and `status`. Do not infer status from prose, change values, add commentary,
or modify any file. If the file cannot be read or is invalid, report that failure instead of guessing.
