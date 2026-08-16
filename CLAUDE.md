# Claude Leader 项目说明

本文件是给接管本项目统筹的 Claude（leader）看的项目级说明。所有执行 Agent（pi）的通用规范见 `AGENTS.md`；本文件补充 leader 视角的统筹、验收、决策与协作要点。二者冲突时以 `AGENTS.md` 与最新 ADR 为准。

## 1. 项目目标

研究「已安装 Skill 的经验引导式熟练化」，两个相互独立的问题：

1. 不把全部 Skill metadata 常驻上下文时，Agent 如何发现相关已安装 Skill（prompt 外 discovery）。
2. Agent 在真实使用一个已安装 Skill 的过程中，把稳定、可验证部分逐步固化为程序快路径（Procedural Memory）。

核心对象始终是用户已安装的 Skill；程序化产物是它的派生执行表示。不研究「从自由任务轨迹自动创造全新 Skill」。

## 2. 权威阅读顺序

1. `AGENTS.md` —— 所有 Agent 的 project-local、安全、协作规则。
2. `docs/reviews/2026-08-14-implementation-progress-audit.md` —— 真实阶段状态 + 未关闭 blocker（leader 决策依据）。
3. `docs/plans/2026-08-14-dual-memory-implementation-plan.md` —— Phase 0～7、所有权、gate、验证、停止条件。
4. `docs/adr/0006-dual-memory-skill-architecture.md`、`0007-prompt-external-skill-discovery.md`、`0008-practice-evidence-and-procedure-promotion.md`。
5. `docs/design/dual-memory-data-contracts.md` —— 规范字段、不变量、状态机。
6. 各 phase gate 报告（`docs/reports/`）。

ADR-0001～0004 与带 historical/superseded 标记的文档只用于理解决策历史，不作当前实现依据。

## 3. 当前阶段状态（动态，以最新 audit 为准）

| Phase | 状态 |
|---|---|
| 0 宿主核验与基线 | Complete |
| 1 Registry 与 prompt 外 discovery | Complete（B1/B2 关闭） |
| 2 Practice Store 与证据治理 | Complete（B3 关闭，真实 observer 接线） |
| 3 离线编译与晋升 | Complete（procedure `validated`，Gate P3 正式闭环） |
| 4 Execution Resolver | Component + host integration（shadow）+ E2E complete；生产入口接线与 canary/active 未启动 |
| 5 生命周期、失效与回滚 | Complete（Gate P5 PASS：失效矩阵 + rollback + host E2E）；真实宿主部署未启动 |
| 6 Activation Memory | Component implemented（induction/rerank/评估/promotion/store）；host integration / E2E incomplete |
| 7 | Not started |

硬规则：上游 gate 未通过不得启动下游 active path。Phase 4 host integration（shadow）已接真实 Pi tool 事件并经隔离 E2E 验收（block / fast_path / 归因 / 漂移 fail-closed）；生产入口（.pi/extensions/skill-cortex/index.ts）接线与 canary/active 未启动，此前不得进入 Phase 5 active path。关闭 blocker 必须附测试、复现或真实端到端证据。

## 4. 版本漂移边界（2026-08-15 决策，重要）

- 仓库 `package.json` / `node_modules` 锁定 `@earendil-works/pi-coding-agent@0.84.1`，测试基线用 0.84.1 runner。
- 真实宿主 `pi` CLI 已升级到 **0.84.2**。
- 决策（用户拍板）：**保守处理** —— observer 不硬编码 host version（`environmentFingerprint` / `dependencyFingerprint.environmentClass` 省略），仓库依赖与测试基线保持 0.84.1；0.84.2 的完整 API 核验留作后续单独任务。
- 任何新代码不得硬编码宿主版本；无法从已验证宿主 API 可靠取得的字段一律省略，不得谎报。

## 5. 架构硬约束（摘要，完整见 AGENTS.md §4）

- `SkillRecord` 保存作者声明与不可变 revision；派生记忆不覆盖原文。
- Activation Memory（何时用）与 Procedural Memory（执行多少）分离，不混一个 maturity score。
- `CompiledProcedure` 必须绑定父 `skill_id + revision + dependency fingerprint`，不独立注册为 Skill。
- 条件/依赖/授权/后置验证失配必须停止快路径，回退父 `SKILL.md + LLM` 或合法 abstain。
- MVP 只允许确定性、可回放、只读或幂等操作。
- 全量 Skill catalog 在 prompt 外；主 Agent 只注入候选卡。

## 6. 环境与文件安全（完整见 AGENTS.md §3）

- 目标根目录 `D:\Users\a1324\Desktop\skill机制`，所有开发/数据 project-local。
- 不得写 `~/.pi`、`~/.codex`、`~/.agents`、全局配置、已安装 Skill。
- 工作区外路径只读；外部写入需用户精确授权。
- 原始 Skill package 只读；实验需先复制到项目内 fixture。
- 秘密、完整对话、完整文件内容、未脱敏工具输出不得落盘。

## 7. Leader 工作方式

### 7.1 指挥 pi（herdr）

pi 启动命令（在 herdr pane 中）：

```text
pi -ne -e .\.pi\extensions\skill-cortex\index.ts
```

herdr 常用命令：

```text
herdr agent list                                            # 各 pane agent 状态
herdr agent read <name|pane_id> --source recent-unwrapped --lines N   # 读输出
herdr agent prompt <name|pane_id> "<任务>"                    # 派活（原子发送 + Enter）
herdr agent wait <name> --until blocked --timeout T           # 等某状态
```

派活要点：明确分配文件（一个 Agent 只改 leader 分配的文件）；给验收标准；禁止跨文件/跨 phase；禁止 pi 做全盘 find/grep 递归（会卡死）。

### 7.2 验收三层口径

每 phase 分别报告 **component / host integration / end-to-end**；unit test、typecheck、code review 不能宣称整 phase complete。

### 7.3 git 管理

- 及时提交，不积攒大量未提交改动；临时脚本（`.tmp-*`）与 `.skill-cortex/` 不入库。
- 每个可验证完成的 Agent 交付单独或合并 commit，消息注明归属。
- 未通过验收的半成品不 commit。

## 8. 验证命令

```text
npm test            # node --test（全量）
npm run typecheck   # tsc --noEmit
git diff --check    # 空白/冲突检查
```
