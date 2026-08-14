# Skill Cortex / Progressive Skill Activation 对抗性架构审查（历史快照）

日期：2026-08-14。性质：历史 Phase 0 审查，不是当前实施依据、实现证明或首创声明。

> [!WARNING]
> **历史审查快照。** 本文“routing-only MVP”“已选 MVP”和相关阶段决定已被替代，不再代表当前路线；权限、持久化污染、归因、版本失效、安全回退和评测分层等风险结论继续有效。当前范围以[已安装 Skill 的经验引导式渐进程序化](../research/2026-08-14-experience-guided-installed-skill-proceduralization.md)为准。

## 历史已确认决策（已失效，2026-08-14）

- 第一阶段冻结为 **routing-only MVP**。
- 路由器只决定候选技能集合及其组合；技能被选中后直接加载完整 `SKILL.md`。
- 不增加 `description → schema → SKILL.md` 的文本深度控制层。
- habit compiler、procedure、episode consolidation 和执行自治深度均不属于第一阶段。
- 第一阶段只检验：在保持或提高正确技能覆盖率与最终选择准确率的前提下，能否减少常驻技能 metadata 和无关候选。
- 实现边界采用 **通用路由核心 + Pi shadow adapter**；核心数据契约不得依赖 Pi 类型，shadow 阶段不得改变 Pi 的真实路由、prompt 或工具调用。
- 路由机制采用 **全量 description baseline + Shadow Local Retriever**：真实路径保持不变；shadow 只运行本地 FTS/BM25。第一版不使用 Router LLM、能力层、cluster、竞争式打分或运行时动态级联。
- 晋升原则采用 **成本下降、准确率非劣**：候选覆盖、主 Agent 最终选择、metadata token 和检索延迟必须分项报告，不使用加权总分掩盖回归。
- 晋升证据只使用 **人工复核 Gold Set**；Pi shadow 查询只用于分布观察，LLM 合成数据只用于规模与吞吐压力测试。

## 历史路线结论（已失效）

方向可继续，但当前版本不能直接上线“自动学习 + compiled habit 自动执行”。它把技能检索、技能表示、经验学习和执行控制混成了一个五层模型。建议改成：**skill 是稳定 ID 下的不可变版本，同时拥有 compact manifest、完整过程、episode 证据和可选 compiled artifact；控制器按需选择表示。** L3 episode 是证据库，L4 novel reasoning 是 fallback，不是 skill 所在的层。

首个 MVP 已确认只验证自适应路由：在现有约 132 个真实 skill 上测量调用准确率、复合任务覆盖率、no-skill 误触发和尾部成本；自动 consolidation 与 habit 放到未来独立实验。

## Sources consulted

- 冻结对话 `chatgpt-conversation://6a79304f-63c4-83e8-8ce2-628d0da2dca2` 及任务中补齐的机制摘要：L0-L4、Skill Genome、Activation Field、top-3/top-10 fallback、prediction error、sleep consolidation、10/100/1k/10k 比较。
- 本机 baseline：`C:\Users\a1324\.pi\agent\extensions\skill-router.ts` 当前为 keyword `search_skills` + exact `load_skill`；`directory.ts` 的 system prompt 只放 category/scope/name。仓库 clean，HEAD `341747a`。
- 已核验约 132 skills：native name+description+path 约 61,506 chars；compact name/category 约 2,715 chars，但隐藏 `Code`、`do`、`Memory` 等模糊技能；scope+full-description 约 40,151 chars。
- 定向相关工作：[Anthropic Agent Skills 渐进披露](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)、[自适应工具候选深度](https://arxiv.org/abs/2605.24660)、[Skill-Pro](https://arxiv.org/abs/2602.01869)、[Memp](https://arxiv.org/abs/2508.06433v4)、[LEGOMem](https://arxiv.org/abs/2510.04851)。详细重叠与差异见 `docs/research/2026-08-14-skill-cortex-related-work.md`；这些来源证明相关问题存在，不证明本机制正确或新颖。

当前只验证了 `before_agent_start`、注册工具、`search_skills`、`load_skill`。post-execution hook、持久 episode store、审批、version/rollback、sleep scheduler 均未验证；实施者不得凭名称发明 API。

## Concrete findings

### P0：上线前必须解决

1. **权限绕过。** 熟练度不能降低授权要求。删除、发送、付款、凭据等动作即使成功过十次，也必须逐次经过独立 authorization gate；prediction error 是事后信号，无法撤销伤害。project scope 也不等于可信。
2. **持久化注入与泄漏。** episode 可能含秘密、绝对路径、网页提示注入或 benchmark 答案；sleep cycle 直接提炼会把攻击永久化。episode 必须带 provenance、项目/用户隔离和敏感标记；eval trace 禁止回写；consolidation 只产 proposal，经 secret scan、sandbox replay、held-out regression 和审批后发布。
3. **循环归因。** “任务成功→被选 skill confidence 上升”不成立：成功可能来自基础模型、其他 skill 或偶然状态。把 `confidence` 拆成 `P(relevant)`、`P(preconditions satisfied)`、`P(execution succeeds)`；结果由外部 verifier/postcondition 判定，运行时只记 immutable trace，不自动调权。
4. **版本与回滚缺失。** compiled artifact 必须绑定逻辑 `skill_revision`（代码字段 `skillRevision`）、仅表示内容指纹的 `source_hash`，以及独立的 model、tool schema、permission 与 environment dependency fingerprint。依赖变化先失效，发布走 canary，并可回滚；不能让“同一 skill 移到 L0”后丢失来源。

### P1：会使机制或实验失真

1. `Skill Genome 常驻` 与 10k 目标矛盾：30 tokens × 10k 已约 300k tokens。Genome 只能常驻 prompt 外索引，当前 prompt 仅注入候选。
2. uncertainty、novelty、risk、maturity、cost 都不可直接观测。分别改为校准后的候选覆盖概率、OOD 距离、规则化 effect class、版本化证据状态，以及 tokens/latency/费用/不可逆性成本向量。
3. lateral inhibition 的单赢家不适配复合任务。router 应输出 skill set 或 precondition/effect dependency DAG，并包含 no-skill 类。
4. prediction error 可能来自工具超时、环境漂移、权限拒绝或用户并发，不等于 skill 错。先分类，再决定是否升级；fallback 必须有 token、候选数、tool-call、时间硬上限和合法 abstain。
5. top-30/top-3/top-10 是待调参数，不是机制定律。阈值只能用 dev set 校准。
6. benchmark 必须拆成 router-only 与 end-to-end；固定模型、工具和预算。Cortex 与 embedding baseline 使用相同候选预算曲线；eval 轨迹不得生成 cues。10k full-description 超 context 时记 infeasible，不截断伪造失败；随机 distractor 与 hard confuser 分开报告。

### P2：应消除表述误导

- “sleep/surprise/lateral inhibition”可作比喻，工程名用 consolidate/contract-failure/rerank。
- “编译”必须明确是摘要还是可执行宏；首批只允许确定性、可回放、只读或幂等操作。
- 中文 query/英文 skill、模糊名称、duplicate/alias、问候和简单事实不调用 skill，均需成为正式测试类别。

## 历史已选 MVP（已失效）

采用 **全量 description active baseline + FTS/BM25 shadow retriever**。Shadow 不影响真实行为，只记录固定候选预算下的召回结果和本地成本。Agent 主动搜索、能力层、cluster、竞争式激活、embedding 与 LLM Router 均不进入默认路径；只有具体失败证据才能触发后续机制提案。

## 历史引用位置（不得作为当前实施文本）

- 架构定义：本文“结论”第二段。
- 安全与生命周期约束：P0-1 至 P0-4。
- 可观测路由与复合任务：P1-1 至 P1-5。
- Benchmark contract：P1-6。
- MVP 边界与推荐：表“三个 MVP 方案”。

## 历史已关闭决策点（已失效）

第一阶段已确定优先证明“路由更准且更省”。“Agent 从经验自动形成 habit”已移出 MVP，后续必须作为使用不同数据和验证器的独立研究问题重新立项。

## Confidence + known gaps

- 高：当前 Pi baseline、权限/归因/版本风险、单赢家不适配复合任务。
- 中：hybrid + calibrated adaptive routing 可能优于现状；尚待实验。
- 低：10k 表现、habit 净收益、论文级新颖性。
- 缺口：未枚举完整 Pi ExtensionAPI；无 132-skill 标注 query、复合任务 gold DAG 或外部 verifier；未跑 benchmark；外部材料是定向检索而非系统综述。
