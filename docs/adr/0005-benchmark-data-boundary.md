# ADR-0005：Benchmark 数据与 Gold Label 边界

## Status

Accepted — 2026-08-14

Applicability amended by ADR-0007 and ADR-0008：本文继续规范 discovery 评测的数据来源与 gold label 边界，但不要求当前阶段建设大型 Gold Set，也不再以 ADR-0004 的旧 shadow 晋升流程为实施前置条件。Practice trace、Activation Profile 与 Compiled Procedure 的证据治理由 ADR-0008 规定。

## Context

本地词法检索容易在与 skill description 用词相近的任务上取得虚高成绩。直接由 LLM 阅读 description 后生成 query，会把索引词泄漏进评测集。Pi 历史任务更接近真实分布，但可能包含敏感内容，而且 Pi 当前选择的技能不一定正确，不能自动作为 gold label。

## Decision

### Promotion Gold Set

只有经过人工复核的任务集合可以用于 ADR-0007 所定义的 discovery 准确率声明或检索机制更换判断。每个样本至少保存：

- `case_id`；
- 原始任务表达 `query`；
- `gold_skill_ids`，允许为空或包含多个技能；
- `label_type`：single-skill、multi-skill 或 no-skill；
- `language`；
- 简短标注理由；
- 可能混淆的技能，仅用于误差分析，不直接参与检索。

任务表达不得机械复制 skill name 或 description。开发集与最终测试集必须在调参前分离；Top-K、分词、字段权重与任何查询处理只能在开发集选择。

### Pi Shadow Observations

- 只用于观察真实查询长度、语言、主题和候选分布。
- 未经人工复核的 shadow query 不得拥有 gold label，不得进入准确率统计。
- 不得默认保存秘密、完整文件内容或无限期历史；采集与脱敏策略需另行确认。

### Synthetic Stress Data

- 只用于扩大技能目录、测量索引时间、索引大小、查询延迟和吞吐。
- 不得用于 Recall@K、最终技能选择准确率或晋升结论。
- 必须与人工 Gold Set 分栏报告。

## Consequences

### Positive

- 降低 description 泄漏和自证式 benchmark 风险。
- no-skill 与 multi-skill 可以被正式表达，而非强制单标签。
- 真实分布观察、准确率证据和规模压力测试互不污染。

### Negative

- Gold Set 的创建与复核需要人工时间。
- 样本规模受限，非劣检验的统计能力可能不足。
- Shadow 数据不能直接快速扩大训练集。

## Alternatives Considered

**直接使用 Pi 历史选择作为 gold**

- 拒绝：当前行为是被比较对象，不是正确性证据。

**由 LLM 根据 descriptions 批量生成评测 query**

- 拒绝作为晋升数据：容易复述触发词并偏向生成模型熟悉的表达。

**只使用公开工具检索 benchmark**

- 拒绝为主数据：tool schema 与本机 Agent Skill description、scope 和触发语义并不等价；可作为外部补充。

## References

- `docs/adr/0003-shadow-local-retriever.md`
- `docs/adr/0004-promotion-principle.md`
