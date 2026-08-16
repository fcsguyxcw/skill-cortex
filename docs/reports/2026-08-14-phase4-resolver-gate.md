# Phase 4 Gate 报告：Execution Resolver 核心

日期：2026-08-15
状态：**Component implemented（2026-08-16 按 ADR-0012 纠偏验收）；未接线宿主执行路径；不启动真实 canary/active/Phase 5**
契约：ADR-0008、ADR-0012「Runtime resolution、fallback 与失效」+ data-contracts §4.6/§6.2 + 冻结 ExecutionDecision

> 2026-08-16 纠偏说明：§1–§7 保留 2026-08-15 的历史实现记录，其中关于 effect 子集、
> 慢路径伪授权、外层手工 abstain 路由和 “canary 模拟” 的描述已被 §8 取代，不再作为当前契约。

## 1. 模块设计

三个纯函数模块（`src/runtime/`），确定性、无副作用、不修改 procedure 状态：

```text
resolveExecution(selectedSkill?, procedure?, environment)
  → ExecutionDecision：a–i 顺序检查（见 §3）
checkGuards({ procedure, observations })
  → GuardOutcome：precondition/runtime/postcondition 任一 fail|unknown ⇒ 停止快路径
resolveFallback({ reason, steps, candidateFailurePoint? })
  → FallbackOutcome：安全停止 + load_parent_skill/abstain + 首个可归因失败步骤
```

- decisionId 确定性：`decision:` + sha256(skillId+procedureId+mode+reason) 前 32 hex。
- 依赖指纹匹配：procedure 绑定的每个字段必须与 environment 相等；environment 缺失 ⇒
  mismatch（fail-closed）；procedure 未绑定的字段（如 env 额外提供 modelId）不构成约束。
- 前置条件评估：procedure 声明的每个 predicate 从 environment 取结果；缺失 ⇒ unknown ⇒
  precondition_failed（fail-closed）。revision/dependency 不匹配时不评估前置
  （checkedPreconditions=[]，先决条件不满足无需检查后续）。
- guard 结果映射：boolean true→pass / false→fail / "unknown"→unknown；
  checkedPreconditions 只含 precondition 观察；guardResults 为 PracticeEvent 合同形状。
- fallback：no_skill_selected ⇒ abstain（无父 Skill 可回退）；其余失败类别 ⇒
  load_parent_skill；firstAttributableFailureStepId 只采纳真实引用当次步骤中
  outcome="failed" 的候选，未知保持空（绝不猜测）。

## 2. 新增文件

| 文件 | 内容 |
|---|---|
| `src/runtime/resolver.ts` | `resolveExecution` + `dependencyFingerprintMatches` + `evaluatePreconditions` + `deriveDecisionId` |
| `src/runtime/guard.ts` | `checkGuards` + `toGuardResultValue` |
| `src/runtime/fallback.ts` | `resolveFallback`（安全停止 + 回退 + 首失败点） |
| `src/runtime/index.ts` | re-export |
| `src/runtime/resolver.test.ts` | resolveExecution 分支/边界覆盖 |
| `src/runtime/fallback.test.ts` | guard + fallback 行为覆盖 |

未修改 contracts/detector/draft/observer 契约；未改动 core.ts/index.ts/.pi 入口。

## 3. resolveExecution 分支覆盖清单

| 分支 | 条件 | mode | reason | fallbackMode | 测试 |
|---|---|---|---|---|---|
| a | 无选中 Skill | abstain | no_skill_selected | abstain | ✔ |
| b | 无 procedure | skill_md | no_procedure | load_parent_skill | ✔ |
| c | status ∉ {validated,canary,active} | skill_md | insufficient_evidence | load_parent_skill* | ✔（draft/suspended/retired） |
| d | currentSkillRevision ≠ parentSkillRevision | skill_md | revision_mismatch | load_parent_skill | ✔ |
| e | 依赖指纹 mismatch（值不等/缺失/缺 sourceHash） | skill_md | dependency_mismatch | load_parent_skill | ✔ |
| f | 前置 fail/unknown/缺结果 | skill_md | precondition_failed | load_parent_skill | ✔ |
| g | requestedEffect 越界 | skill_md | unsupported_effect | load_parent_skill* | ✔ |
| h | authorizationRequired | compiled_procedure | authorization_required（授权声明=true） | load_parent_skill* | ✔ |
| i | 全部满足 | compiled_procedure | eligible_procedure | load_parent_skill | ✔ |

边界覆盖：decisionId 确定性、checkedPreconditions 填充规则（c/d/e 为空、f–i 含前置评估）、
canary/active 放行、env 多余指纹字段不构成约束、selectedSkill.skillRevision 为快照
（revision 校验以 environment 为准）。

*推断项：c/g/h 分支的 fallbackMode 契约未显式给出，按"skill_md 慢路径回退父 Skill"与
"授权 gate 快慢路径一致、外部拦截"语义取 load_parent_skill，待 leader 确认（不阻塞）。

## 4. guard / fallback 行为

- guard：任一 fail 或 unknown ⇒ ok=false + firstFailedGuard（首个失败，phase 标注）；
  全 pass/空观察 ⇒ ok=true；postcondition fail 同样停止快路径。
- fallback：no_skill_selected ⇒ abstain；guard_failure/verifier_failure/procedure_error 及
  全部 resolver 失败 reason ⇒ load_parent_skill；stopped=true（调用方须在副作用前调用）。
- firstAttributableFailureStepId：候选引用当次 failed 步骤 ⇒ 采纳；引用 ok 步骤/不存在
  步骤/无候选 ⇒ undefined（不猜）。与 data-contracts §9 一致。

## 5. 验证命令与结果

```text
npm run typecheck（本 Agent 范围）  PASS（非 phase12 induction WIP 错误为 0）
node --test "src/runtime/*.test.ts"  PASS；21 tests；21 pass；0 fail
npm test（全量）                     PASS；323 tests；321 pass；0 fail；2 skip（既有 symlink）
git diff --check                     PASS
```

注：`src/evaluation/phase3/induction.ts` 存在 phase12 同事的 WIP typecheck 错误（非本 Agent
范围，未改动；其测试运行时通过，计入全量 321 pass）。

## 6. 未解决风险 / 待确认

1. **未接线宿主执行路径**：resolver/guard/fallback 是纯函数核心；真实 tool 事件如何驱动
   guard（观察来源）、授权 gate 的宿主 hook、快路径 artifact 执行入口均未实现/未验证，
   属后续 resolver 接线工作，本阶段不宣称 host integration complete。
2. **c/g/h fallbackMode 为推断值**（见 §3*），需 leader 确认冻结。
3. **no_skill_selected 时 skillId/skillRevision 输出空串**：合同字段必填且无 Skill 可绑定，
   若需特殊占位符请指认。
4. **guard observations 全量信任**：executor 已补强——procedure 声明的每个 runtime guard
   必须有观察，缺省合成 unknown ⇒ fail-closed（见 §7）。
5. 状态机（dependency mismatch ⇒ suspended 等）属 Phase 5，本模块不改变 procedure 状态。
6. 不启动 canary/active、不写用户环境、无任何副作用执行。

## 7. 执行编排（executor）与 project-local canary（2026-08-15 追加）

新增 `src/runtime/executor.ts`（通用编排）与 `src/evaluation/phase4/canary.ts`（P3 canary 模拟）。
不改 resolver/guard/fallback 纯函数契约；不真实宿主部署、不写用户环境。

### 7.1 executor 流程

```text
resolveExecution → abstain（无副作用）/ denied（授权拒绝，两侧停止）
  → skill_md：同一授权 gate（effect=load-parent-skill）→ 慢路径（加载父 SKILL.md，模拟）
  → compiled_procedure：同一授权 gate（effect=requestedEffects）
      → guard 检查（procedure 声明的每个 runtime guard 必须有观察，缺省=unknown ⇒ 停止）
      → artifact 执行（确定性/只读/幂等）→ postcondition verifier
      → guard/verifier/procedure 失败 ⇒ resolveFallback（安全停止 + load_parent_skill）
        + 慢路径恢复；不重复副作用（已停止，不重放 artifact）
```

- 快慢路径使用**同一注入 authorization gate**（plan §9）；denied ⇒ 无副作用。
- verifier 失败 ⇒ canary-fail 信号（不回写），**不在当前调用自我修改 procedure 状态**（Phase 5）。

### 7.2 集成测试覆盖（plan §9 清单）

| 验收项 | 结果 |
|---|---:|
| 无 procedure / revision mismatch / dependency mismatch / 未知条件 → 慢路径 | ✔ |
| 只有全部 guard pass → 快路径；快慢路径同一授权 gate | ✔ |
| guard fail/unknown/缺省观察 → 副作用前停止 + fallback + 慢路径恢复 | ✔ |
| verifier 失败 → fallback + 慢路径恢复；不自我修改发布（status 不变） | ✔ |
| procedure_error → fallback + 慢路径恢复（异常不传播） | ✔ |
| denied / abstain 无副作用 | ✔ |
| 重复调用无重复非幂等副作用（artifact 恰一次/轮；guard 失败 0 次；verifier 失败不重放） | ✔ |

### 7.3 分栏指标与 canary 结论

```text
total=15; fast_path=12; abstain→slow=3; fallback=0; denied=0
fallbackRecoveryRate=N/A（0 fallback，不虚报）；wrongFastPathRate=0；correctRejectionRate=1
H01–H05 uses_offset ✔；H06–H09/H15 no_pagination ✔；H10–H11 uses_keyset ✔；
H12–H14 abstain → 慢路径（正确拒绝）✔
```

canary 为 project-local 模拟（validated procedure 冻结构造 + detectPagination 快路径；
abstain 按 ADR-0008 回退慢路径）；慢路径返回 project-local 标记，不写用户环境。

### 7.4 验证命令与结果

```text
npm run typecheck                        PASS（exit 0）
node --test src/runtime/executor.test.ts  PASS；15 tests（executor 编排）
node --test src/evaluation/phase4/canary.test.ts  PASS；6 tests（canary 模拟）
npm test（全量）                          PASS；344 tests；342 pass；0 fail；2 skip（既有 symlink）
git diff --check                          PASS
```

## 8. 2026-08-16 ADR-0012 纠偏验收（当前权威状态）

- resolver 按 `executionContext × procedure.status` 矩阵 fail closed；缺失/非法 context 输出
  `unknown`，父 Skill 身份检查先于 revision，requested effects 必须与声明集合精确相等。
- executor 只在 compiled procedure 路径请求授权，claims 精确复制 `declaredEffects` 与
  `requiredPermissions`；加载父 `SKILL.md` 本身不伪装成授权 effect。
- artifact 必须返回 `disposition` 与 `sideEffectCount`。缺失/非法值或非零副作用进入
  `safety_stop`，不加载慢路径、不调用 verifier；`abstained + 0` 由 executor 统一回退。
- runtime guard 缺观察或 phase 错时补 `unknown` 并停止；verifier ID 不属于 procedure
  postconditions 时按 verifier failure 回退。
- `src/evaluation/phase4/canary.ts` 仅为 project-local `shadow_replay` harness；它不执行
  `validated → canary/active` 状态转换，也不是宿主发布证据。
- 独立只读审查未发现 blocker/high/medium；`sideEffectCount` 仍是 host/artifact 提供的可观察值，
  真实 I/O 与 `tool_call` gate 必须在 host integration 阶段另行验证。

```text
node --test src/runtime/resolver.test.ts src/runtime/fallback.test.ts src/runtime/executor.test.ts src/evaluation/phase4/canary.test.ts
  PASS；57/57
npm.cmd test
  PASS；376 tests；374 pass；0 fail；2 skip（Windows symlink 权限）
npm.cmd run typecheck
  PASS
git diff --check
  PASS
```

当前 gate 结论：**Phase 4 component implemented；host integration 与 end-to-end incomplete；
不得启动真实 canary/active。**
