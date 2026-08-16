# ADR-0012：Runtime Execution Context 与 Release Gates

## Status

Accepted — 2026-08-16

扩展 ADR-0008 的 promotion gate 与 ADR-0006 的 runtime 路径，冻结快路径的宿主释放门控契约。

## Context

ADR-0008 定义 `draft → validated → canary → active` 晋升，但现有 runtime（resolver/executor）
没有定义"在什么执行上下文下允许哪个 procedure 状态"的释放门控。shadow replay、canary、
active 在本项目的 Phase 3/4 实现里只是状态名或模拟，没有成为执行契约。

宿主（Pi 0.84.x）没有 procedure 概念：artifact 入口是自定义工具 + `tool_call` gate；授权是
运行期逐次事件。因此必须显式冻结：

- 执行上下文（shadow_replay / canary / active）与允许的 procedure 状态映射；
- 选中 Skill 身份与 procedure 父绑定的强制相等；
- artifact 结果的结构化形态；
- 授权声明的内容与宿主 gate 的强制执行时机。

## Decision

### 1. ExecutionContext

```text
shadow_replay | canary | active
```

- 每次 execution decision 必须携带 `executionContext`；resolver 对缺失或非法输入规范化输出为
  `unknown`，不得伪造为三个合法发布上下文之一。因此 decision 的可观察值为
  `shadow_replay | canary | active | unknown`，其中前三者才是合法请求上下文。
- **缺失、非法或 `unknown` ⇒ fail closed**：不得进入快路径；按慢路径/拒绝处理，绝不乐观放行。

### 2. 上下文与状态映射

| executionContext | 允许的 procedure status | 语义 |
|---|---|---|
| `shadow_replay` | `validated` / `canary` / `active` | 验证/回放：以观察方式执行，**不产生用户可见 effect**（无副作用、不写外部、不触发真实工具副作用）；可对比慢路径质量与成本 |
| `canary` | `canary` | 限量发布；`validated → canary` 状态转换必须**先发生**（转换是显式发布动作），不允许 validated 直接进入 canary 上下文执行 |
| `active` | `active` | 正式执行；`canary → active` 转换先发生，不允许跳过 |

- shadow_replay 是验证方法，不是 procedure 状态（ADR-0008：shadow replay 不得替代状态机）。
- 状态转换本身属于发布动作，不在当前调用内自我修改（ADR-0008：失败修订须重新验证）。

### 3. 选中 Skill 身份冻结

- 快路径 eligibility 前置：`selectedSkill.skillId === procedure.parentSkillId`。
- 不等 ⇒ `parent_skill_mismatch` ⇒ 慢路径/拒绝，且该检查**先于** revision 检查
  （身份不一致时无需比较版本）。
- `selectedSkill.skillRevision` 与 `parentSkillRevision`、以及运行环境的
  `currentSkillRevision` 与 `parentSkillRevision` 均须相等；任一失配均按既有
  `revision_mismatch` 语义 fail closed。

### 4. Artifact 结构化 disposition

- 每次 artifact 执行必须返回结构化 `disposition ∈ {completed, abstained}`：
  - `completed`：产生满足后置条件的确定结果；
  - `abstained`：无副作用放弃/越界（含条件不足、未知、拒绝），走回退路径。
- 不得用 exception 文本、自由字符串或缺失字段隐式表达 disposition。

### 5. Authorization claims 与宿主 gate

- 每次执行必须先携带**显式的 claims 对象，同时包含 `effects` 与 `permissions` 两个数组**
  （两维分离，不合并、不写“并集”）：
  - `effects`：与 procedure 的 `declaredEffects` 逐项一致；数组可为空**当且仅当**
    `declaredEffects` 为空；
  - `permissions`：与 procedure 的 `requiredPermissions` 逐项一致；数组可为空**当且仅当**
    `requiredPermissions` 为空。
- **不得用占位字符串**（如 `"none"`、`"read-only"` 等非声明值）代替真实声明；数组不得
  包含未声明项，也不得省略 procedure 已声明项。
- 当前 procedure artifact 是不可拆分的整体执行单元，没有 step-level effect plan；因此
  resolver 的 `requestedEffects` 必须与 `declaredEffects` 精确相等后才可进入快路径，不能仅做
  子集检查。未来若引入可验证的 step-level plan，须另行 ADR 后才可放宽为子集。
- 真实 effect 发生前由宿主 `tool_call` block（0.84.1/0.84.2 已验证：返回 `{ block: true }`
  在工具执行前生效，且被 block 的调用不产生 `tool_result`）强制执行。
- 快慢路径使用**同一授权 gate**。慢路径（无 procedure）不适用“当且仅当对应声明为空”约束：
  其授权由宿主 gate 对每个实际工具调用逐次声明并判定（见 §6）；快路径必须满足上述两维
  声明约束。

### 6. 加载 SKILL.md 不是 effect

- 慢路径加载父 `SKILL.md`（`load_skill`）本身不是 effect：它不产生副作用，不构成授权事件。
- 但慢路径**后续的工具调用**（bash/read/write/edit 等）仍走同一宿主 gate，逐次授权。

## Consequences

### Positive

- 释放门控成为执行契约：canary/active 上下文不会误放行 validated 或更早状态。
- 身份/版本检查顺序冻结，消除"选中错误 Skill 却因版本匹配被放行"的歧义。
- artifact 结果可机器校验（disposition），verifier/fallback/观察统一消费。

### Negative

- `ExecutionDecision` 增加必填 `executionContext` 字段与 `parent_skill_mismatch` reason；当前
  没有持久化 decision，因此迁移风险有限，但这不是对原调用方的 additive 兼容变更。
- `sideEffectCount` 是 artifact 与 host adapter 提供的可观察值；纯函数 executor 无法独立证明
  真实 I/O 为零。真实 canary/active 放行仍依赖后续 host adapter 将 artifact、授权 gate 与
  `tool_call` 事件接线并验收。

## Implementation Status（2026-08-16）

- resolver/executor core 已实现本 ADR 的 execution context、父 Skill 身份、精确 effect、
  authorization claims、结构化 disposition、零副作用 safety stop 与 verifier binding 契约。
- project-local `shadow_replay` 与定向测试已通过；这只关闭 Phase 4 component gate。
- 真实 Pi `tool_call` adapter、授权/guard 观察来源与 artifact 入口尚未接线，因此 host integration、
  end-to-end、真实 canary/active 均未完成。

### Neutral

- 不改变晋升状态机；只冻结"在哪个上下文允许执行哪个状态"。

## Alternatives Considered

**由 procedure.status 单独决定可执行性，不引入 executionContext**

- 拒绝：无法区分"验证性回放"与"正式执行"；canary 阶段的受控放行与 active 的正式放行
  需要独立门控；缺失上下文时的 fail-closed 语义无处附着。

**executionContext 允许 validated 直接进入 canary 执行**

- 拒绝：绕过 `validated → canary` 显式转换会丢失发布动作的可审计性，与 ADR-0008
  "canary 状态可追溯"冲突。

## References

- `docs/adr/0008-practice-evidence-and-procedure-promotion.md`
- `docs/design/dual-memory-data-contracts.md`（§4.5、§4.6、§9）
- `docs/reports/2026-08-14-phase4-resolver-gate.md`（§7 executor/canary）
- `docs/reviews/2026-08-14-implementation-progress-audit.md`（§2.1、§4）
