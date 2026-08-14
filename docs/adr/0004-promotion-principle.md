# ADR-0004：成本下降、准确率非劣的晋升原则

## Status

Superseded — 2026-08-14 by ADR-0007 and ADR-0008

本文件的“成本下降、准确率非劣、失败透明”原则继续适用，但旧的 Shadow Local Retriever 晋升流程已失效。Discovery 验收由 ADR-0007 管理，经验与 procedure 晋升由 ADR-0008 管理。

## Context

全量 description 与本地检索优化的目标不同。全量方案天然不会在候选生成阶段遗漏已注册技能，但可能增加 metadata token 和主 Agent 的选择干扰；本地检索可以减少候选，却可能漏掉正确技能。单看 Recall@K、token 节省或一个加权总分都可能得到误导性结论。

项目的原始问题是大量技能 metadata 的上下文成本，因此不能接受“成本更高但路由略准”作为默认晋升理由，也不能用明显的准确率损失换取 token 节省。

## Decision

Shadow Local Retriever 只有同时满足以下原则，才有资格提出 active-routing ADR：

1. **候选覆盖达标**：gold skill set 在固定候选预算下被覆盖；单技能、复合技能与 no-skill 分开报告。
2. **最终选择非劣**：在相同主模型、prompt、工具和执行预算下，Top-K 候选界面的最终技能选择准确率相对全量 description 不出现超过预先冻结容忍度的下降。
3. **metadata 成本明显下降**：分别报告未缓存输入 token、缓存命中后的边际成本和注入字符数；达到预先冻结的最小改善幅度。
4. **本地开销受控**：报告索引时间、索引大小、单查询 CPU 时间以及 p50/p95 延迟；达到预先冻结上限。
5. **失败透明**：报告 miss、no-skill 误触发、跨语言失败、模糊技能和复合任务缺失，不得只给平均值。

具体数值阈值在 benchmark 数据集、重复次数和统计方法确定后冻结。阈值必须在查看最终 test 结果前写入评测契约。

不得将这些指标压缩为一个可互相抵消的加权总分。任一硬性门槛失败，默认结论都是保留全量 description。

## Measurement Boundary

### Router-only

- Recall@K / set recall；
- no-skill precision、recall；
- 候选数量；
- 本地查询延迟与索引成本。

### Selection replay

- 主 Agent 从候选 descriptions 中选择的 skill precision、recall 和 exact-set match；
- 输入 token、缓存命中与 wall-clock latency；
- 相对全量 description 的配对差异。

### Out of scope for promotion

- `SKILL.md` 执行质量；
- habit/procedure 收益；
- 任务最终产物质量；
- 用户主观偏好。

这些可以作为观察指标，但不能替代 routing-only 与 selection replay 门槛。

## Consequences

### Positive

- 本地检索必须用可测收益证明自身存在价值。
- 成本和质量边界明确，实验失败时可以直接停止方向。
- 配对评测减少不同任务与模型波动造成的误判。

### Negative

- 需要为主 Agent selection replay 支付模型评测成本。
- 非劣界值与最小成本改善幅度仍需根据样本量确定。
- Shadow 日志本身不能提供可信 gold label。

## Alternatives Considered

**准确率优先，不限制成本**

- 拒绝：偏离减少上下文成本的原始目标。

**成本与准确率同时必须显著改善**

- 拒绝：过于苛刻；当准确率统计等价而成本明显下降时，本地检索仍可能有价值。

**加权综合分数**

- 拒绝：权重可任意调整，容易隐藏召回或成本回归。

## References

- `docs/adr/0003-shadow-local-retriever.md`
- `docs/reviews/2026-08-14-skill-cortex-audit.md`
