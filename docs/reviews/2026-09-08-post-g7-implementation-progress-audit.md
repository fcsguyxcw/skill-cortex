# Post-G7 Implementation Progress Audit

日期：2026-09-08
审计基线：`320930b Close G7 real self-use host gate`

状态：**Activation-Memory-first 主线已完成当前 G1～G7 的有界验收；这不表示 production active
Activation Memory 已发布，也不表示任意 Skill 已具备通用 contribution verifier。**

本文取代 `2026-08-14-implementation-progress-audit.md` 作为当前实施状态入口。旧审计继续保存
procedure Phase 0～7 的历史 project-local 证据，但该 track 已被 ADR-0014 冻结。

## 1. 判定口径

- Component implemented：目标模块与局部合同测试存在。
- Host integration complete：模块接入已核验的 Pi 接口。
- End-to-end complete：真实输入经过完整路径产生可独立验证结果。
- Bounded pass：只对被冻结的任务域、Skill revision 与 verifier 成立，不向其他 Skill 外推。

## 2. 当前 Gate 状态

| Gate | Registry 状态 | 当前证据边界 |
| --- | --- | --- |
| G1 Admission | `pass_bounded_domain` | `skill-cortex-gate-status` 的 exact-bound production verifier；非通用 verifier |
| G2 Exposure | `offline_pass_shadow_only` | deterministic policy 仅离线通过；生产不 suppress |
| G3 Budget/cards | `closed_keep_k5_full` | K=3 真实模型评测未达非劣；生产保留 K=5/full |
| G4 Controls | `pass_project_local_host` | list/pause/resume/delete、重启持久化与级联失效 |
| G5 Cache | `pass_project_local_host` | catalog/overlay cache component 与 project-local host 失效证据 |
| G6 Active overlay | `pass_evaluation_host` | frozen held-out 与 evaluation host 通过；production overlay 禁用 |
| G7 Host E2E | `pass_real_self_use` | Pi 0.84.2 正常自动加载、真实模型、父 Skill 加载、权威读取与独立 assessment |

Gate registry 的当前权威值在 `config/activation-memory-gates.json`。G7 的真实链路证据见
`docs/reports/2026-09-08-g7-real-self-use.md`。

## 3. 实际运行形状

- 生产入口保持 prompt 外 discovery，候选预算固定 K=5，使用完整作者 description。
- 生产入口为 `skill-cortex-gate-status` 与 `markdown-relative-link-audit` 分别注册 exact-bound、任务特定的
  contribution verifier；后者只有 project-local AgentSession E2E，尚无真实模型自用证据。
- G2 policy 仍是 shadow/evaluation-only，不改变候选注入。
- G6 ActivationProfile overlay 仍被 production scope-lock 禁止。
- frozen procedure/runtime/compiled observer 不在生产入口静态 import graph 或注册面中。
- 用户级旧 Skill router 只在本项目检测到 Skill Cortex 时让位；其他项目维持原行为。

## 4. Store 与学习边界

审计时 project-local Store 包含：

- 8 条 real PracticeEvent；
- 2 条 positive LearningEvidenceAssessment；
- 0 个 ActivationProfile 文件。

真实 PracticeEvent 的 `redactedTaskFeatures` 目前只有 prompt hash、candidate count 与 selected count，
不足以为新任务形成可泛化语义 cue。05:09 会话加载了 Skill，但最终输出是 Markdown JSON fence，严格
`JSON.parse(finalAssistantText)` 失败，因此没有新增 positive assessment；这保留为“加载 Skill 不等于
产生正向学习证据”的真实负对照。

`induceAndStoreShadow` 已有 component 测试，但生产入口没有自动 induction 接线。assessment 数量不得
解释为 Activation Memory 数量。

## 5. 当前验证证据

- G7 报告记录的目标测试：10 passed，0 failed。
- G7 报告记录的全套测试：862 tests；860 passed，0 failed，2 skipped。
- G7 报告记录的 typecheck 与 `git diff --check`：通过。
- 本审计只做文档与当前只读状态对账；未重新运行真实模型，也未修改 Store。

## 6. 未关闭风险与下一实施门

1. 第二个非元、可重复任务域已冻结为 project-local Markdown 相对链接审计；deterministic scanner、
   exact-bound verifier、生产 registration 与 AgentSession 正反例已实现。
2. 该 pilot 尚未产生真实模型 evidence；其当前通过只属于 component + project-local host seam。
3. 语义 feature producer 尚未实现；后续只能输出受控、脱敏字段，不得持久化原始 prompt 或任意模型 alias。
4. 自动 draft/shadow induction 尚未接线；production active overlay 继续禁用。
5. 旧 Activation Memory calibration 中 verified 与 naive 输出相同，No-Skill FP=`1.00`、hard-confuser
   FP=`0.8333`；在新 development/calibration 通过前不得运行 held-out 或启用 active Memory。

下一 frontier 是 project-local ticket 02：只在 verified Markdown audit evidence 后生成白名单语义特征，
并接到 draft/shadow induction；不得提前运行 calibration 或启用 active overlay。

## 7. 明确不做

- 不修改 frozen procedure track；
- 不启用 exposure suppression 或 production active overlay；
- 不把模型自评当作 contribution proof；
- 不修改、移动、暂存或删除两个未跟踪 Pi session HTML；
- 不修改用户级 Pi/Codex/Agent 环境。
