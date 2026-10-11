# ADR-0008：Practice Evidence 与 Procedure 晋升契约

## Status

Partially superseded by ADR-0014 — 2026-08-22

Practice Event、Activation evidence、污染、版本、删除与“任务成功不等于 Skill 有贡献”的条款继续
适用。Compiled Procedure proposal、promotion 与 runtime 条款仅约束 frozen experimental track，
不再定义当前主线交付范围。

Supersedes the procedure-promotion scope of ADR-0004 and extends ADR-0005.

## Context

真实使用经验既可以改善 Skill discovery，也可以帮助识别 Skill 内可程序化的稳定步骤，但“任务成功”不能自动证明某个 Skill 被正确激活，更不能证明某段 procedure 可以安全复用。成功可能来自基础模型、其他 Skill、偶然环境状态或未记录的人工干预。

如果 Agent 直接从历史轨迹更新激活权重或生成可执行程序，秘密、提示注入、评测答案和错误归因都可能被永久化。Compiled Procedure 还可能在 Skill、工具、权限或环境变化后悄然失效。

因此两类记忆都必须从不可变证据产生 proposal，经独立验证后发布，并且支持失效、降级和回滚。

## Decision

### Practice Event

每次相关调用只追加不可变 Practice Event，不在运行时直接修改已发布记忆。事件至少记录：

- `event_id`、时间和 provenance；
- `skill_id`、`skill_revision` 与作为内容指纹的 `source_hash`；
- 脱敏任务摘要或受访问控制的原始引用；
- 候选、最终选择与执行表示：完整 Skill 或 `procedure_id`；
- 允许保存的环境事实、模型、工具 schema 与依赖版本；
- 步骤和工具结果、授权结果、守卫与后置条件；
- verifier 结果、首个可归因失败点与失败类别；
- 敏感级别、用户/项目 scope 和保留策略。

禁止把未脱敏秘密、完整凭据、来源不明网页指令或评测轨迹默认写入长期证据库。运行时成功只产生 observation，不自动提升权重或自治等级。

### Activation Memory proposal

Activation Memory 更新提案必须区分：

- Skill 确实相关且执行成功的 positive evidence；
- Skill 相关但条件不满足或执行失败的 boundary evidence；
- 语义相近但不应选择该 Skill 的 negative/near-miss evidence；
- 因工具、权限、环境或并发导致、不能归因给 Skill 的 external failure。

提案不得覆盖作者 description，不得仅以调用频率为依据。发布前至少进行污染与秘密扫描、来源检查，以及与冻结 discovery cases 的回放；对外准确率或晋升声明继续遵守 ADR-0005。

`boundary evidence` 与 `external failure` 保留在不可变 `PracticeEvent` 及离线 proposal 中；只有经过 discovery 回放验证、并被转换为具体 cue 的证据，才能写入 `ActivationProfile`。失败类别本身不得直接成为 active cue 或硬过滤器。

### Compiled Procedure proposal

Procedure 只能编译父 Skill 中经多次真实使用证明稳定的部分，不要求或假设整个 Skill 都能程序化。每个 proposal 必须保存：

- 父 `skill_id`、`skill_revision`、作为内容指纹的 `source_hash` 和来源条款映射；
- 适用条件、参数类型、环境与工具依赖；
- 已覆盖步骤、明确保留的 `llm_holes` 和禁止自动化的步骤；
- 权限清单、effect class、不可逆性和审批点；
- 后置条件、外部 verifier、超时和安全停止条件；
- 训练证据、独立保留证据、成本测量和上一稳定版本。

第一版只允许确定性、可回放、只读或幂等步骤进入快路径。任意自修改代码、权限扩张或无法验证后置条件的不可逆操作不得自动晋升。

### Promotion gates

Procedure 只有同时满足以下条件才可发布：

1. **来源一致**：已编译步骤与父 `SKILL.md` 的约束和权限一致，未覆盖步骤明确留给慢路径。
2. **证据独立**：训练/提炼轨迹与最终保留回放分离；不得用生成该 procedure 的同一实例自证。
3. **质量非劣**：相同任务、模型、工具和预算下，相对完整 `SKILL.md` 慢路径的成功率和关键后置条件不超过预先冻结的容忍下降。
4. **摊销成本有收益**：单独报告编译、验证、程序执行、LLM holes 和失败回退成本，评估 `Cost per Successful Skill Invocation`，不只统计少读了多少 token。
5. **安全不降级**：权限、审批、sandbox 和不可逆操作门槛与慢路径相同或更严格。
6. **失败透明**：按守卫失败、环境漂移、工具错误、权限拒绝、逻辑错误和 verifier 失败分栏报告。
7. **可回滚**：发布版本、来源、验证证据、canary 状态和上一稳定版本可追溯。

具体证据数量和统计阈值在选定任务域与 verifier 后冻结，不从经验臆定统一次数。

### Runtime resolution、fallback 与失效

父 Skill 被 discovery 选中后，Execution Resolver 依次检查：

- Skill 与 procedure 来源版本是否匹配；
- 模型、工具 schema、权限和关键环境依赖是否仍有效；
- `applicable_when` 与全部前置条件是否满足；
- 当前 effect 是否在 procedure 的允许范围内。

全部满足才执行 procedure。不存在 procedure、条件不满足或证据版本失效时，直接读取完整 `SKILL.md` 进入慢路径，不把这种情况计为 procedure 失败。

守卫、后置条件或 verifier 失败时：

1. 在造成进一步副作用前安全停止；
2. 恢复完整 `SKILL.md` 与 LLM 推理；
3. 写入带失败类别和首个可归因步骤的反例；
4. 依据影响范围执行局部降级、停用或回滚；
5. 修订 proposal 必须重新经过独立验证，不得在当前调用中自我发布。

原 Skill、tool schema、权限或关键依赖 hash 变化时，Procedure 默认失效；Activation Memory 是否失效按受影响字段分别判断，但必须保留来源谱系。

## Consequences

### Positive

- 把运行证据、激活学习和执行程序化的因果边界分开。
- 成本收益按成功调用的完整生命周期计算，避免昂贵编译器制造虚假 token 节省。
- 异常会恢复到权威 `SKILL.md`，并产生可用于局部修订的反例。
- 权限、版本和回滚成为晋升契约，而不是实现后的补丁。

### Negative

- 高质量 verifier、独立保留任务和人工复核可能比生成 procedure 本身更昂贵。
- 证据不足时系统会长期保留慢路径，程序化覆盖率增长较慢。
- 环境和工具频繁变化会导致 procedure 反复失效和重验。

### Neutral

- “熟练”不是固定调用次数，而是一个带版本和验证证据的状态。
- 本 ADR 不规定 compiler 必须使用 LLM、规则系统、DSL 或人工生成。

## Alternatives Considered

**一次成功后立即编译和发布**

- 拒绝：无法区分稳定步骤、偶然成功和隐藏环境依赖。

**任务成功直接提高统一 confidence/maturity**

- 拒绝：混淆相关性、条件满足和执行成功，并形成频率自强化。

**生成任意程序后依赖运行时纠错**

- 拒绝：prediction error 是事后信号，不能撤销已经发生的不可逆伤害。

**Procedure 失败后继续在快路径内自我修改**

- 拒绝：会污染归因和验证边界；当前调用只能回退并产生修订 proposal。

## References

- `docs/adr/0005-benchmark-data-boundary.md`
- `docs/adr/0006-dual-memory-skill-architecture.md`
- `docs/adr/0007-prompt-external-skill-discovery.md`
- `docs/reviews/2026-08-14-skill-cortex-audit.md`
