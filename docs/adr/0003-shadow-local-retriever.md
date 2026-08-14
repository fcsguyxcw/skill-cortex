# ADR-0003：全量 Baseline 与 Shadow Local Retriever

## Status

Superseded — 2026-08-14 by ADR-0007

本文件保留为 discovery 方案选择的历史记录。当前运行路径改为 prompt 外本地检索；全量 description 仅保留为离线 baseline，不再作为 active path。

## Context

候选方案包括额外 LLM Router、主 Agent 主动调用 `search_skills`、技能目录树、能力层、skill cluster、模糊能力记忆和竞争式激活。它们分别引入模型调用成本、额外 Agent 循环、分层误差传播、人工维护或未经数据验证的打分权重。

当前还没有证据证明全量 description 在真实任务上的总成本与选择质量已经差到必须被替换。因此第一阶段不能默认“路由一定有用”，必须允许实验得出保留全量 description 的结论。

## Decision

第一阶段同时运行两条隔离路径：

### Active baseline

- 保持当前全量完整 description 的技能发现界面。
- 继续沿用选中后加载完整 `SKILL.md` 的行为。
- 不改变主 Agent 的 system prompt、技能选择或工具调用。

### Shadow local retriever

- 在 prompt 外对技能 `name + complete description` 建立本地全文索引。
- 收到任务后自动执行 FTS/BM25，生成固定候选预算下的 Top-K。
- 输出候选技能 ID、分数和本地检索耗时，仅用于离线评测。
- Shadow 结果不得注入主 Agent，不得触发 `load_skill`，不得改变真实行为。

第一版不默认使用：

- Router LLM；
- query embedding 或向量数据库；
- skill cluster、能力层或目录树硬门控；
- recent success、maturity、竞争式激活权重；
- 运行时动态成本级联；
- 依赖主 Agent 主动调用的搜索路径。

Embedding 可以作为离线 benchmark 的独立对照，但不得因为存在实验代码而进入默认运行路径。

实验完成后只允许做一次部署选择：本地检索达到预先冻结的验收标准后，通过新 ADR 切换；否则保留全量 baseline 并停止该路由方向。不得在运行时按启发式在两者之间切换。

## Consequences

### Positive

- 无额外模型调用或 Agent tool roundtrip。
- 可以直接测量本地检索的候选覆盖率、CPU 延迟和索引成本。
- 不会因 shadow 召回遗漏影响真实任务。
- 架构允许得到“当前规模不需要路由”的结论。

### Negative

- FTS/BM25 对同义表达和中文 query/英文 description 可能召回不足。
- Shadow 阶段不能直接测量 Top-K 注入后主 Agent 的最终选择变化；需要离线 replay。
- 固定 Top-K 的值仍需在开发集比较，不能从经验臆定。

### Neutral

- 如果词法检索失败，后续先根据失败类别决定是否增加 embedding、查询扩展或结构化 metadata，而不是预先实现全部机制。

## Alternatives Considered

**额外 LLM Router**

- 拒绝：可能比全量 metadata 的边际成本更高，并增加延迟和失败路径。

**主 Agent 自己搜索**

- 拒绝为主路径：Agent 可能不搜索，且搜索工具通常增加一个 Agent 循环；仍可保留为人工诊断工具。

**能力层 / Skill Hub / 两层记忆**

- 拒绝：本质是层次检索，顶层误判会传播；当前 Pi 的紧凑分类目录已经暴露模糊技能不可发现与分类错误。

**竞争式 Skill Activation**

- 拒绝：尚无数据支持多信号权重，复杂度高于当前问题所需。

## References

- `docs/adr/0001-routing-only-mvp.md`
- `docs/adr/0002-general-core-pi-shadow.md`
- `docs/reviews/2026-08-14-skill-cortex-audit.md`
