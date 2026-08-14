# 已安装 Skill 的经验引导式渐进程序化

日期：2026-08-14  
状态：**当前权威研究规范**  
性质：研究范围与架构合同，不构成实现证明或新颖性声明

## 一句话定义

> 研究 Agent 能否在反复使用用户已经安装的声明式 Skill 时，从经过外部验证的真实成功与失败中识别稳定子过程，将其逐渐编译为受约束、可失效、可回退的程序快路径，从而降低每次成功调用的摊销成本，同时保留原始 `SKILL.md` 作为语义来源和异常恢复慢路径。

## 1. 项目重心

项目研究的不是：

- 从任意任务轨迹自动创造全新的 Skill；
- 安装 Skill 后立刻把整份 `SKILL.md` 一次性编译掉；
- 让 Agent 熟练后永远不再读取原始说明；
- 只优化 Skill Router，或只减少几段 metadata token；
- 用“像人类”作为机制正确性的证据。

项目研究的是：

```text
用户安装 Skill
  → 初期读取完整 SKILL.md 并显式推理
  → 积累可归因、经验证的真实使用证据
  → 识别稳定步骤、变化参数、LLM 判断洞和失败边界
  → 生成父 Skill 的部分 CompiledProcedure
  → 以独立保留集做 shadow replay
  → draft / validated / canary / active 晋升
  → 适用时走快路径，越界时恢复 SKILL.md 慢路径
  → 新反例缩小边界、局部修订、降级或废弃程序
```

“人类熟练化”只提供一个机制启发：显式规则经过练习后，稳定部分被程序化；意外会重新唤醒显式控制。本文不主张 Agent 与人类学习在生物机制上等价。

## 2. Discovery 与程序化的关系

两者共享稳定的 Skill 身份和使用证据，但解决正交问题：

| 机制 | 输入 | 输出 | 回答的问题 |
|---|---|---|---|
| External Discovery | 任务、作者 metadata、ActivationProfile、允许的环境事实 | Top-K Skill Cards | 当前可能需要哪个已安装 Skill？ |
| ExecutionResolver | 已选 Skill、环境、权限、有效 procedure | 快路径或慢路径决定 | 这次是否可以不重新解释完整 Skill？ |
| Proceduralization | 父 Skill 的可归因 PracticeEvent | 候选 CompiledProcedure | 哪些稳定步骤可以程序化？ |

因此：

- Discovery 不读取或比较 procedure 作为独立候选。
- Skill 是否成熟不影响它与任务的语义相关性。
- Procedure 只能在父 Skill 已经被选中后参与执行解析。
- Discovery 可以先用静态作者 metadata 工作；经验化 ActivationProfile 不应阻塞程序化主研究。

## 3. 外部、无 Router LLM 的 Discovery

完整 Skill catalog 保存在 prompt 外的 Registry。宿主在主 Agent 推理前自动执行本地检索：

```text
用户任务 + 允许的环境事实
  → FTS/BM25 索引
  → Top-K Skill Cards
  → 同一次主 Agent 推理
  → 选择 Skill / Multi-Skill / No-Skill
```

第一版约束：

- 不调用额外 Router LLM。
- 不要求主 Agent 主动想起 `search_skills` 才能获得首批候选。
- 不把 Ability tree、cluster 或目录分类作为必经硬门。
- 不默认加入 embedding、动态成本级联、maturity 权重或竞争式激活。
- 不把全部 Skill metadata 放入主上下文；只注入 Top-K 候选卡。
- `search_skills(query)` 可以作为补搜和诊断工具，但不是唯一入口。
- 全量 descriptions 只作为离线准确率 comparator，而不是长期产品路径。

本地索引保留作者 description 的完整语义。过度压缩成名称或类别会使 `Code`、`do`、`Memory` 等模糊 Skill 无法发现。

## 4. 双记忆模型

### 4.1 Activation Memory：何时使用

每个 Skill 的 `ActivationProfile` 包含两层：

1. 作者声明层：name、description、scope、可调用性和环境要求，保持不可变。
2. 派生经验层：经过验证的成功任务示例、近似误用/负例、aliases、环境 cues 和适用边界。

派生层必须满足：

- 每条 cue 都能追溯到 PracticeEvent 与 verifier；
- 不能覆盖作者 description；
- 不能仅因使用次数多而提高相关性；
- negative cue 默认用于 rerank 或解释，不能未经验证做硬过滤；
- 可以单独关闭、回滚或删除，而不影响原始 Skill。

### 4.2 Procedural Memory：如何执行

每个 `CompiledProcedure` 都是父 Skill 的部分执行表示。它只覆盖已经证明稳定的步骤，保留必须由 LLM 判断的 `llm_holes`。

它至少包含：

- 父 `skill_id`、逻辑 `skill_revision`（代码字段 `skillRevision`）与 `source_hash`；
- 有类型参数和适用条件；
- `covered_steps` 与 `llm_holes`；
- effect class、权限清单与独立授权要求；
- 前置条件、运行时守卫、后置条件和结果不变量；
- 工具 schema、相关环境以及必要时的模型/prompt 指纹；
- 来源 PracticeEvent、保留集结果、成本证据和失败边界；
- `draft → validated → canary → active → suspended → retired` 状态；
- 上一稳定版本和回滚点。

Procedure 不得扩大父 Skill 权限，也不得注册成新的顶层 Skill。

术语上，`skill_revision` 是原始 Skill package 的不可变逻辑 revision；`source_hash` 只表示源内容指纹，不兼任逻辑版本、身份或依赖指纹。工具、权限、环境以及必要时的模型/prompt 依赖另由 dependency fingerprint 表达。`shadow replay` 是不改变真实行为的验证方式，不是 `CompiledProcedure` 的生命周期状态。

## 5. 最小数据合同

规范字段、状态机、数据所有权和不变量只维护在[双记忆数据合同](../design/dual-memory-data-contracts.md)中，避免研究说明与实现合同分叉。本研究依赖五个核心实体：

- `SkillRecord`：作者声明与不可变 Skill revision；
- `ActivationProfile`：可撤销、可追溯的 discovery 派生层；
- `PracticeEvent`：append-only、脱敏、分区且不自动代表 Skill 成功的证据；
- `CompiledProcedure`：绑定父 Skill revision 的部分执行快路径；
- `ExecutionDecision`：快路径、慢路径或 abstain 的可解释解析结果。

原始任务、文件内容、网页文本和工具输出不能默认无限期保存。实现前必须按数据合同冻结脱敏、用户/项目隔离、保留期限和删除机制。

## 6. PracticeStore 与归因

PracticeStore 是证据库，不是自动强化分数表。

一次任务成功不能直接证明某个 Skill 或 procedure 有效，因为成功可能来自基础模型、其他 Skill、缓存状态或偶然环境。只有满足以下条件的 trace 才能进入程序化证据：

1. 父 Skill、版本和实际执行表示可确认；
2. 关键步骤与结果由外部 verifier、确定性后置条件或人工复核判断；
3. 工具超时、环境漂移、权限拒绝和用户并发与 Skill 语义错误分开归类；
4. trace 已脱敏并带 provenance、scope 和安全标签；
5. benchmark/eval trace 被明确隔离，禁止回写训练或派生记忆。

PracticeEvent 默认不可变。ActivationProfile 和 CompiledProcedure 的更新通过新版本提案完成，不能原地改写历史证据。

## 7. 渐进程序化生命周期

### 7.1 慢路径练习

初期始终读取完整 `SKILL.md`。系统观察同一父 Skill 在不同真实任务中的步骤、参数、判断点、结果与失败。

### 7.2 稳定片段提取

只从多条可归因轨迹中识别重复子过程。候选片段必须区分：

- 完全确定的步骤；
- 可参数化的步骤；
- 必须保留的 LLM 判断；
- 环境依赖和权限边界；
- 已知失败和适用范围。

首版只允许确定性、可回放、只读或幂等操作，不处理任意自修改代码和不可逆副作用。

### 7.3 独立验证与晋升

在开发轨迹之外的保留任务上做 paired replay：

```text
原始 SKILL.md 慢路径
vs.
候选 CompiledProcedure 快路径
```

晋升必须同时满足：

- 任务成功率或结果质量非劣；
- 错误进入快路径的比例在冻结阈值内；
- 运行时守卫与后置条件能发现越界；
- token、模型调用、延迟或总费用存在可测改善；
- 权限、隐私和回退测试全部通过。

这些条件是硬门槛，不能压成互相抵消的综合分。

### 7.4 运行时解析

```text
父 Skill 已选中
  → 查找绑定当前 source/dependency fingerprint 的 active procedure
  → 无候选：SKILL.md 慢路径
  → 有候选但条件不满足：SKILL.md 慢路径
  → 多个候选无法确定：SKILL.md 慢路径
  → 条件满足：独立授权检查 → 快路径
  → 守卫/不变量/后置条件失败：停止快路径 → 分类失败 → 有界慢路径
```

回退不是“撤销”。首版限制只读/幂等操作，避免快路径部分执行后，慢路径重复产生不可逆副作用。

### 7.5 反例再巩固

失败只允许修改能够归因的最小边界：缩小 `applicable_when`、增加守卫、恢复 LLM hole、局部重编译、降级或废弃 procedure。不得用一次模糊失败重写整个 Skill。

## 8. 版本失效与安全

Procedure 的有效性取决于它实际依赖的版本：

- Skill source 或语义约束变化：必须失效。
- 工具 schema、权限或 effect class 变化：必须失效。
- 相关环境前提变化：运行时拒绝快路径或重新验证。
- Procedure 含 LLM hole 时，相关模型或 prompt 变化：必须重新验证。
- 纯确定性 procedure 不机械绑定无关模型版本，但仍绑定其真实工具和环境依赖。

熟练度永远不能降低授权要求。删除、发送、付款、凭据和其他高风险 effect 即使历史上成功多次，也必须逐次经过独立 authorization gate。prediction error 是事后信号，不能撤销已经发生的伤害。

## 9. 研究问题与评价指标

核心研究问题：

1. 多次真实使用是否能比安装时立即编译更准确地识别可程序化边界？
2. 如何区分稳定步骤、参数变化、LLM hole 与环境偶然性？
3. 多少、何种分布的 held-out shadow replay 证据足以让 procedure 从 `draft` 依次晋升到 `validated`、`canary` 和 `active`？
4. 守卫、版本失效和回退能否控制快路径造成的回归？
5. 经验化 ActivationProfile 能否在不产生自强化偏差的情况下改善 discovery？
6. 编译、验证和失败回退成本需要复用多少次才能回本？

主要优化目标：

```text
Cost per Successful Skill Invocation
=
discovery 与候选注入成本
+ SKILL.md 阅读和 LLM 推理成本
+ 编译与验证的摊销成本
+ procedure 执行成本
+ 失败回退成本
────────────────────────────
成功调用次数
```

质量、安全和权限是硬约束，不是可以用成本收益抵消的软指标。

评估必须分层：

1. Catalog/安全：身份、scope、不可调用标记、权限和 source hash。
2. Discovery：Recall@K、set recall、no-skill、跨语言、hard confuser、索引和查询成本。
3. Selection：Top-K cards 与全量 descriptions comparator 下的 exact-set match、token 和延迟。
4. Resolver：eligibility precision、错误快路径率、正确失效率和正确回退率。
5. 执行：成功率、结果质量、成本、p50/p95、模型与工具调用数、fallback recovery rate。
6. 生命周期：污染、跨 scope 泄漏、权限绕过、版本漂移、降级和 rollback。

## 10. 阶段与退出条件

本节与[双记忆实施计划](../plans/2026-08-14-dual-memory-implementation-plan.md)的 Phase 0—7 一一对应。下面只定义研究阶段边界；具体任务、依赖、验收命令、anti-pattern guard 和 Gate 以实施计划为唯一实施依据。任何下游 active path 都不得越过上游 Gate。

### Phase 0 文档发现结果与未决 API

核验宿主 lifecycle、tool、prompt、storage、permission 与 project-local adapter 能力，冻结允许 API、源码根目录、测试命令、`skill_id` 策略、pilot Skill 和 verifier。Gate P0：实施计划列出的六项交付物均有文件证据；否则只能继续设计与 fixture。

### Phase 1：Registry 与静态 Prompt 外 Discovery

建立不可变 `SkillRecord` Registry、FTS/BM25 索引和有限候选卡，支持 single/multi/no-skill；全量 catalog 只留在 prompt 外与离线 comparator。Gate P1：project-local shadow 与候选注入测试通过，无 Router LLM、无日常环境写入。

### Phase 2：Practice Store 与证据治理

只记录慢路径及后续快路径的 append-only、可归因、脱敏、分区证据，不在运行时自动调权或编译。Gate P2：归因、隔离、删除与污染测试通过，且 pilot Skill 有可回放慢路径事件。

### Phase 3：已有 Skill 的离线部分编译与晋升

从多个可归因 PracticeEvent 生成绑定父 `skill_revision` 的最小 `CompiledProcedure` draft，并用独立 held-out shadow replay 验证。Gate P3：至少一个 procedure 达到 `validated`，质量、安全、成本、依赖指纹、证据和回退点齐全；不得直接 active。

### Phase 4：Execution Resolver、Guard 与安全回退

在父 Skill 已选中后解析慢/快路径，对 validated procedure 做 project-local canary；所有 revision、依赖、条件、授权、守卫或结果失配都必须安全停止并回到父 Skill 慢路径或 abstain。Gate P4：canary 的安全、回退和恢复测试通过，才能提出真实宿主部署申请。

### Phase 5：版本生命周期、失效、降级与回滚

实现 `draft → validated → canary → active → suspended → retired`、依赖差异失效、上一稳定 revision 与证据级联删除。Gate P5：全部失效矩阵与 rollback 测试通过。

### Phase 6：经验化 Activation Memory

在 Phase 1 静态 discovery 可用且 Phase 2 Practice 数据可信后，离线生成可追溯 cue，并仅以软 rerank/扩展进入 shadow；该阶段不阻塞程序化主线。Gate P6：ActivationProfile 在 shadow 与 held-out 回放均达到预先冻结门槛，且可关闭 overlay 无损恢复静态基线。

### Phase 7：系统验证与多 Agent 交接

按 Catalog/安全、Discovery、Selection、Resolver、Execution、Lifecycle/Security 分层验证，补齐实际构建与测试命令、成本报告、失败分类、未解决风险和工作流交接边界。Gate P7：实施计划要求的证据包完整，所有未验证项明确标注，不以设计合同冒充宿主能力。

跨 Skill procedure 组合、任意写操作、自动创造新 Skill、动态 cluster 和额外 Router LLM 均不属于首轮实施。

## 11. 新颖性边界

不能声称新颖的单项包括：

- progressive disclosure；
- 从轨迹提炼程序性记忆；
- 把技能表示成代码或程序；
- activation / execution / termination 条件；
- 技能验证、更新和淘汰；
- 本地检索后注入候选。

本项目当前只提出一个待验证的系统假设：

> 对用户已经安装的 Skill，真实、可归因的使用经验是否能逐渐扩大或收缩其部分程序化边界；同时以独立的 Activation Memory 改善发现，以版本化 Procedural Memory 降低执行成本，并在依赖、权限、守卫或结果不变量失配时可靠恢复原始 Skill 慢路径。

该组合是否具备论文级新颖性仍未知。在完成系统文献、开源产品、专利检索和逐项 claim chart 前，只能称为研究方向，不能称为首创机制。

## 12. 与历史材料的关系

- [相关工作](2026-08-14-skill-cortex-related-work.md)继续作为现有机制与 claim 边界证据。
- [对抗性审查](../reviews/2026-08-14-skill-cortex-audit.md)中的安全、归因、版本和 benchmark 条款继续有效。
- [旧版讨论稿](2026-08-14-learning-skills-into-programs.md)记录了从 routing-only 到“轨迹创造新 Skill”的中间纠偏，但其研究对象和阶段不再有效。
- [ADR-0006](../adr/0006-dual-memory-skill-architecture.md)、[ADR-0007](../adr/0007-prompt-external-skill-discovery.md)和[ADR-0008](../adr/0008-practice-evidence-and-procedure-promotion.md)是当前有效决策；[ADR-0005](../adr/0005-benchmark-data-boundary.md)继续约束评测数据，ADR-0001 至 ADR-0004 仅保留为历史。
