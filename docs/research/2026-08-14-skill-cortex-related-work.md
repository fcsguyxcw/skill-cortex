# Skill Cortex：相关工作与新颖性边界

日期：2026-08-14  
范围：仅核对已读的一手来源；本文不主张“首创”。  
状态：相关工作快照；研究对象已更新

> [!NOTE]
> 当前研究对象已收窄为：**用户已经安装的 Skill，经过真实、可归因的反复使用后，逐渐形成部分 CompiledProcedure；Activation Memory 与 Procedural Memory 分别演化。** 本文关于 progressive disclosure、轨迹记忆、验证、版本和回退的先行工作仍有效；涉及 routing-only 主阶段或“轨迹创造新 Skill”的表述不再定义项目范围。当前规范见[已安装 Skill 的经验引导式渐进程序化](2026-08-14-experience-guided-installed-skill-proceduralization.md)。

## 结论

原构想应拆成三个独立问题：**技能发现、技能执行、经验巩固**。现有证据支持按需加载、轨迹到程序性记忆、技能池更新以及动态候选数；但它们都不是新机制。尤其 Skill-Pro 已公开“激活条件—执行过程—终止条件”、语义梯度、候选验证和评分淘汰，直接重画了新颖性边界。

目前仍可能有研究价值的是一个尚待验证的组合：**针对用户已经安装的声明式 Skill，以真实、可归因的使用经验逐渐识别并验证可程序化的稳定子过程；把“何时发现”与“选中后自动执行多少”分别保存为独立的 Activation Memory 和 Procedural Memory；任何 revision、依赖、权限、守卫或结果失配都安全恢复父 `SKILL.md + LLM` 慢路径。** 候选贡献重心是这种经验引导式部分程序化、双记忆解耦与安全回退的联合生命周期，而不是新 Router。该组合仍必须经过更完整的文献、产品和专利检索后才能表述为贡献。

## Sources consulted 与 concrete findings

| 来源（版本/时间） | 读到的机制 | 与 Skill Cortex 重叠 | 关键差异与边界 |
|---|---|---|---|
| [Anthropic：Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)，2025-10-16 | 启动时只放所有技能的 `name + description`；相关时读完整 `SKILL.md`；再按需读引用文件。官方明确称其为 progressive disclosure。 | “技能神经元→完整技能→附属资料”的三层加载几乎完全重叠。 | 渐进披露、文件化技能与按需加载不能作为新颖性声明。它没有解决超大且高度相似技能库中的召回、版本晋升或异常降级。 |
| [How Many Tools Should an LLM Agent See?](https://arxiv.org/abs/2605.24660)，arXiv:2605.24660，2026-05 | 用 Bits-over-Random 评价并学习逐查询候选深度。在 BFCL 中平均展示约 7 个工具即可接近展示 50 个的覆盖；下游实验显示短自适应列表提高“金工具已出现时”的选择准确率。 | 为未来按查询扩缩候选集提供依据。 | 论文主要研究正确工具是否被展示，参数调用与执行正确性不在范围；动态候选深度是未来可选优化，不属于当前 MVP，也不能据此证明整个 Agent 成功率一定提高。 |
| [Skill-Pro](https://arxiv.org/abs/2602.01869)，arXiv:2602.01869v3，2026-05-28；[官方仓库](https://github.com/Miracle1207/Skill-Pro) | Skill-MDP 将技能定义为激活条件、自然语言执行过程和终止条件；按轨迹分别归因并产生语义梯度，批量聚合；PPO Gate 用历史轨迹上动作似然与优势验证候选；评分并淘汰低效技能。 | 与“何时调用—如何执行—何时退出”“从经历巩固技能”“验证后晋升”“低效技能淘汰”高度重叠。 | 其选择器固定且简单；执行过程仍是自然语言，不是编译代码；PPO Gate 是历史轨迹上的反事实代理，不等于持出任务重放；未给出事务化版本回滚，也没有明确的运行时 surprise→逐层降级协议。 |
| [Memp](https://arxiv.org/abs/2508.06433v4)，arXiv:2508.06433v4，2026-04-15 | 将轨迹蒸馏为细粒度步骤与高层脚本，系统比较 Build/Retrieve/Update；支持新增、修改、删除与废弃。完整轨迹和抽象脚本组合通常最好；检索过多会因上下文与错误记忆干扰而下降。 | “经历→显式步骤→抽象程序”“持续修订与废弃”均已覆盖。 | 检索主要依赖向量相似度和手工 key，且依赖基准奖励；没有正文感知路由、严格反馈归因、版本谱系和回滚保证。 |
| [LEGOMem](https://arxiv.org/abs/2510.04851)，arXiv:2510.04851，2025-10；AAMAS 2026 | 将成功轨迹拆成可复用程序性单元，并按角色分配给多 Agent：编排器记忆服务于分解/委派，执行者记忆服务于子任务执行。 | 覆盖“模块化技能”“多 Agent 各层拥有不同程序性记忆”。 | 角色感知、多 Agent 技能分配不能作为新意；它未统一大规模路由、编译快路径、异常反编译和可回滚技能治理。 |

## 允许采用的机制与尚属假设的机制

### Allowed：已有证据，可作为工程组件

- 保留小规模 **full-description baseline**；大规模时采用检索后渐进披露，而不是默认把全部正文放入上下文。
- 当前 MVP 使用冻结的有限候选预算，并分别测量“召回到候选集”和“模型从候选中选对”。动态候选深度只作为未来可选优化，须由固定预算的具体失败证据触发，不进入当前默认路径。
- 程序性记忆同时保存抽象脚本与必要的具体轨迹；更新必须支持新增、修改、废弃。
- 技能至少显式建模激活、执行和终止；晋升前使用外部可观测结果验证，而不是只相信模型自评。
- 多 Agent 场景按编排职责和执行职责分配技能，但共享来源、版本与评测记录。

### Hypothesis：必须实验，不得当成事实

- 紧凑 `Skill Neuron` 比完整 description 路由更准；现有五个来源没有证明这一点。它最多是缓存索引，不应成为唯一证据。
- `context cost ≈ novelty × uncertainty × risk` 是预算启发式，不是认知科学公式；需给三项定义可测代理并做消融。
- negative cues/`avoids` 会独立提升准确率；软负例若硬过滤，可能造成召回遗漏。
- 已安装 Skill 的部分 procedure 在 revision、依赖、权限、守卫或结果不变量失配后安全恢复父 `SKILL.md + LLM` 慢路径，能否在保持安全与质量非劣时降低摊销成本；这是核心待证假设。
- 单次成功轨迹足以生成全局技能；应以多次、持出和跨任务证据替代。

## 新颖性声明边界

不可声明：progressive disclosure、trajectory-to-skill、激活/执行/终止三元组、技能验证/淘汰、角色化程序记忆本身。

可暂时使用的保守表述：

> 我们研究用户已安装 Skill 的经验引导式部分程序化：真实、可归因证据只为父 Skill 产生受约束的 `CompiledProcedure`；Activation Memory 与 Procedural Memory 独立演化；procedure 经独立验证与 canary 后才可 active，并在 revision、依赖、权限、守卫或结果不变量失配时恢复父 `SKILL.md + LLM` 慢路径。该联合生命周期的优势与新颖性仍需消融和更完整的先前技术检索验证。

## Copy-ready snippet locations

- 主设计的“纠错与范围”可直接引用“结论”和“新颖性声明边界”。
- Discovery 方案可引用来源表前两行；其中动态候选深度只作为未来可选方向，不是 MVP。
- 巩固/生命周期方案可引用 Skill-Pro、Memp、LEGOMem 三行。
- 风险清单与实验待办可直接引用 Hypothesis 全节。

## Confidence + known gaps

- **高置信**：Anthropic 已实现三层渐进披露；Skill-Pro v3 已覆盖激活/执行/终止及验证淘汰；Memp v4 已覆盖 Build/Retrieve/Update；LEGOMem 已覆盖角色化程序记忆。
- **中置信**：动态候选深度在特定工具选择实验中优于固定深度具有直接支持，但执行成功、长尾多技能组合和不同模型上的普适性仍未建立；因此它是未来可选优化，不是当前 MVP 或候选贡献。
- **低置信/缺口**：尚未完成系统综述、专利与商业产品检索；未发现不等于不存在。五个来源没有联合评测路由召回、执行成功、上下文成本、污染、降级恢复与版本回滚。因而当前只能提出“待验证的系统组合”，不能声称新的认知架构或生物等价机制。
