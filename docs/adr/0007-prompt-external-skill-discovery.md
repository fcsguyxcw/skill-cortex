# ADR-0007：采用 Prompt 外 Skill Discovery

## Status

Accepted — 2026-08-14

Supersedes ADR-0003 and the discovery-promotion scope of ADR-0004.

## Context

即使完整 `SKILL.md` 已经按需读取，把所有 Skill 的 metadata 常驻主 Agent 上下文，仍会随目录规模增长而增加 token、缓存和相似候选干扰。项目已明确不把全量 metadata 注入作为正式运行方式，但也不增加一个每次调用的 Router LLM，避免额外模型成本、延迟和新的失败路径。

Discovery 是双记忆架构的基础接口，而不是主研究创新。它必须让新安装 Skill 和更新后的 Activation Memory 可被发现，同时不阻塞已有 Skill 的渐进程序化研究。

## Decision

正式运行采用宿主自动触发的 prompt 外本地检索。

### Registry 与索引

外部 Registry 保存完整 Skill metadata，并以 `skill_id + skill_revision` 标识不可变来源，以 `source_hash` 表示内容指纹。TypeScript 字段分别映射为 `skillId`、`skillRevision` 与 `sourceHash`。索引可以读取：

- 作者提供的 `name` 与完整 `description`；
- scope、依赖、权限与可用环境；
- 经 ADR-0008 验证发布的 aliases、learned cues、成功示例摘要、negative 和 near-miss 信息。

派生字段必须与作者字段分开保存，带 provenance 和版本，不能覆盖原 description。

### 自动候选生成

每次主 Agent 推理前，由宿主自动检索候选；不依赖 Agent 先想起并调用搜索工具。第一版使用本地 FTS/BM25，在固定且可配置的候选预算内产生 Top-K。

只有候选 Skill Cards 进入主 Agent 上下文。每张卡至少包含：

- `skill_id`、名称和版本；
- 完整作者 description；
- scope 与必要环境；
- 与当前任务相关的少量派生激活证据；
- 可用性或加载失败原因。

主 Agent 从候选中输出单个 Skill、互补 Skill Set 或 No-Skill。Skill 被选中后才进入 Execution Resolver；Procedure 不作为独立候选出现。

### 补搜与加载

- `search_skills(query)` 保留为补搜和诊断工具，但不是主路径的唯一入口。
- `load_skill(skill_id)` 只在慢路径需要读取完整 `SKILL.md` 时使用。
- 补搜仍返回有限候选，不得退化为把全量 metadata 注入上下文。

### 第一版明确不使用

- 额外 Router LLM；
- Ability、cluster 或目录树的硬门控；
- recent success 或统一 maturity 作为召回加权；
- 未经失败证据支持的动态成本级联；
- Procedure 级全局检索。

中文 query/英文 description、同义表达或模糊名称造成的系统性召回失败被实际证据确认后，才允许通过后续 ADR 增加 embedding、查询扩展或其他检索组件。

### Baseline 与验收

全量 metadata 只作为离线对照，不进入正式运行路径。第一阶段只做足以证明集成可用的 smoke tests：

- 已安装 Skill 能被发现并加载；
- 单 Skill、互补多 Skill 和 No-Skill 可以表达；
- 中文/英文与模糊名称有代表性覆盖；
- Activation Memory 更新后可重建索引并按版本失效；
- 召回 miss 和补搜行为可观测。

只有在对外声称 discovery 准确率、成本优势或准备更换检索机制时，才按 ADR-0005 建设和使用人工复核数据；不得用当前 Agent 的选择结果自证正确。

### Security 与隔离

Discovery 只能看到允许暴露的任务和环境事实。索引必须保留用户、项目和 scope 隔离；召回 Skill 不授予任何新权限，真正授权仍在执行路径逐次检查。

## Consequences

### Positive

- Skill 数量不再线性增加主 Agent 常驻 metadata。
- 不增加额外模型调用，检索成本和延迟可独立测量。
- Discovery 接口与 Activation Memory、Procedural Memory 和具体 Agent 平台解耦。
- 保留完整作者 description 作为候选判断依据，避免过度压缩造成模糊 Skill 不可发现。

### Negative

- 词法检索可能漏掉跨语言和同义表达，需要记录 miss 并逐类改进。
- Top-K 召回错误会在主 Agent 选择前丢失正确 Skill。
- 派生激活资料需要防止污染、泄漏和频率自强化。

### Neutral

- 候选预算是实现参数，不是认知机制定律。
- 本 ADR 不声称本地检索本身具有研究新颖性。

## Alternatives Considered

**全量 metadata 常驻**

- 拒绝为正式运行路径：与项目的上下文约束相冲突；仅保留为离线 baseline。

**额外 Router LLM**

- 拒绝第一版：可能比 metadata 边际成本更高，并增加延迟、错误和运维路径。

**完全依赖主 Agent 主动搜索**

- 拒绝：Agent 可能忘记搜索，且通常增加一个 Agent loop。

**Ability / Skill Hub 两阶段硬路由**

- 拒绝：顶层误判会阻断正确 Skill；Ability 仅允许作为软索引字段。

## References

- `docs/adr/0005-benchmark-data-boundary.md`
- `docs/adr/0006-dual-memory-skill-architecture.md`
- `docs/adr/0008-practice-evidence-and-procedure-promotion.md`
- `docs/adr/0003-shadow-local-retriever.md`
