# G7 Real Self-Use Host E2E

日期：2026-09-08
状态：`pass_real_self_use`

## 部署形状

- Pi：0.84.2，Windows，项目正常自动发现 `.pi/extensions/skill-cortex/index.ts`。
- `.pi/settings.json` 精确引用 `../skills/skill-cortex-gate-status`；不复制 Skill 源。
- 生产候选预算显式固定 K=5/full；description 不截断。
- 用户级 `skill-router.ts` 在检测到当前项目自带 Skill Cortex 时让位；其他项目继续注册原工具。
- 修改前备份：`C:\Users\a1324\.pi\agent\extensions\skill-router.ts.pre-skill-cortex-g7-20260908.bak`。

## 真实链路证据

正常自动加载命令未使用 `--no-extensions` 或显式 `--extension`。为减少披露，关闭 context files、
prompt templates 与 themes，只允许 `read`、`load_skill`。DeepSeek 经过候选卡、完整父 `SKILL.md` 与
权威 registry 读取，返回与 `config/activation-memory-gates.json` 完全一致的严格 JSON。

运行后 project-local Store 形成一条：

- `taskOutcome=verified_success`
- `skillContribution=verified`
- `evidenceKind=positive`
- `verifier.kind=independent_verifier`
- `verifier.result=pass`

全部 14 个状态文件对原始测试 prompt 的匹配数为 0。

## 分层边界

- Component：G1、G3～G6 既有合同与评测证据保持有效。
- Host integration：真实 Pi resource loader、production entry、K=5、controls、Practice/Assessment Store 已覆盖。
- End-to-end：Pi 0.84.2 正常自动加载 + DeepSeek + `load_skill` + `read` + 独立 contribution verifier 已通过。
- Frozen procedure：production entry 静态 import graph 仍不触达 `src/procedures/`、`src/runtime/` 或
  `src/adapters/pi/execution-adapter.ts`，也不配置 compiled observer 或 active overlay。

G7 通过不把 G2 的 offline exposure policy 或 G6 的 evaluation overlay 自动发布；两者保持各自状态与边界。

## 验证

- 正常自动加载的 Pi 0.84.2 + DeepSeek：通过；未使用 `--no-extensions` 或显式 `--extension`。
- 用户级 router 共存：当前项目注册工具 `[]`；其他目录仍为 `["load_skill","search_skills"]`。
- 目标测试：10 passed，0 failed。
- `npm.cmd run typecheck`：通过。
- `npm.cmd test`：862 tests；860 passed，0 failed，2 skipped。
- `git diff --check`：通过。

真实模型运行发生在 G7 状态翻转前，因此当次严格 JSON 如实包含 `G7=blocked`；该运行关闭的是自动加载、
候选、工具、读取、输出和 assessment 链路。随后 `pass_real_self_use` 由同一严格 registry parser 与 production-entry
合同测试复核。状态翻转后的重复外发被宿主安全审查拒绝，未将其冒充为第二次真实模型结果。
