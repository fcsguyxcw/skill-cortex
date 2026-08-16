# ADR-0011：Phase 3 Validation Evidence 与 Policy Binding

## Status

Accepted — 2026-08-16

澄清并修订 ADR-0008 中"权限清单与 effect 声明"在 effectless/permissionless procedure 上的
证据要求；不替代 ADR-0008。

实施状态（2026-08-16）：已移除旧占位、完成 formal/evaluation 来源隔离、提交 redacted
envelope，并由默认 project-local Store 重跑 Gate P3；关闭证据见最新 audit §2.1。

## Context

ADR-0008 要求 Compiled Procedure proposal 保存权限清单与 effect class，并在权限变化时失效。
但当前宿主（Pi 0.84.x）没有集中 permission policy API：唯一授权机制是运行期、逐次的
`tool_call` block（`{ block: true }` 在工具执行前生效），授权 gate 位于 procedure 之外。

P3 实现把 `permissionPolicyHash: sha256:4f×32` 作为占位写入
`CompiledProcedure.dependencyFingerprint.permissionPolicyHash`，并被 P3 gate 报告与
validation report 引用为 binding 证据。该值不是任何可核验 policy 来源的指纹：

- 它不可归因（没有来源、没有可复算输入），违反 ADR-0008 的可追溯要求；
- 若未来环境提供真实 policy hash，占位值必然失配，导致错误失效；若环境恰好一致，则形成
  无来源的伪绑定；
- 占位值被当作真实 binding evidence 使用过，属"伪真实"证据，必须在正式 gate 中按未通过处理。

当前 pilot 的 procedure 是 effectless/permissionless：`declaredEffects=[]`、
`requiredPermissions=[]`、只读确定性静态检测，运行期授权恒为"只读分析"。

## Decision

### 1. permissionPolicyHash 省略语义

- effectless/permissionless procedure（`declaredEffects=[]` 且 `requiredPermissions=[]`）
  必须**显式省略** optional `permissionPolicyHash`。省略语义为"procedure 未绑定该字段 ⇒
  依赖指纹匹配不构成约束"（该语义已在 resolver 实现并注释）。
- **不得使用任何占位值（如 `sha256:4f…`）代替省略**：省略是唯一诚实的表示。

### 2. 非空权限时必填（fail-closed）

- 任一 `declaredEffects` 或 `requiredPermissions` 非空 ⇒ `permissionPolicyHash` 必填，
  且必须是可核验 policy 来源的真实指纹（有来源、可复算）。
- 缺失、格式非法或占位 ⇒ 不满足快路径 eligibility，走父 Skill 慢路径。

### 3. 运行时授权仍独立逐次检查

- 省略 fingerprint 不代表授权要求降低：真实 effect 发生前仍由宿主 `tool_call` block /
  executor 授权 gate 逐次检查，快慢路径使用同一 gate（ADR-0008 "Runtime resolution、
  fallback 与失效"）。
- fingerprint 的 permission 维度只回答"procedure 声明的权限绑定是否仍然一致"；授权本身
  永远是 procedure 之外的运行期事件。

### 4. 4f 占位不得作为真实 binding evidence

- `sha256:4f×32`（及任何同性质占位）不构成 binding evidence；
- 以其为依据的 Gate P3 permission binding 维度**视为未通过** → Gate P3 formal gate reopened
  （component 证据链本身未被否定，见 audit §2.1）。

### 5. Validation evidence 分类

procedure 晋升证据按来源与可复算性分为三类，**不得互相转换**：

| 分类 | 定义 | 示例 |
|---|---|---|
| `automated` | 确定性重算结果，输入冻结后可独立复现，无需人类判断 | held-out replay 指标、structured finding 校验、成本 benchmark 重跑 |
| `static_review` | 由审阅者对冻结输入与产出的静态核对，带 reviewer 身份与时间 | source clause 映射核对、policy 对照、占位/缺失字段审查 |
| `owner_attested` | Owner 对真实来源与环境事实的证明，不可由仓库自动复现 | 真实 policy 指纹来源、真实事件与运行环境归属 |

- promotion 门（ADR-0008）必须在冻结证据要求时**指明每门所需分类与数量**；`owner_attested`
  不得冒充 `automated`，`static_review` 不得声称可自动重放。

### 6. Redacted validation evidence envelope

用于 fresh-clone 一致性复验的脱敏摘要资产，边界如下：

- **用途**：仅对已提交结论做一致性复验——与已提交 validation report 的 frozen/draft 锚点
  比对、脱敏断言、推导链重放。
- **禁止**：进入 Practice Store（store append 必须拒绝非 PracticeEvent 形状）；作为
  production proposal（activation/procedure proposal）的查询输入；声称重新证明 real
  provenance（envelope 重放输出必须显式标记为 evaluation/envelope_replay 来源）。
- **内容限制**：只允许身份/hash/受控枚举/计数/引用；禁止任务文本、路径、工具输出、
  完整 PracticeEvent 及原始 details。
- 真实 provenance 只能由真实 store 事件链产生；envelope 是摘要，不是证据本身。

### 7. Formal runner 与 evaluation 输入隔离

- formal gate runner 必须区分 `formal_real_store` 与 `evaluation_fixture` / `envelope_replay`；
  来源模式由入口决定，不得由事件内自报字段升级。
- 只有默认 project-local Practice Store 的 `formal_real_store` 路径可以执行
  `draft → validated` transition；注入 Store、覆盖 tenant/event IDs、构造事件与 envelope replay
  均只能验证结构和推导一致性，必须保持 `draft`。
- evaluation fixture 不得把构造事件写成 `provenance="real"`；即使测试对象故意伪造该字段，
  formal runner 也必须依靠入口来源模式 fail closed，而不是信任事件自报 provenance。

## Consequences

### Positive

- 消除伪真实占位带来的错误归因与未来意外失效。
- permission binding 维度语义明确：省略（零权限）或真实绑定（有权限），无中间态。
- validation evidence 分类使晋升门可审计、可冻结。

### Negative

- Gate P3 formal gate reopened：需按本 ADR 关闭 permission binding 维度并重跑评审。
- draft builder 的 `permissionPolicyHash` 参数由必填改为可选（数据合同同步，不变量见
  `docs/design/dual-memory-data-contracts.md` §3.2/§9）。

### Neutral

- 运行时授权机制不变：宿主 `tool_call` block 仍是唯一统一授权闸门（0.84.1/0.84.2 已核验）。

## Alternatives Considered

**对 project-local authorization policy manifest 计算真实 hash（即使空规则集）**

- 拒绝：空权限集下 manifest 不会变化，无失效价值；environment 侧没有独立来源可比对，
  形成"自己跟自己比对"；空规则 manifest hash 仍是装饰性真实，存在伪绑定观感；引入新的
  policy 来源概念超出 MVP 最小范围。

**保留占位并标注"待 Owner 提供"**

- 拒绝：占位被误读为真实证据是本次 reopened 的直接原因；等待外部值期间应以省略表达
  零权限事实，而非挂起未知值。

## References

- `docs/adr/0008-practice-evidence-and-procedure-promotion.md`
- `docs/design/dual-memory-data-contracts.md`（§3.2、§4.5、§4.6、§9）
- `docs/research/2026-08-14-phase0-pi-api-inventory.md`（权限/授权核验）
- `docs/reports/2026-08-14-phase4-resolver-gate.md`（§6 待确认项）
- `docs/reviews/2026-08-14-implementation-progress-audit.md`（§2.1、§4）
