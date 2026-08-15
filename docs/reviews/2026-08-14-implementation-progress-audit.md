# Implementation Progress Audit：Phase 1～3 实施状态

日期：2026-08-14

审计对象：`agent/phase3-procedure-gate`，`b3fd709`

状态：**当前实施阻塞清单；未关闭前不得启动 Phase 4 active path**

本文冻结当前代码与真实宿主接线的验收结果，供下一轮 Herdr leader 纠偏。它不替代
ADR 的架构决定；当 implementation plan 的阶段状态与本文的更新证据冲突时，先处理
本文未关闭的 blocker，再继续下游阶段。

## 1. 状态判定口径

- **Component implemented**：目标模块及其局部测试存在。
- **Host integration complete**：模块已接入经核验的真实 Pi 接口，而不是 fake host。
- **End-to-end complete**：真实输入经过完整路径产生可验证结果，并通过对应 gate。

单元测试、typecheck 或离线 replay 只能证明相应组件，不自动证明宿主集成或端到端完成。

## 2. 当前真实阶段状态

| Phase | Component | Host integration | End-to-end | 当前判定 |
|---|---|---|---|---|
| Phase 0：宿主核验与基线 | 已完成 | 不适用 | 不适用 | **Complete** |
| Phase 1：Registry 与 prompt 外 discovery | Registry、BM25、Top-K、shadow adapter 已实现 | 未完成 | 未完成 | **Partial** |
| Phase 2：Practice Store 与证据治理 | Store、policy、分区、脱敏、删除与 evaluation replay 已实现 | 未接真实 Practice observer | 未完成 | **Partial** |
| Phase 3：离线部分编译与晋升 | 手写 SQL detector、draft builder、verifier 与离线 gate 已实现 | 无真实 PracticeEvent 输入或执行 resolver | 未完成，Gate P3 失败 | **Evaluation scaffold / offline pilot only** |
| Phase 4：Execution Resolver 与安全回退 | 未开始 | 未开始 | 未开始 | **Not started** |
| Phase 5：生命周期、失效与回滚 | 未开始 | 未开始 | 未开始 | **Not started** |
| Phase 6：Activation Memory | 未开始 | 未开始 | 未开始 | **Not started** |
| Phase 7：系统验证与交接 | 只有前序阶段的局部评测工具 | 未开始 | 未开始 | **Not started** |

Phase 3 当前保持 `draft`：真实 Store-verified Practice evidence 为 0，且首个成本点估计
`N_break-even=10.129724 > 10`。不得进入 canary/active 或 Phase 4。详见
[Phase 3 Gate 报告](../reports/2026-08-14-phase3-gate-report.md)。

## 3. Blocking findings

### B1. Prompt-external discovery 尚未真正接管 Pi

Pi 0.84.1 在 `before_agent_start` 之前已经把所有可见 Skill 的 name、description 和
location 写入 base system prompt。当前 adapter 的 inject 路径只把 Top-K 候选追加到
`event.systemPrompt`，没有移除原生 Skill block：

```text
当前：full catalog + Top-K
目标：full catalog 留在 prompt 外 → Top-K only
```

项目测试使用人工构造的短 `systemPrompt`，没有覆盖 Pi 真实 prompt 构建顺序。当前只能宣称
retrieval component 完成，不能宣称 prompt-external discovery 已端到端完成。

证据：

- [adapter 追加路径](../../src/adapters/pi/index.ts)
- [fake-host adapter 测试](../../src/adapters/pi/index.test.ts)
- [Phase 1 Gate 报告](../reports/2026-08-14-phase1-gate-report.md)

关闭条件：使用当前安装 Pi 的真实 prompt 构建路径增加回归测试；在 active/inject 模式下，
最终完整 prompt 不得包含未选中 Skill 的 metadata，且失败时仍能安全回退。

### B2. `load_skill` 路径没有项目内 ownership

候选卡要求 Agent 调用 `load_skill`，但本项目只注册 `search_skills`，没有实现或注册
`load_skill`。Pi 原生 `/skill:name` 是命令展开路径，不是本项目当前提示所引用的工具。
删除原生 Skill block 后，仓库自身还不能保证被选中的 `SKILL.md` 能按需加载。

关闭条件：在 project-local 范围内实现并测试受路径、revision、权限和大小约束的加载入口，
或明确绑定一个已核验的宿主接口并用真实集成测试证明该保证；不得依赖用户全局扩展的偶然存在。

### B3. Practice Store 尚未连接真实 Agent 事件

Phase 2 已完成 Store、schema、policy 和 evaluation replay，但 adapter 明确不创建
`PracticeEvent`，也未接入真实 Pi 的 tool/turn/agent 事件。因此当前没有：

```text
real Pi execution → attributable PracticeEvent → project-local Practice Store
```

Synthetic/evaluation replay 不能改标为 `real`，也不能作为 procedure promotion 证据。

证据：[Phase 2 Gate 报告](../reports/2026-08-14-phase2-gate-report.md)。

关闭条件：在项目内隔离环境接通经核验的 Pi observer，生成经过脱敏、归因和 policy 校验的
真实事件；不得写入用户日常 Pi 环境。

### B4. Phase 3 procedure 不是从真实经验中学习得到的

当前 pagination pilot 是人工实现的 deterministic detector。离线 replay 直接把冻结 SQL
案例交给 detector；draft builder 可保存 evidence ID，但没有从多条 `PracticeEvent` 对齐、
发现重复片段或生成候选 procedure 的实现。

它目前只验证：

- procedure contract；
- source/revision/dependency binding；
- 独立 verifier；
- promotion gate；
- fail-closed behavior。

它不能被描述成：

```text
PracticeEvent → stable fragment induction → compiled procedure
```

证据：[Phase 3 replay](../../src/evaluation/phase3/replay.ts)和
[Phase 3 Gate 报告](../reports/2026-08-14-phase3-gate-report.md)。

关闭条件：至少多条真实、可归因、policy-valid 的父 Skill PracticeEvent 经一个可回放的
最小 induction seam 产生稳定片段和 `draft` procedure，并保留来源 evidence IDs。

### B5. 阶段状态曾把 component PASS 与阶段完成混在一起

Phase 1 的原 `PASS` 只证明 Registry、retriever、candidate card、fake-host adapter 和局部
安全回退；Phase 2 的 `PASS` 只证明 Practice Store 基础设施；Phase 3 的离线质量结果也不
代表核心研究闭环完成。

关闭条件：每次阶段验收分别报告 component、host integration、end-to-end 和 gate；缺少任一
必需层时不得把整个 Phase 标为 complete。状态关闭必须附测试、复现或真实端到端证据，不能
只依据 code review。

### B6. Phase 3 成本证据尚不可仓库内复现

当前 `N_break-even` 使用单批 slow-path 样本和报告中记录的 wall-clock 数字；仓库没有生成
这些数字的可重复 benchmark runner，也没有方差估计。它是保守点估计，不是稳定性能结论。

关闭条件：冻结输入、环境、计费口径和重复次数，提供 project-local 可重复 runner，同时计入
procedure 生成与验证成本，再重新计算 break-even。不得为了过门而修改阈值、挑样本或手工
替换成本数字。

## 4. 下一轮 Herdr 的严格执行顺序

1. 不启动 Phase 4，不晋升当前 draft procedure。
2. 关闭 B1：补真实 Pi 最终 prompt 回归测试并修复全量 metadata 残留。
3. 关闭 B2：明确并验证项目可拥有的 Skill 按需加载路径。
4. 关闭 B3：接通 project-local、真实宿主 Practice observer。
5. 生成真实、可归因、policy-valid 的 PracticeEvent；不得把 synthetic/evaluation 数据改标。
6. 关闭 B4：实现最小 `multiple events → repeated/stable fragment → draft procedure` seam。
7. 关闭 B6：建立可重复成本 benchmark，按冻结阈值复测。
8. 重新审计 Phase 1～3 的三层状态；只有 blocker 有关闭证据后，才决定是否进入 resolver、
   lifecycle 和 Activation Memory。

## 5. 当前验证证据与边界

本次审计前的当前分支验证结果：

```text
npm.cmd test
  213 tests；212 pass；0 fail；1 skip

npm.cmd run typecheck
  PASS

git diff --check
  PASS
```

唯一 skip 来自 Windows 文件 symlink 权限。这些结果证明当前组件没有已知测试失败，但不关闭
B1～B6，也不证明真实宿主或端到端路径完成。
