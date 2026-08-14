# ADR-0001：第一阶段采用 Routing-only MVP

## Status

Superseded — 2026-08-14 by ADR-0006

本文件保留为项目范围演变的历史记录，不再作为当前实现依据。当前项目采用 Activation Memory 与 Procedural Memory 并行演化的双记忆架构。

Historical clarification by ADR-0003：当时的第一阶段以全量 description 为真实路径，本地检索仅 shadow 运行；不在运行时动态调整候选数量。

## Context

原始 Skill Cortex 同时包含技能路由、文本渐进披露、经验巩固、procedure 编译和异常降级。审查后确认：单个 `SKILL.md` 通常不是主要上下文瓶颈；现有 Agent Skills 也已经支持从 metadata 到完整正文和引用资源的按需加载。当前需要首先验证的问题是，大量技能 metadata、相似技能干扰、召回遗漏和复合任务组合。

如果在同一 MVP 中同时实现路由与执行深度，最终成功率、token 变化和错误将无法归因到具体机制。

## Decision

第一阶段只实现和评测技能路由：

1. 从任务与允许读取的环境状态中自动生成候选技能集合。
2. 根据经开发集校准的证据调整候选数量，而不是使用未经验证的固定 Top-K。
3. 支持 no-skill、多个互补技能、依赖与冲突。
4. 向主 Agent 提供候选技能的完整 description。
5. 技能被选中后直接加载完整 `SKILL.md`，沿用现有渐进披露。
6. 分开测量候选召回与主 Agent 最终选择，不以端到端成功掩盖路由错误。

第一阶段不实现：文本 schema 层、habit compiler、可执行 procedure、episode consolidation、自动技能更新或执行自治深度控制。

## Consequences

### Positive

- 直接对应“大量技能如何准确激活”的原始问题。
- 每项指标可归因，能够与全量 description、当前 Pi 路由、固定 Top-K 和混合检索公平比较。
- 不引入自动执行与自修改带来的权限、污染和回滚风险。
- 可先 shadow 运行，再决定是否接管真实路由。

### Negative

- 第一阶段不能证明“经验越多、显式推理越少”。
- 即使路由成功，任务执行成本仍取决于完整 `SKILL.md` 和基础模型。
- 需要单独建设带 gold skill set、no-skill 和复合任务标签的评测集。

### Neutral

- 未来仍可独立研究 procedure 与异常恢复，但它们必须有新的 ADR、数据和验收标准。

## Alternatives Considered

**同时实现文本 depth controller**

- 拒绝：单个 `SKILL.md` 的节省潜力未经证明，且增加同步与信息损失风险。

**Habit/procedure 优先**

- 拒绝：不能先回答路由是否正确，并引入执行安全与反馈归因问题。

**路由与 habit 双轨同时实现**

- 拒绝：当前接口、数据契约和 benchmark 尚未冻结，并行开发会放大返工。

## References

- `docs/reviews/2026-08-14-skill-cortex-audit.md`
- `docs/research/2026-08-14-skill-cortex-related-work.md`
