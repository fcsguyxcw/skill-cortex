# Project Agent Instructions

本文件适用于整个仓库。保持简短；架构、合同和阶段细节以链接文档为准。

## 1. 当前项目目标

- 主研究：低打扰的 prompt 外 Skill discovery，以及由真实、可归因证据派生的 Activation Memory。
- 整体原则：少打扰 Agent、少塞上下文、只记真正有效或经过验证的边界经验。
- Router 不是主研究；MVP 不增加 Router LLM，不建立 Ability/category 硬门。
- Procedural Memory 已由 ADR-0014 降级为 frozen experimental track：不删除现有代码，但不新增能力、
  不接生产入口、不作为当前完成标准。除非用户明确授权 procedure 审计/安全修复，不得继续该方向。

## 2. 开工前必读顺序

1. `README.md`
2. 最新的 `docs/reviews/*implementation-progress-audit.md`
3. `docs/adr/0014-activation-memory-first-scope.md`
4. `docs/design/activation-memory-first-architecture.md`
5. `docs/adr/0007-prompt-external-skill-discovery.md`
6. `docs/adr/0008-practice-evidence-and-procedure-promotion.md`（只适用 Practice/Activation 条款）
7. `docs/adr/0013-selection-time-skill-memory-context.md`（evaluation-only）
8. `docs/design/dual-memory-data-contracts.md`（procedure/runtime 部分为冻结兼容合同）

只有任务明确涉及 frozen procedure 资产时，才继续读取 ADR-0006、ADR-0011、ADR-0012 与旧双记忆
实施计划。ADR-0001 至 ADR-0004 和带 historical/superseded 标记的材料只用于决策历史。
ADR-0005 只约束其 applicability note 声明的评估证据。

## 3. 环境与文件安全

- 所有开发、生成数据和实验必须保持 project-local，目标根目录是 `D:\Users\a1324\Desktop\skill机制`。
- 不得写入、移动、删除或重命名用户日常环境中的任何内容，包括 `C:\Users\a1324\.pi`、`C:\Users\a1324\.codex`、`C:\Users\a1324\.agents`、全局配置和已安装 Skill。
- 工作区外路径只允许只读检查。任何外部写入必须由用户针对精确路径与动作另行授权。
- 不得用用户日常 Pi 环境运行破坏性或会改变状态的集成实验；使用项目内 fixture、临时目录或隔离 sandbox。
- 原始 Skill package 视为只读语义来源。实验需要修改时，先复制到项目内 fixture。
- 不得把秘密、完整用户对话、完整文件内容或未经脱敏的工具输出写入 Practice Store、fixture 或评测数据。

## 4. 架构硬约束

- `SkillRecord` 保存作者声明和不可变 revision；派生记忆不得覆盖原始 description、scope、权限或正文。
- Exposure Gate、Candidate Budget 与 Learning Admission 是三个独立 seam，不得共享一个模糊 maturity score。
- “任务完成”与“Skill 有贡献”必须分开验证；positive Memory 只接受 verified contribution。
- verified negative、near-miss 与 boundary evidence 可以进入负向资料；`mixed/unknown` 不得 consolidation。
- source、工具 schema、权限或相关依赖变化后，受影响 procedure 必须先失效再验证。
- procedure 命中不得绕过 authorization、审批、sandbox 或父 Skill 权限。
- 条件、依赖、授权或后置验证失配时必须停止快路径，回退到父 `SKILL.md + LLM` 或合法 abstain。
- 上述 procedure 条款只约束 frozen 资产，不授权新 procedure 工作或 active 接线。
- 全量 Skill catalog 与完整 ActivationProfile 保存在 prompt 外；只在 Exposure Gate 通过后注入最少轻量候选卡。
- 相关不等于必须使用；能直接可靠完成且 Skill 无明显增益时优先 No-Skill。

## 5. 开发与多 Agent 协作

- 一个 Agent 只修改 leader 明确分配的文件或模块；共享工作区中不得回退、覆盖或整理其他 Agent 的改动。
- 开始前先读取权威文档和目标模块；发现需求、ADR、合同或现有实现冲突时停止该实现并报告 leader。
- 不得发明宿主 API、hook、参数或事件。只使用已在文档或当前安装代码中验证的接口；未验证项留在 Phase 0。
- 采用最小、可归因改动；不要顺手重构、增加推测性抽象或提前实现后续阶段。
- schema、权限、持久化、生命周期或执行路径的重大变化必须先新增或更新 ADR。
- 测试数据、生产 trace 和 synthetic/evaluation 数据必须分区；当前 Agent 选择不能自动成为 gold label。
- 当前实施按 `activation-memory-first-architecture.md` 的 D0～D4 与 G1～G7 执行；上游 gate 未通过不得启动下游 active path。
- 开始新 Phase 前必须读取最新的 implementation progress audit；其中未关闭的 blocker 优先于 implementation plan 的下游任务。若状态冲突，以最新且有证据支持的 audit 为准，直到 blocker 被验证关闭。
- 阶段状态必须分别报告 component implemented、host integration complete 与 end-to-end complete；仅凭 unit test、typecheck 或 code review 不得宣称整个 Phase complete。关闭 blocker 必须附对应测试、复现或真实端到端证据。

## 6. 验证与交付报告

- 修改前确认适用测试；修改后运行相关单元、合同、集成和安全测试。
- 任何 active `ActivationProfile` 必须先经过 shadow；frozen procedure 的原有安全门继续有效，但不得据此启动新快路径。
- 不得用一个加权总分掩盖召回、安全、成功率、回退或成本回归。
- 完成任务时报告：修改文件、运行命令、测试结果、未解决风险、阻塞项和可交给下一 Agent 的边界。
- 没有实际证据时明确写“未验证”，不得把设计合同表述为已经可用的宿主能力。
