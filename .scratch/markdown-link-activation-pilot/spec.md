# Markdown Relative-Link Audit Activation Pilot

**Status:** ready-for-agent

## Problem Statement

Skill Cortex 目前只有一个 gate-status 有界真实任务域能够形成可信 positive learning evidence。该任务是
项目状态查询，不能证明系统能从第二个非元、可重复的真实 Skill 使用中形成隐私安全、可泛化且版本绑定的
Activation Memory。现有真实 PracticeEvent 只保存 prompt hash 和候选/选择数量，没有可供后续检索学习的
语义特征；已有 Activation Memory calibration 又显示 naive 与 verified memory 行为相同，并产生严重
No-Skill 与 hard-confuser 误召。

## Solution

增加一个 project-local Markdown 相对链接审计 Skill。该 Skill 在明确限定的项目文档范围内报告失效的
相对文件链接，并输出可由独立确定性扫描器严格复核的结构化结果。只有 Skill revision/source 精确匹配、
真实链路实际加载 Skill、所需读取步骤存在、最终结果与独立扫描完全一致时，才写入 positive assessment。

在 verified assessment 形成后，由一个白名单语义特征 producer 输出少量受控特征，例如任务族、检查范围、
链接类型和结果类别。producer 不保存原始 prompt、原始 assistant 输出、文档正文、绝对路径或模型生成
alias。通过准入的 evidence 只自动形成 draft/shadow ActivationProfile，不进入 production active overlay。

最后在冻结 development/calibration 数据上比较 BM25、BM25+QE、naive memory 与 verified memory，保持
0/1/2/4/8 learning curve，并分别报告 No-Skill、hard-confuser、single/multi 与中英文结果。安全门未通过
时停止，不运行 held-out，不启用 active memory。

## User Stories

1. As a repository maintainer, I want a Skill to audit Markdown relative links, so that broken documentation references can be reported consistently.
2. As a repository maintainer, I want the audit scope to be explicit and bounded, so that unrelated files are not scanned accidentally.
3. As a repository maintainer, I want valid links and broken links distinguished deterministically, so that the result is independently checkable.
4. As a repository maintainer, I want the result to use a strict structured schema, so that prose formatting cannot hide mismatches.
5. As a Skill Cortex operator, I want the parent Skill revision and source hash bound to every verifier registration, so that stale Skills cannot receive evidence.
6. As a Skill Cortex operator, I want a real Skill load and required audit operation recorded, so that output correctness alone does not imply Skill contribution.
7. As a Skill Cortex operator, I want the final result recomputed by an independent scanner, so that model self-evaluation is not contribution proof.
8. As a Skill Cortex operator, I want malformed, fenced, partial, reordered, extra-field, and stale results rejected, so that only the frozen contract can pass.
9. As a Skill Cortex operator, I want missing, ambiguous, or duplicate verifier registrations to fail closed, so that attribution remains exact.
10. As a privacy-conscious user, I want prompts and assistant outputs kept in memory only during verification, so that raw interaction text is not persisted.
11. As a privacy-conscious user, I want learned semantic features restricted to a reviewed vocabulary, so that document content and arbitrary aliases cannot leak into memory.
12. As a privacy-conscious user, I want absolute paths rejected from learned features, so that local identity and filesystem details are not retained.
13. As a Skill Cortex operator, I want unverified, mixed, unknown, evaluation, and synthetic evidence excluded from consolidation, so that fixtures cannot become production learning.
14. As a Skill Cortex operator, I want verified evidence to create only draft/shadow profiles, so that a pilot cannot change production discovery.
15. As a Skill Cortex operator, I want repeated equivalent evidence handled deterministically, so that reruns do not create unbounded duplicate cues.
16. As a Skill Cortex operator, I want evidence deletion and Skill revision drift to suspend dependent profiles, so that learned behavior remains reversible.
17. As a researcher, I want naive and verified producers compared with the same retrieval boost, so that any claimed gain is attributable to verified semantics rather than cue volume.
18. As a researcher, I want a frozen 0/1/2/4/8 learning curve, so that improvements cannot be selected after seeing results.
19. As a researcher, I want No-Skill and hard-confuser false positives reported separately, so that recall cannot conceal unsafe activation.
20. As a researcher, I want single/multi and Chinese/English results reported separately, so that aggregate results cannot hide a failed slice.
21. As a researcher, I want all negative controls run before held-out, so that contamination, stale evidence, deletion, and cross-scope failures remain visible.
22. As a researcher, I want calibration failure to stop the experiment, so that held-out data is not consumed after an unsafe result.
23. As a production user, I want the existing gate-status verifier to remain unchanged, so that the new pilot cannot regress the bounded G1 path.
24. As a production user, I want exposure suppression and active overlay to remain disabled, so that the experiment cannot silently change normal candidate selection.
25. As a maintainer, I want the frozen procedure/runtime path untouched, so that this pilot stays within the Activation-Memory-first scope.

## Implementation Decisions

- The pilot domain is project-local Markdown relative file-link auditing; external URLs, anchors, generated artifacts, and arbitrary filesystem scanning are outside the verifier contract.
- The Skill defines a strict JSON result with deterministic ordering and no commentary or Markdown fence.
- The contribution verifier re-runs a deterministic repository scanner and compares the normalized result exactly.
- The existing exact-bound verifier registration framework is extended with a second task-specific registration; the gate-status registration remains intact.
- The highest verification seam is a real AgentSession through the production entry: candidate exposure, parent Skill load, bounded reads, PracticeEvent persistence, independent verification, assessment persistence, semantic feature production, and draft/shadow induction.
- Lower component seams cover scanner parsing, normalization, verifier fail-closed behavior, feature allow-listing, privacy rejection, and deterministic induction.
- The semantic feature producer emits only frozen vocabulary values covering task family, audit scope, link class, and result class. It cannot copy natural-language spans from the prompt or output.
- Relative path values are represented only through approved coarse classes or hashes when identity is needed; absolute paths are rejected.
- Semantic features are attached only after exact-bound verified contribution. Ordinary successful PracticeEvents retain the existing minimal derived features.
- Automatic induction targets draft then shadow only. The production entry continues to reject active overlay configuration.
- The pilot uses the existing project-local Practice, Assessment, and ActivationProfile stores and existing pause/delete/revision controls.
- Evaluation preserves the previously frozen retriever arms, producer arms, learning-curve points, leakage checks, and negative controls; new pilot fixtures are development/calibration only.
- Calibration must show verified memory differs beneficially from naive memory while passing every frozen safety control. Failure stops before held-out.

## Testing Decisions

- Tests assert externally observable behavior: scanner result, assessment creation or rejection, persisted redacted fields, profile status, candidate outputs, and reported metrics.
- The primary end-to-end test uses the real project-local production entry and AgentSession rather than a new fake host seam.
- Verifier tests cover exact success plus malformed JSON, Markdown fences, extra fields, wrong ordering, missing reads, no Skill load, revision/source drift, ambiguous registration, and scanner disagreement.
- Feature-producer tests cover allow-listed outputs, determinism, deduplication, prompt/output non-persistence, absolute-path rejection, instruction-like text rejection, and absence on unverified evidence.
- Induction tests prove only verified real evidence creates draft/shadow profiles and that pause, deletion, scope mismatch, and revision drift fail closed.
- Evaluation tests reuse the existing Activation Memory formation, leakage, control, and metric patterns rather than creating a second evaluation framework.
- Existing gate-status production-entry and frozen-path isolation tests remain mandatory regression checks.

## Out of Scope

- Generic LLM contribution verification.
- External URL availability checking, network requests, anchor validation, or document-content correctness.
- Production exposure suppression, adaptive budget changes, candidate-card compression, or active Activation Memory.
- Any change to frozen procedure compiler, resolver, executor, promotion, lifecycle, or runtime paths.
- Writing to user-level Pi, Codex, Agent, or installed Skill locations.
- Persisting raw prompts, assistant outputs, document bodies, absolute paths, or arbitrary model-authored aliases.
- Running or revealing held-out results before calibration passes all frozen gates.

## Further Notes

The pilot is intentionally narrow: deterministic artifact verification provides a stronger attribution boundary than a generic
success judge. Passing this pilot would demonstrate a second real formation path and a privacy-preserving semantic producer;
it would not establish universal Skill contribution verification or production learning quality.
