# 02 — Produce private semantic features and a shadow profile

**What to build:** After verified Markdown link-audit contribution, derive only frozen, privacy-preserving semantic features and automatically form a reversible draft/shadow ActivationProfile without affecting production discovery.

**Blocked by:** 01 — Establish the real Markdown link-audit verifier path.

**Status:** ready-for-agent

- [ ] Features come only from a reviewed allow-list for task family, audit scope, link class, and result class.
- [ ] Prompt spans, assistant-output spans, document content, absolute paths, secrets, instruction-like text, and arbitrary model aliases are rejected.
- [ ] Only exact-bound verified real evidence reaches induction; unverified, mixed, unknown, evaluation, synthetic, stale, deleted, and cross-scope evidence does not.
- [ ] Repeated equivalent evidence yields deterministic, deduplicated cues linked to its evidence IDs.
- [ ] The real production entry forms only draft/shadow state and continues to prohibit active overlay configuration.
- [ ] Pause, evidence deletion, and parent revision drift retain their fail-closed and cascade behavior.
