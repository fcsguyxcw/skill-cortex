# ADR-0002：通用路由核心与 Pi Shadow Adapter

## Status

Superseded — 2026-08-14 by ADR-0006 and ADR-0007

本文件保留为 routing-only 阶段的平台隔离记录。平台无关契约、数据最小化与 adapter 隔离原则由后继 ADR 继承；Pi shadow 不再是当前项目主架构。

## Context

Routing-only MVP 既要验证可推广的路由假设，也要面对真实技能目录、模糊名称、scope 和现有运行行为。如果直接把算法写进 Pi 扩展，实验结果会和 Pi 生命周期、prompt 格式及工具接口耦合；如果只做离线 benchmark，又无法验证真实目录与运行成本。

## Decision

采用两个明确隔离的边界：

### 通用路由核心

核心只接受平台无关的数据契约：

- `SkillCatalog`：稳定技能 ID、版本、scope、完整 description，以及可选的结构化激活信息。
- `TaskContext`：用户任务与允许暴露给路由器的环境事实。
- `RoutePolicy`：候选预算、校准阈值、no-skill 与组合规则。
- `RouteDecision`：候选技能集合、分数与证据、组合关系、不确定性和 fallback 原因。

核心不得导入 Pi ExtensionAPI 类型，不负责加载或执行 `SKILL.md`，也不得修改 Agent prompt。

### Pi Shadow Adapter

Pi adapter 只负责：

1. 使用 Pi 原生 discovery 结果构造 `SkillCatalog`，保留 scope 并过滤不可由模型调用的技能。
2. 在不影响当前行为的情况下调用通用路由核心。
3. 记录候选集合、成本与可用于离线核对的最小证据。
4. 将 shadow 结果与 Pi 实际选择分开保存，禁止把 shadow 预测注入 system prompt。

Shadow 数据默认不得保存秘密、完整文件内容或未经定义的长期用户文本。进入真实任务采集前必须另行定义脱敏、保留期限与退出机制。

从 shadow 切换到 active routing 必须满足预先冻结的验收阈值，并通过新的 ADR；不得在实现阶段顺带开启。

## Consequences

### Positive

- benchmark 与平台集成共享同一核心算法和数据契约。
- 可以使用 Pi 的真实技能目录发现冷启动、scope、别名和相似技能问题。
- Shadow 失败不会改变用户当前 Agent 行为。
- 后续可增加其他 Agent 平台 adapter，而不复制路由逻辑。

### Negative

- 需要维护核心与 adapter 之间的序列化边界。
- Shadow 只能证明预测质量和成本，不能直接证明接管后的端到端收益。
- 真实任务标签仍需人工核对或独立 verifier，不能把 Pi 当前选择自动当作 gold label。

### Neutral

- 编程语言、进程边界和通信协议尚未决定，必须依据 benchmark 与 Windows/Pi 集成约束单独选择。

## Alternatives Considered

**Pi-first 扩展**

- 拒绝：较快获得产品行为，但路由假设、平台生命周期和 prompt 改动无法干净归因。

**纯离线研究原型**

- 拒绝：缺少真实技能目录和集成成本证据，难以判断是否值得用于日常 Agent。

## References

- `docs/adr/0001-routing-only-mvp.md`
- `docs/reviews/2026-08-14-skill-cortex-audit.md`
