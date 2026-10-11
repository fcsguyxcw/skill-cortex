# G1 Gate Status Skill 设计

日期：2026-09-07

## 目标与边界

新增一个 project-local `skill-cortex-gate-status` Skill，只用于回答当前仓库
G1～G7 的状态。它不扫描任意文档，不修改文件，不执行 procedure，不把
“任务完成”直接解释为 Skill 有贡献。

权威状态单独保存为项目内、版本化的 JSON 文件。Skill 要求 Agent 只读该文件，
并返回严格 JSON：`schemaVersion` 与有序 `gates` 列表，每项仅含 `gateId` 和
`status`。不允许根据 README 散文推测或用模型自行改写状态。

## 组件与数据流

1. `skills/skill-cortex-gate-status/SKILL.md`：作者语义与严格输出合同。
2. `config/activation-memory-gates.json`：可审计的权威状态，只保存 G1～G7
   受控枚举，不保存对话或工具输出。
3. `src/activation/gate-status-contribution-verifier.ts`：加载并校验权威 JSON，
   将最终 assistant JSON 解析后与权威状态深度比较。它精确绑定当次
   `SkillRecord` 的 `skillId + skillRevision + sourceHash`，且只接受指定的
   Practice operation/verifier 证据。
4. production entry 保留当次 catalog snapshot，仅在精确找到该 Skill 时动态
   构造一个 registration；Practice observer 落盘后把事件送入 contribution observer。

原始 prompt 和最终输出只在该 run 内存中存活；持久化的 assessment 仍只含
现有受控字段。

## 失败与验收

以下任一情况零 positive assessment：Skill 缺失，revision/source 漂移，
Practice step/verifier 缺失，权威 JSON 无效，assistant 不是严格 JSON，gate 缺失/重复/
顺序错误，或状态不一致。验收使用真实 project-local `DefaultResourceLoader +
AgentSession + production entry`，至少覆盖正确输出落一条 assessment、错误输出零新增、
原始文本不落盘，以及 revision/source 漂移 fail closed。

这只关闭 G1/D1 的一个有界真实任务域，不声称任意 Skill 已有通用贡献
验证，也不自动启用 active overlay。
