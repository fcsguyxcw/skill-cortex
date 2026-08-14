# 双记忆 Skill 系统：多 Agent 实施计划

状态：Accepted plan — 2026-08-14  
目标：在项目目录内实现并验证 prompt 外 discovery，以及已安装 Skill 的经验驱动、渐进式部分程序化。  
执行方式：每个 Phase 可在新的 Agent 上下文中独立执行；上游 gate 未通过不得启动下游 active path。

## 1. 目标与成功定义

系统必须回答两个相互独立的问题：

```text
Activation Memory：当前任务可能需要哪个已安装 Skill？
Procedural Memory：选中该 Skill 后，本次能安全自动执行多少？
```

最终 MVP 成功需要同时满足：

1. 正式运行不把全量 Skill metadata 注入主 Agent 上下文，也不增加 Router LLM。
2. 已安装 Skill 能通过有限候选卡被发现，并支持 single-skill、multi-skill 与 no-skill。
3. 至少一个真实已安装 Skill 的稳定片段能形成绑定父 revision 的 `CompiledProcedure`。
4. procedure 只有在依赖、适用条件、权限和验证器全部匹配时才运行。
5. 任何失配都能进入父 `SKILL.md + LLM` 慢路径或合法 abstain。
6. Skill 或关键依赖更新后 procedure 自动失效，可降级并回滚。
7. 包含编译、验证和回退摊销后，`Cost per Successful Skill Invocation` 相对慢路径有可测收益，同时成功率和安全约束非劣。
8. 所有实现与测试保持 project-local，不修改用户日常 Pi、Codex、Agent 或已安装 Skill 环境。

## 2. 权威资料与阅读顺序

每个执行 Agent 开工前按根目录 `AGENTS.md` 阅读：

1. `README.md`
2. `docs/adr/0006-dual-memory-skill-architecture.md`
3. `docs/adr/0007-prompt-external-skill-discovery.md`
4. `docs/adr/0008-practice-evidence-and-procedure-promotion.md`
5. `docs/design/dual-memory-data-contracts.md`
6. 本计划

现有可复用证据：

- `docs/reviews/2026-08-14-skill-cortex-audit.md` 的 P0/P1/P2 风险。
- `docs/adr/0005-benchmark-data-boundary.md` 的 Gold/shadow/synthetic 数据隔离。
- `docs/research/2026-08-14-skill-cortex-related-work.md` 的先行工作边界。
- `docs/research/2026-08-14-experience-guided-installed-skill-proceduralization.md` 的当前研究问题。

## 3. Phase 0 文档发现结果与剩余限制

### 3.1 当前已验证实现事实

Phase 0 证据：

- `docs/research/2026-08-14-phase0-pi-api-inventory.md`
- `docs/research/2026-08-14-phase0-project-baseline.md`

当前安装的宿主包为 `@earendil-works/pi-coding-agent@0.84.1`；Node 为 `v24.11.0`，npm 为 `11.6.1`。

只读检查的当前 Pi 扩展：

- `C:\Users\a1324\.pi\agent\extensions\skill-router.ts`
- `C:\Users\a1324\.pi\agent\extensions\skill-router\directory.ts`
- `C:\Users\a1324\.pi\agent\extensions\skill-router\directory.test.ts`
- `C:\Users\a1324\.pi\agent\npm\package.json`

从实际代码确认的可用形状：

- 从 `@earendil-works/pi-coding-agent` 导入 `ExtensionAPI`、`Skill`、`defineTool`、`formatSkillsForPrompt`。
- `pi.registerTool(tool)` 注册 `search_skills` 与 `load_skill`。
- `pi.on("before_agent_start", handler)` 当前可读取并替换 `event.systemPrompt`。
- `before_agent_start` 的 `event.prompt` 是扩展后的原始用户任务文本；不存在结构化 `TaskContext` 类型。
- `event.systemPromptOptions.skills ?? []` 提供当前发现的 `Skill[]`。
- 当前代码读取 `Skill.name`、`description`、`filePath`、`disableModelInvocation` 和 `sourceInfo.scope`。
- `defineTool` 的 `execute` 返回 `{ content, details }`。
- 当前本地测试使用 `node:test` 与 `node:assert/strict`。
- `tool_call`、`tool_result`、`tool_execution_*`、`turn_end`、`agent_end` 与 `agent_settled` 已在当前类型定义中确认。
- project-local 扩展可从 `<cwd>/.pi/extensions/*.ts` 或 `*/index.ts` 加载，项目须先被信任；加载器使用 jiti，不要求写入用户级 Pi 目录。
- 宿主没有内置 sandbox、通用 KV/事务/retention/delete/secret-scan API，也不提供稳定 `skill_id`、`source_hash` 或 move/rename/uninstall 事件。

这些是允许复制的当前模式，不代表项目已验证其他 lifecycle API。

### 3.2 不可用或仍未验证，禁止假定存在

- 宿主持久化、事务、secret scan、用户删除和 retention API：当前版本不存在，使用 project-local store abstraction。
- 内置 sandbox 与集中 permission policy：当前版本不存在；`tool_call` 可 block，但其能否承担项目所需的统一审批语义须在 Phase 4 前实测。
- 宿主提供的稳定 Skill ID、rename/move/uninstall 或依赖变更事件：当前版本不存在，按 Phase 0 冻结的派生身份与重扫 diff 处理。
- `pi.exec` 与 Agent 自带 bash 的权限和 sandbox 等价性仍未验证。
- `ModelRuntime`/`ctx.model` 的精确 LLM 调用签名未验证；Phase 1 的纯本地 discovery 不依赖它。
- project-local 扩展的首次信任交互和并行工具模式下各事件的精确时序尚未运行验证。

实现者不得发明 `ctx.callLLM`、`pi.complete`、`ctx.model.complete` 或任何“应该存在”的事件。

### 3.3 Phase 0 交付物与冻结结果

Documentation Discovery 已完成：

1. Allowed/Unavailable API、准确类型与来源见 Phase 0 Pi API 核验报告。
2. 源码根冻结为本项目；语言为 TypeScript；包管理器为 npm；精确命令见 §12。
3. `skill_id` 由 `scope + normalized absolute baseDir` 的完整 SHA-256 派生；`skill_revision` 由排序后的 dependency manifest 派生；move/rename 按新安装实例处理。
4. 首个 pilot 冻结为 project-local `docx` fixture；首版只覆盖只读验证/分析与项目临时目录内幂等 unpack，使用 OOXML schema 校验和确定性文本回读作为 verifier。
5. Phase 1 不持久化真实 PracticeEvent；Phase 2 只接受 `sensitivity=none`，使用 `retentionClass=project_manual`、显式删除、无自动 TTL、无跨设备同步，应用不提供 at-rest encryption。
6. project-local adapter 可由 `.pi/extensions/` 加载，无需写用户级 Pi 环境；真实宿主部署仍须按精确路径另行授权。

**Gate P0：PASS — 2026-08-14。** 可启动 Phase 1 的 project-local fixture 与 shadow 实现；未验证的审批/sandbox 等价性仍阻塞后续真实 active execution。

## 4. 非功能要求

### Context 与成本

- 全量 catalog 只保存在 prompt 外；主 Agent 只看到候选卡。
- MVP 的额外 Router LLM 调用数必须为 0。
- 分别记录未缓存输入、缓存命中后的边际成本、检索 CPU/存储、主模型、工具、编译验证和 fallback 成本。
- 不预设 p95 或候选数阈值；先在 dev/pilot 冻结，再查看最终测试。

### 可靠性

- Registry、索引、ActivationProfile 或 procedure 不可用时，系统必须有明确的补搜、慢路径或 abstain；不得静默继续错误快路径。
- active procedure 必须可 suspend，上一稳定版本可回滚。
- 未知状态按不满足处理，不得乐观执行。

### 安全与隐私

- 快慢路径使用同一 authorization、scope 与 sandbox 规则。
- Practice Event 默认脱敏、最小化、按用户/项目隔离并可删除。
- Evaluation、synthetic 与真实 trace 分区；eval trace 永不参与学习。
- MVP 禁止不可补偿的非幂等自动副作用。

### 可维护性与可观测性

- schema 与派生产物版本化；日志能关联 route decision、skill revision、procedure revision 和 verifier。
- 相关性、eligibility、execution success 与 failure class 分开报告。
- Ability/category 只能是软字段，不能成为召回必经门。

### 规模边界

- 真实 catalog 用于功能与准确性验收。
- 1k/10k synthetic catalog 只用于索引大小、构建时间、查询延迟和吞吐压力，不用于准确率声明。

## 5. 建议逻辑模块与所有权

Phase 0 已冻结以下 project-local 模块布局与所有权；目录由 Phase 1 按依赖顺序创建：

```text
core/contracts       数据 schema、不变量、序列化
core/registry        Skill ingest、revision、依赖指纹
discovery            prompt 外索引、候选卡、补搜
practice             trace、脱敏、隔离、retention
procedures           候选生成、artifact、验证与版本
runtime              resolver、guard、fallback、rollback
adapters/pi           已验证宿主 API 的薄适配层
evaluation           fixtures、paired replay、安全与成本报告
```

多 Agent 文件所有权：

| Workstream | 独占责任 | 不得修改 |
|---|---|---|
| A Contracts/Registry | schema、ID/revision、序列化、依赖指纹 | 检索算法、运行时执行 |
| B Discovery | 索引、候选卡、supplemental search | procedure 与 Practice 数据 |
| C Practice/Security | observer、脱敏、隔离、删除、失败分类 | ranking 与 compiler |
| D Procedure | 部分编译、artifact、验证输入 | discovery ranking、宿主 hook |
| E Runtime | resolver、guard、fallback、invalidation | compiler 生成逻辑 |
| F Evaluation | fixtures、baseline、paired report、安全回归 | 生产逻辑，除测试 seam 外 |

共享类型只能由 Workstream A 修改；其他 Agent 提交 contract change proposal，不能并发改 schema。

## 6. Phase 1：Registry 与静态 Prompt 外 Discovery

### 目标

在 project-local fixture/adapter 中建立不可变 `SkillRecord` Registry，并在主 Agent 第一次相关推理前自动产生有限候选。全量 metadata 只留在外部索引和离线 baseline。

### 实施任务

1. 从 Phase 0 允许的宿主 discovery 结果复制 `Skill` ingest 模式，保留 scope 并过滤 `disableModelInvocation`。
2. 按数据合同生成稳定 `skill_id`、`skill_revision`、`source_hash` 与 dependency manifest。
3. 以作者 `name + complete description` 建立确定性的本地 FTS/BM25 索引。
4. 自动检索 Top-K，并生成包含完整可区分 description 的 `SkillCandidate` 卡。
5. 支持 single、multi 与 no-skill；保留 `search_skills` 作为补搜/诊断，不作为唯一主入口。
6. 先 shadow 记录候选；验收后才允许候选卡进入 project-local 模拟主 Agent。真实 Pi 部署不在本 Phase 授权范围。

### 文档引用

- ADR-0007：Registry、自动候选、补搜、第一版排除项。
- 数据合同 §3、§4.1、§4.2。
- 现有 `skill-router.ts`：`updateIndex`、scope precedence、`disableModelInvocation` 与 `defineTool` 返回形状。

### 验证

- [ ] 同一输入 catalog 的 ID、revision、索引和排序确定。
- [ ] 同名不同 scope/path 不混淆。
- [ ] 全量 catalog 不出现在模拟主 prompt；仅 Top-K 卡进入。
- [ ] Router LLM 调用数为 0。
- [ ] 至少覆盖 single、multi、no-skill、中文 query/英文 description、模糊名称和 hard confuser。
- [ ] `search_skills` 能补搜但不会返回全量目录。
- [ ] 报告 Recall@K/set recall、no-skill、注入 token、索引成本和 p50/p95；集成 smoke 不宣称统计普适性。

### Anti-pattern guards

- 不复制现有硬 CATEGORY_RULES 作为召回门。
- 不让调用次数、maturity 或 procedure 数量参与排序。
- 不因词法召回不足直接加入 Router LLM；先记录失败类别。
- 若宿主没有可用的 pre-agent task hook，停止 active 自动检索设计，不通过篡改日常 Pi prompt 绕过。

Gate P1：project-local shadow 与候选注入测试通过；正式环境仍无写入。

**实施状态：PASS — 2026-08-14。** 证据见 `docs/reports/2026-08-14-phase1-gate-report.md`。默认 Pi 入口保持 shadow；真实 installed Skill 的作者 alias 解析仍是已知限制，不得用 synthetic alias smoke 冒充真实跨语言能力。

## 7. Phase 2：Practice Store 与证据治理

### 目标

记录慢路径和未来快路径的可归因证据，但不在运行时自动调权或编译。

### 实施任务

1. 仅使用 Phase 0 验证的 lifecycle/tool observation API；没有 hook 时用 replay harness 产生 fixture，不发明事件。
2. 实现 append-only `PracticeEvent`，按冻结合同记录父 Skill revision/source hash、候选与最终选择、执行模式、依赖指纹、脱敏步骤、authorization/guard/verifier 结果、failure class 与首个可归因失败步骤。
3. 实现真实/shadow/evaluation/synthetic 分区，用户/项目 scope 隔离，以及可测试的 retention/delete seam。
4. 建立 secret/PII 检查与最小化规则；默认不保存原始任务、完整文件或工具输出。
5. 只产生 observation；任何 Activation 或 Procedure 变化都是离线 proposal。

### 文档引用

- ADR-0008：Practice Event、归因、数据治理。
- 数据合同 §4.4、§7。
- 历史 audit P0-2、P0-3 与 P1-4。

### 验证

- [ ] Event append 后不可原地修改。
- [ ] source hash、候选/最终选择、依赖、authorization、guard 与首个失败步骤按数据合同序列化并通过 round-trip 测试。
- [ ] Evaluation/synthetic event 无法进入生产 proposal 查询。
- [ ] 未经 verifier 的成功保持 `mixed` 或 `unknown`，不能成为 Skill 成功。
- [ ] 秘密、凭据、绝对敏感路径和完整用户文本不会默认落盘。
- [ ] 用户/项目隔离、删除与级联 evidence 失效有测试。
- [ ] 工具、权限、环境和用户中断被分类，不一律归因给 Skill。
- [ ] boundary/external failure 只保留为 event/proposal evidence，未经 discovery 回放转换不得进入 active profile。

### Anti-pattern guards

- 不把当前 Agent 选择当 gold label。
- 不直接保存任意网页内容并用于 consolidation。
- 不在真实运行回调内生成或发布 procedure。
- 未验证宿主持久化 API 时，只用 project-local store abstraction/fixture。

Gate P2：证据治理与删除测试通过，且至少一个 pilot Skill 有可回放的慢路径事件。

**实施状态：PASS — 2026-08-14。** 证据见 `docs/reports/2026-08-14-phase2-gate-report.md`。当前 pilot 是 `evaluation` observation replay，所有未执行的授权、守卫、步骤和 verifier 保持 `unknown`；不得表述为真实 docx verifier 或宿主 observer 已可用。

## 8. Phase 3：已有 Skill 的离线部分编译与晋升

### 目标

针对一个符合条件的已安装 Skill，从多次可归因使用中提取稳定片段，生成但不直接激活 `CompiledProcedure`。

### Pilot 选择门槛

- 操作只读或幂等；
- 输入、环境和工具依赖可枚举；
- 有外部可观测 postcondition/verifier；
- 存在多个真实任务变体与边界反例；
- 用户安装 Skill 保持只读，实验使用项目内复制 fixture。

证据次数和 held-out 大小由 Evaluation Owner 在查看候选 procedure 结果前冻结，不在本计划臆定统一数字。

### 实施任务

1. 把父 `SKILL.md` 条款映射到执行步骤，标出稳定片段、动态参数、`llm_holes` 与禁止自动化步骤。
2. 选择最小 artifact 表示：受限 DSL 或参数化脚本；选择理由单独记录，不允许任意自修改代码。
3. 生成带输入 schema、父条款映射、禁止自动化步骤、前置/runtime guard/后置条件、权限、effect、dependency fingerprint 与 provenance 的 draft。
4. 在隔离 replay 中比较完整 Skill 慢路径与 draft；训练/提炼实例和 held-out 实例分离。
5. 计算完整成本：生成、验证、执行、LLM holes、失败回退与重验。
6. 只有 ADR-0008 全部硬门通过才进入 `validated`；先 canary，不直接 active。

### 文档引用

- ADR-0006：Procedural Memory 边界。
- ADR-0008：proposal、promotion gates、runtime 失效原则。
- 数据合同 §4.5、§6.2。
- 当前研究说明中“渐进部分程序化”与两个相邻方向的区分。

### 验证

- [ ] Procedure 绑定父 Skill revision，不能独立注册为 Skill。
- [ ] 每个 covered step 能追溯父条款与 Practice evidence。
- [ ] 禁止自动化步骤不能进入 artifact 可执行路径；每个 runtime guard 明确绑定检查前的 step。
- [ ] `llm_holes` 有受限输入与结构化输出，未伪装成确定性步骤。
- [ ] 权限/effect 是父 Skill 允许集合的子集。
- [ ] held-out paired replay 报告修复、回归、失败与成本，不只报平均 token。
- [ ] `N_break-even` 使用实测成本计算：

```text
N_break-even = 编译与验证总成本
               / (慢路径单次成本 - 快路径单次成本 - 预期回退成本)
```

### Anti-pattern guards

- 不从一次成功轨迹发布 procedure。
- 不强制编译整个 Skill。
- 不让 LLM 自评替代外部 verifier。
- 不用成本收益抵消成功率、安全、授权或回退回归。

Gate P3：一个 procedure 达到 `validated`，完整证据、回放报告和上一稳定回退点存在。

## 9. Phase 4：Execution Resolver、Guard 与安全回退

### 目标

Skill 被选中后，正确解析 procedure 快路径或父 Skill 慢路径；所有异常有界、可解释且不重复不可逆副作用。

### 实施任务

1. 实现 `resolveExecution` 逻辑：revision、dependency、precondition、effect 与授权检查。
2. 实现 `ExecutionDecision`，明确 mode、reason、checked predicates 与 fallback。
3. canary 执行 validated procedure，逐步开放；不能跳过独立验证或 canary。Shadow replay 可以作为验证方法，但不是 Procedure 状态。
4. 每步执行必要 guard；完成后调用 postcondition/verifier。
5. 失败时安全停止，加载父 `SKILL.md` 或 abstain，并写入首个可归因失败步骤。
6. 为 fallback 冻结 token、tool-call、时间和副作用预算。

### 文档引用

- ADR-0008：“Runtime resolution、fallback 与失效”。
- 数据合同 §4.6、§6.2。
- Audit P0-1、P1-4、P2 的低风险 MVP 边界。

### 验证

- [ ] 无 procedure、revision mismatch、dependency mismatch、未知条件均走慢路径。
- [ ] 只有全部 guard 为真才进入快路径。
- [ ] 快慢路径使用同一 authorization gate。
- [ ] verifier failure 会 suspend/canary fail，不在当前调用自我修改并发布。
- [ ] fallback 恢复率、错误进入快路径率和正确拒绝率分开报告。
- [ ] 模拟重复调用证明没有重复非幂等副作用；MVP fixture 本身不得含此类操作。

### Anti-pattern guards

- 不把 procedure exception 直接解释成 Skill 错。
- 不在失败后无界展开 prompt、候选或工具循环。
- 不在 fallback 中静默忽略已发生 effect。
- 不修改用户日常 Pi 环境做 canary。

Gate P4：project-local canary 通过安全、回退与恢复测试，才能提出真实宿主部署申请。

## 10. Phase 5：版本生命周期、失效、降级与回滚

### 目标

让派生产物在来源和依赖变化时安全失效，并提供可审计晋升、降级和 rollback。

### 实施任务

1. 为 source、tools、permissions、environment 与含 LLM hole 的 model/prompt 计算相关指纹。
2. 实现 dependency diff；只失效相关 procedure，不让纯确定性 artifact 因无关模型变化失效。
3. 实现 draft/validated/canary/active/suspended/retired 状态机与非法转换检查。
4. 实现 previous stable revision、rollback 和 evidence cascade deletion。
5. Skill 卸载、scope 变化、同名冲突、move/rename 按 Phase 0 身份策略处理。

### 文档引用

- 数据合同 §3、§6、§8。
- ADR-0008 的失效与回滚要求。
- Audit P0-4。

### 验证

- [ ] 修改父 Skill/source 使所有绑定旧 revision 的 procedure suspend。
- [ ] tool schema/permission 变化只失效相关 artifact。
- [ ] 含 LLM hole 的 model/prompt 变化触发重验。
- [ ] active 版本可一键回滚；无稳定版本时走慢路径。
- [ ] 删除 evidence 会使依赖它的 cue/procedure 重新评估或 suspend。

### Anti-pattern guards

- 不静默补全旧 schema 缺失的 guard 或权限。
- 不允许 active artifact 原地修改；修订产生新 revision。
- 不在依赖 mismatch 时“先跑一次看看”。

Gate P5：全部失效矩阵与 rollback 测试通过。

## 11. Phase 6：经验化 Activation Memory

### 目标

在静态 discovery 已可用、Practice 数据可信后，使用可归因证据改善 aliases、跨语言表达、正例、near-miss 和环境 cues。该阶段不阻塞程序化主线。

### 实施任务

1. 只从 `verified_skill_effect` 和明确 near-miss/boundary evidence 生成 draft cue。
2. 作者 metadata 与 learned overlay 分栏；每个 cue 有 evidence、revision、retention 和删除链。
3. 在 shadow 中对静态 FTS/BM25 结果软 rerank 或扩展，不做硬负过滤。
4. 对照静态 discovery，分栏评估 hard confuser、no-skill、multi-skill 和跨语言。
5. 达到非劣门槛后进入 active；任何退化可关闭 overlay 无损回到静态索引。

### 文档引用

- ADR-0006 的 Activation Memory。
- ADR-0007 的索引与 first-version exclusions。
- ADR-0008 的 evidence attribution。
- 数据合同 §4.3、§6.1。

### 验证

- [ ] Learned cue 不覆盖作者字段。
- [ ] 调用频率、procedure maturity 和成本不参与 relevance。
- [ ] 每个 cue 可追溯、删除并按父 revision 重验。
- [ ] Recall@K/set recall 非劣，no-skill 与 hard-confuser 不退化。
- [ ] 关闭 overlay 后静态 discovery 结果可复现。

### Anti-pattern guards

- 不把 negative cue 变成召回前硬过滤。
- 不用当前 router 选择训练自己而没有独立 verifier。
- 不因“更像人类”跳过测量和版本治理。

Gate P6：ActivationProfile 在 shadow 和 held-out 回放均达到预先冻结门槛。

## 12. Phase 7：系统验证与多 Agent 交接

### 分层验证

1. Catalog/安全：scope、禁用标记、权限继承、稳定 revision、完整失效。
2. Discovery：Recall@K/set recall、no-skill、hard confuser、跨语言、索引与 prompt 成本。
3. Selection：同一主模型在候选卡和离线全量 baseline 下的 exact-set match、token 与延迟。
4. Resolver：eligibility precision、错误快路径率、正确慢路径率和理由准确性。
5. Execution：成功率、`Cost per Successful Skill Invocation`、LLM/tool 次数、p50/p95、fallback recovery。
6. Lifecycle/Security：污染、跨 scope 泄漏、权限绕过、版本漂移、rollback、未知状态和重复副作用。

### 最终命令与证据

Phase 0 已冻结以下命令；Phase 1 创建 `package.json` 后必须首次实测并回写退出码：

```text
Node: v24.11.0
npm: 11.6.1
TypeScript devDependency: 5.9.3（精确版本）
安装: npm install
测试: npm test            # package script: node --test
类型/构建门: npm run typecheck  # package script: tsc --noEmit
lint/format: MVP 不引入独立命令
```

Phase 1 实测状态：`npm install --ignore-scripts --cache .npm-cache` 成功，240 packages、0 vulnerabilities；`npm test` 为 100 tests / 99 pass / 0 fail / 1 permission-related skip；`npm run typecheck` 退出码 0。最终报告至少附：

- 安装/构建命令与版本；
- 单元、合同、集成、安全和 replay 命令及退出码；
- lint/format/type-check 命令；
- prompt/cost 报告；
- failure taxonomy 与未解决 case；
- `rg` 反模式检查：Router LLM、硬 Ability gate、maturity ranking、外部写路径、未验证 API 名称。

### 交接格式

每个 Agent 完成时必须报告：

```text
Ownership:
Files changed:
Docs/API sources followed:
Commands run:
Verification results:
Known failures or unverified assumptions:
Downstream work now unblocked:
```

### 最终退出条件

- [ ] 所有 ADR、数据合同和代码行为一致。
- [ ] `AGENTS.md` 的 project-local 约束有自动或人工检查证据。
- [ ] 没有未记录的外部写入、真实环境 mutation 或权限扩张。
- [ ] 至少一个 Skill 完成慢路径证据、部分编译、validated canary、fallback 和版本失效闭环。
- [ ] Discovery 与程序化分别报告，不用综合总分掩盖任一回归。
- [ ] 未验证 API、未知阈值和未来研究明确留在 backlog，而非伪装成已完成能力。

## 13. 明确不在 MVP

- 从自由轨迹自动创造全新 Skill。
- 安装时一次性编译整个 `SKILL.md`。
- 额外 Router LLM、硬 Ability tree、固定“认知深度”级联。
- 跨 Skill 自动 procedure composition。
- 任意自修改代码、不可逆写操作和自动权限扩张。
- 生产环境自动发布、跨用户经验共享和跨设备同步。
- 论文级新颖性声明；必须先完成定向 claim chart、系统综述及必要的产品/专利检索。

## 14. 关键风险与停止条件

| 风险 | 发现信号 | 停止/降级 |
|---|---|---|
| 宿主无 pre-agent task hook | 无法在主推理前取得合法 TaskContext | 停止 active auto-discovery；保留补搜工具与离线原型 |
| 无可靠 post-execution/tool hook | 轨迹不完整、无法归因 | 不做自动 Practice capture；只用 replay fixture |
| 检索漏召回 | hard confuser/跨语言 Recall 下降 | 保留静态 fallback/补搜；按失败类别提新 ADR，不加 LLM Router |
| 成功无法归因 | verifier unknown/mixed 占比高 | 不生成 learned cue 或 procedure proposal |
| 快路径回归 | eligibility 或后置条件失败 | 立即 suspend，回退慢路径，保留反例 |
| 依赖频繁漂移 | 重验成本超过节省 | 停止该 procedure，不以覆盖率为目标强行维护 |
| 数据污染或泄漏 | secret scan/provenance/隔离失败 | 停止写入与 consolidation，删除受影响 evidence 并级联失效 |
| 无法证明摊销收益 | break-even 不可达或 fallback 太贵 | 保留文本 Skill 慢路径，判定该 Skill 不适合程序化 |
