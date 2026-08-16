# Implementation Progress Audit：Phase 1～3 实施状态

日期：2026-08-14（B1–B6 关闭更新 2026-08-16）

审计对象：`agent/phase3-procedure-gate`，`b3fd709`；关闭证据 commit `9af7e67..d5165a9` 及 `p3-gate-runner`

状态：**B1–B6 已关闭；2026-08-16 Gate P3 已完成纠偏并重新 validated；Phase 4 resolver/executor component implemented，但 host integration 与 end-to-end incomplete；任何真实 canary/active 或 Phase 5 路径不得启动**

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
| Phase 1：Registry 与 prompt 外 discovery | 已实现 | 真实 Pi runner 链注入 Top-K、移除原生 block 已验证 | 已通过 Gate P1 | **Complete** |
| Phase 2：Practice Store 与证据治理 | Store、policy、分区、脱敏、删除已实现 | 已接真实 Practice observer（隔离 + --no-session 真实会话） | 已通过 Gate P2 | **Complete** |
| Phase 3：离线部分编译与晋升 | detector、draft、verifier、induction seam、成本 benchmark、formal runner、envelope 已实现 | 默认 project-local Store 的真实 PracticeEvent 经 induction 产生 draft 并绑定 evidence | Gate P3 纠偏后重新 11/11 PASS，procedure `validated` | **Complete（validated，未 canary/active）** |
| Phase 4：Execution Resolver 与安全回退 | resolveExecution/guard/fallback/executor 已按 ADR-0012 实现；project-local shadow replay 已通过 | 已接真实 Pi tool_call/tool_result/agent_settled（shadow entry + ExtensionRunner E2E）；per-call current 来源 + drift fail-closed | shadow_replay 链路 E2E + Gate P4 project-local canary（validated→canary 晋升 + canary 上下文三栏指标）通过 | **Complete（Gate P4 通过）；生产入口接线与真实宿主部署未启动** |
| Phase 5：生命周期、失效与回滚 | 状态机 + dependency diff + rollback + evidence cascade + conditional fingerprint invariant + identity matrix 已实现 | host lifecycle wiring（runHostLifecycle）已接真实事件源（discovery/derive/invalidate） | project-local host E2E 9 场景通过 | **Complete（Gate P5 PASS）；真实宿主部署未启动** |
| Phase 6：Activation Memory | cue induction + shadow rerank + 分栏评估 + profile 状态机 + promotion gate + cascade + store 已实现 | 未接真实宿主（observer→induction→rerank→store 全链未接线） | 未完成（held-out 门槛未校准） | **Component implemented；host integration / E2E incomplete** |
| Phase 7：系统验证与交接 | 只有前序阶段的局部评测工具 | 未开始 | 未开始 | **Not started** |

Phase 3 procedure 已由 `draft` 晋升至 `validated`（Gate P3 正式闭环，`p3-gate-runner`）：
2 条真实、可归因、policy-valid 的 pagination PracticeEvent 经 induction seam 绑定
evidenceIds，held-out 质量门全过，真实成本复测 `N_break-even=0.000109 ≤ 10`（原
`10.129724` 误用开发流水线墙钟作分子，已按 ADR-0008 纠正为 procedure 运行时生成+验证
成本）。`validated ≠ active`：进入 canary/active 前须先过 shadow replay + canary gate。
详见 [Phase 3 Gate 报告](../reports/2026-08-14-phase3-gate-report.md)与
[P3 validation report](../reports/2026-08-14-phase3-p3-validation-report.json)。

> 注：上段的 2026-08-15 artifact identity 已被 2026-08-16 纠偏重跑取代；Gate P3 曾因
> permission binding 重开，现已按 §2.1 关闭并重新 `validated`。

## 2.1 2026-08-16 重新评审与关闭结果（以本节为准）

- **重新评审发现（现已关闭）— permission binding**：`P3_GATE_FROZEN.permissionPolicyHash` 曾为 `sha256:4f×32`
  占位，被 P3 报告与 validation report 引用为 binding 证据，但该值不是任何可核验 policy 的
  指纹（ADR-0011 §4）。permission binding 维度不满足 ADR-0008 的可追溯证据要求；component 与
  本地 evidence chain（真实事件 → induction → draft）本身仍存在且未被否定。
- **重新评审发现（现已关闭）— evaluation/formal 来源隔离**：`p3-gate-runner.test.ts` 曾把临时构造事件标成
  `provenance="real"`，并通过可注入 Store 获得 `validated`。按 ADR-0011 §7，fixture/envelope
  入口只能验证结构与推导一致性，必须保持 `draft`；只有默认 project-local real Store 路径可
  执行 formal transition。
- **上述 P3 blocker 已关闭**：
  - effectless/permissionless pilot 现显式省略 `permissionPolicyHash`；旧 4f artifact 与声明非空
    时使用同一占位的 artifact 均 binding fail；
  - 任一 Store/tenant/event/cost override 均标记为 `evaluation_fixture`；即使 deliberate spoof
    fixture 的 11 门 assessment 全过，公开 decision 仍为 `draft`，不执行 transition；
  - 默认 project-local Store formal 重跑 `sourceMode=formal_real_store`，前置全 PASS、11/11 PASS、
    `assessmentDecision=validated`、最终 `decision=validated`；
  - committed redacted envelope 与 validation report 锚点一致；replay 固定输出
    `provesRealProvenance=false`、`promotionEligible=false`，不能冒充真实 Store 证据；
  - 11 门已逐项标注 `automated` / `static_review` / `owner_attested`，不再声称 11/11 全自动。
- **Phase 4 component gate 已关闭**：resolver/executor 已实现 ADR-0012 的 `executionContext`
  状态矩阵、父 Skill 身份检查、精确 effect 集、两维 authorization claims、artifact 结构化
  disposition、零副作用 `safety_stop`、guard fail-closed 与 verifier binding；project-local
  shadow replay 和定向测试通过。该结论不证明真实宿主授权、guard 观察或 artifact I/O 已接线。
- **Phase 4 host integration（shadow）+ end-to-end 已关闭（2026-08-16，commit b7b8d42）**：真实 Pi
  `tool_call`/`tool_result`/`agent_settled` 经 host-integration-entry + ExtensionRunner 隔离 E2E 验收——
  preflight block 先于工具执行、被 block 调用不产生 tool_result 事件、身份匹配走 fast_path、observer
  完整归因落 provenance=shadow 事件；per-call current 来源（候选卡 revision + derive sourceHash）使
  revision/dependency 漂移真实可检测，current source 缺失 fail-closed（不再 self-match）。drift blocker
  已 CLOSED。生产入口（`.pi/extensions/skill-cortex/index.ts`）接线与 canary/active 仍未启动。
  - 保留为非 blocker：current toolSchemaHash 独立真实来源；多 session/run 并发 current snapshot 隔离；
    safety_stop / procedure_error 的 compiled failure evidence 保留。
- **Phase 5 核心 Gate 已收口（2026-08-16，commit d101d4a）**：状态机 + dependency diff + rollback +
  evidence cascade + conditional fingerprint invariant + identity matrix + procedure store + host
  lifecycle wiring + project-local host E2E 全部落地；Gate P5（失效矩阵 + rollback + host E2E）通过。
  经 `ebc8d4b`（HIGH 1-3：rollback stale-prior / transition immutable / rollback stableNow）+
  `d101d4a`（transition 以 stored 为权威 + rollback 目标权威来源 + allowed-delta 收紧）复审关闭。
  - 后续 lifecycle hardening（非 blocker）：suspendedFrom / suspendKind / lifecycleReason 的
    edge-specific allowed-delta 未做（当前仅 promotion 锁定字段 + evidenceIds 收紧）；
  - real-host deployment 前 blocker（不阻塞 Phase 6）：crash consistency / WAL（transition/rollbackTo
    的 current 覆盖与 event append 无原子性）、真实宿主当次 tool/permission/environment/model 指纹
    来源、新 revision 的独立 revision/save seam、含 LLM hole 的 procedure 真实编译链、cue/profile
    级联消费（ActivationProfile 挂起/回 shadow，属 Phase 6）。
- **未改变**：Phase 1/2 判定；`.skill-cortex` 真实事件与 B1–B6 关闭证据；`validated ≠ active`。

## 3. Blocking findings（2026-08-16 更新：B1–B6 已全部关闭）

以下 B1–B6 为 `b3fd709` 时点的阻塞清单；关闭证据：

- **B1**（关闭 `9af7e67`）：inject 模式精确移除 Pi 原生全量 Skill block（唯一性/残留
  marker 校验，失败 fail open），真实 runner 链测试证明最终 prompt 仅含 Top-K。
- **B2**（关闭 `9af7e67`）：project-local `load_skill` 六重 fail-closed（路径/revision/
  source/manifest/大小/编码），不依赖用户全局扩展。
- **B3**（关闭 `8b8ea56`）：project-local 真实 Practice observer（隔离 runner + 真实
  0.84.2 --no-session 会话）产生脱敏、归因、policy-valid 的 real 事件；host version
  不硬编码（环境字段省略）。
- **B4**（关闭 `3ab80ad` + `1c06750`）：pagination evidence hook 产生带
  `detect-offset-pagination` + verifier pass 的 verified real 事件；`induction.ts`
  从 ≥2 条契约事件对齐稳定片段产出 draft 并绑定 evidenceIds。
- **B5**（关闭于本文状态表）：component / host integration / end-to-end 三层已分别
  验收，不再以 component PASS 冒充整 phase complete。
- **B6**（关闭 `d5165a9`）：`cost-benchmark.ts` 冻结口径 + 可重复 runner，四类成本
  mean/stddev（45 慢路径样本），N_break-even 修正为 0.000109。

正式闭环由 `p3-gate-runner`（真实事件 → induction → judgePromotion 11/11 PASS →
`transitionPhase3ProcedureValidation` draft→validated）固化，证据见
[P3 validation report](../reports/2026-08-14-phase3-p3-validation-report.json)。

以下保留原始 B1–B6 描述作为历史记录。

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

## 4. 下一轮 Herdr 的严格执行顺序（2026-08-16 更新）

B1–B6、Gate P3 纠偏项与 Phase 4 component gate 已关闭。执行顺序（上游步骤未关闭
不得启动下游）：

1. **[完成] 修复 P3 permission binding 表示**（ADR-0011）：effectless/permissionless
   procedure 显式省略 `permissionPolicyHash`（移除 4f 占位、draft builder 参数改 optional、
   binding check 与 resolver/contracts 同步），或对声明了权限的 procedure 提供真实 policy
   指纹；本步只关闭代码表示缺口，不单独关闭 formal gate。
2. **[完成] 补齐 redacted validation evidence envelope**（ADR-0011 §6）：fresh-clone 一致性复验
   资产；同时隔离 formal runner 与注入 fixture/envelope 入口，后两者不得触发晋升；不得进入
   Practice Store / production proposal、不得声称重新证明 real provenance。
3. **[完成] 最终重跑并评审 Gate P3**：使用真实 project-local Store 重跑 `p3-gate-runner`，同时验证
   envelope 与 validation report 的冻结锚点一致；两者均通过后才可关闭 formal gate。
4. **[完成] Phase 4 component 修复：resolver/executor core**（ADR-0012）：executionContext 门控
   （缺失/unknown fail closed）、`parent_skill_mismatch` 身份检查、artifact 结构化
   disposition、authorization claims（effects+permissions 两维声明）；纯函数层实现与测试，
   不涉及宿主事件。
5. **Phase 4 host integration：adapter 与真实 tool_call 接线**（在第 4 步 core 契约之上）：
   接入 guard 观察来源、授权 gate、artifact 入口与宿主 `tool_call` block；验证真实 tool
   事件（tool_call/tool_result/agent_settled）后才有 host integration / end-to-end complete。
6. **不进入真实宿主 canary/active 部署**：P3/P4 门控未关闭前，任何 canary/active 上下文与
   Phase 5（生命周期/失效/回滚）工作不得启动。

## 5. 当前验证证据与边界

2026-08-16 纠偏后的当前分支验证结果：

```text
npm.cmd test
  376 tests；374 pass；0 fail；2 skip

npm.cmd run typecheck
  PASS

git diff --check
  PASS
```

2 个 skip 均来自 Windows 文件 symlink 权限。这些结果关闭 Phase 4 纯函数 component gate，
但不证明真实宿主或端到端路径完成。
