# Project Agent Instructions

本文件适用于整个仓库。保持简短；架构、合同和阶段细节以链接文档为准。

## 1. 当前项目目标

- 主研究：用户已安装的声明式 Skill 如何在真实、可归因的反复使用中逐渐形成经过验证的部分程序快路径。
- 辅助方向：prompt 外 Skill discovery，以及由使用证据派生的 Activation Memory。
- Router 不是主研究；MVP 不增加 Router LLM，不建立 Ability/category 硬门。
- 成熟度减少的是重复读取 `SKILL.md` 与重复规划，不得用来提高 discovery 相关性。

## 2. 开工前必读顺序

1. `README.md`
2. `docs/adr/0006-dual-memory-skill-architecture.md`
3. `docs/adr/0007-prompt-external-skill-discovery.md`
4. `docs/adr/0008-practice-evidence-and-procedure-promotion.md`
5. `docs/design/dual-memory-data-contracts.md`
6. `docs/plans/2026-08-14-dual-memory-implementation-plan.md`

ADR-0001 至 ADR-0004 和带 historical/superseded 标记的研究、审查文档只用于理解决策历史，不得作为当前实现依据。ADR-0005 只约束其 applicability note 声明的评估证据。

## 3. 环境与文件安全

- 所有开发、生成数据和实验必须保持 project-local，目标根目录是 `D:\Users\a1324\Desktop\skill机制`。
- 不得写入、移动、删除或重命名用户日常环境中的任何内容，包括 `C:\Users\a1324\.pi`、`C:\Users\a1324\.codex`、`C:\Users\a1324\.agents`、全局配置和已安装 Skill。
- 工作区外路径只允许只读检查。任何外部写入必须由用户针对精确路径与动作另行授权。
- 不得用用户日常 Pi 环境运行破坏性或会改变状态的集成实验；使用项目内 fixture、临时目录或隔离 sandbox。
- 原始 Skill package 视为只读语义来源。实验需要修改时，先复制到项目内 fixture。
- 不得把秘密、完整用户对话、完整文件内容或未经脱敏的工具输出写入 Practice Store、fixture 或评测数据。

## 4. 架构硬约束

- `SkillRecord` 保存作者声明和不可变 revision；派生记忆不得覆盖原始 description、scope、权限或正文。
- Activation Memory 回答“何时可能使用”；Procedural Memory 回答“选中后自动执行多少”。两者不得共享一个模糊 maturity score。
- `CompiledProcedure` 必须绑定父 `skill_id + revision + dependency fingerprint`，不得成为独立全局 Skill 或 discovery 候选。
- source、工具 schema、权限或相关依赖变化后，受影响 procedure 必须先失效再验证。
- procedure 命中不得绕过 authorization、审批、sandbox 或父 Skill 权限。
- 条件、依赖、授权或后置验证失配时必须停止快路径，回退到父 `SKILL.md + LLM` 或合法 abstain。
- MVP 只允许确定性、可回放、只读或幂等操作；禁止任意自修改程序和不可补偿的自动副作用。
- 全量 Skill catalog 保存在 prompt 外；只向主 Agent 注入候选卡。全量 metadata 仅作离线 comparator。

## 5. 开发与多 Agent 协作

- 一个 Agent 只修改 leader 明确分配的文件或模块；共享工作区中不得回退、覆盖或整理其他 Agent 的改动。
- 开始前先读取权威文档和目标模块；发现需求、ADR、合同或现有实现冲突时停止该实现并报告 leader。
- 不得发明宿主 API、hook、参数或事件。只使用已在文档或当前安装代码中验证的接口；未验证项留在 Phase 0。
- 采用最小、可归因改动；不要顺手重构、增加推测性抽象或提前实现后续阶段。
- schema、权限、持久化、生命周期或执行路径的重大变化必须先新增或更新 ADR。
- 测试数据、生产 trace 和 synthetic/evaluation 数据必须分区；当前 Agent 选择不能自动成为 gold label。
- 每阶段按 implementation plan 的依赖、验收与 anti-pattern guard 执行；上游 gate 未通过不得启动下游 active path。

## 6. 验证与交付报告

- 修改前确认适用测试；修改后运行相关单元、合同、集成和安全测试。
- 任何 active `ActivationProfile` 必须先经过 shadow；任何 procedure 快路径必须先经过独立验证，再经过明确的 canary/promotion gate。Procedure 的 shadow replay 是一种验证方法，不是 `CompiledProcedure` 状态。
- 不得用一个加权总分掩盖召回、安全、成功率、回退或成本回归。
- 完成任务时报告：修改文件、运行命令、测试结果、未解决风险、阻塞项和可交给下一 Agent 的边界。
- 没有实际证据时明确写“未验证”，不得把设计合同表述为已经可用的宿主能力。
