# 双记忆 Skill 系统：数据合同

状态：Partially superseded by ADR-0014 — 2026-08-22
适用范围：MVP 与后续多 Agent 实施  
权威决策：ADR-0006、ADR-0007、ADR-0008

Applicability：`SkillRecord`、`SkillCandidate`、`ActivationProfile`、`PracticeEvent`、数据隔离与删除
继续作为当前主线兼容合同；`CompiledProcedure`、`ExecutionDecision` 和 procedure 状态机冻结，只约束
既有实验资产。新的 Exposure、Candidate Budget、Learning Admission 与用户控制设计见
`docs/design/activation-memory-first-architecture.md`，对应 schema 在进入实施阶段时另行冻结。

## 1. 合同目标

本文件冻结系统边界与数据所有权，不冻结编程语言、数据库或宿主 API。当前工作区没有源码、包管理配置或可用的宿主 SDK 文档，因此本文中的 TypeScript 形状只是语言无关的数据契约表示，不代表已存在的接口。

系统围绕一个不可混淆的分工构建：

```text
Discovery / Activation Memory：这次可能需要哪个已安装 Skill？
Execution / Procedural Memory：选中 Skill 后，这次能自动执行多少？
```

## 2. 全局不变量

1. 原始 Skill package 是语义、权限和来源的权威记录；派生数据不得覆盖它。
2. `CompiledProcedure` 必须属于一个父 `SkillRecord`，不得成为独立 discovery 候选。
3. Skill 的使用频率、procedure 数量或执行成熟度不得直接提高 discovery 相关性。
4. `ActivationProfile` 只能补充检索证据，不能删除作者声明、扩大 scope 或把软负例变成硬过滤。
5. 每个派生产物必须带父 Skill revision 与 provenance；无法解释来源的派生产物不得激活。
6. 父 Skill、工具 schema、权限或相关环境依赖变化时，受影响的 procedure 必须先失效再验证。
7. 独立 authorization gate 位于 procedure 之外；熟练度不能降低授权要求。
8. Practice 数据默认最小化、隔离并可删除；评测轨迹不得回写学习库。
9. MVP 只允许确定性、可回放、只读或幂等 procedure；非幂等副作用不进入自动快路径。
10. 安全、正确性和回退门槛是硬约束，不能被 token 或延迟收益抵消。

## 3. 标识与版本

### 3.1 逻辑 Skill 与 revision

- `skill_id`：一个安装实例的稳定逻辑标识，由宿主 adapter 分配。算法必须在 Phase 0 根据真实宿主能力冻结；不得假定宿主已经提供 ID。
- `skill_revision`：原始 Skill package 相关内容的不可变 revision。
- `source_hash`：至少覆盖 `SKILL.md`；若 procedure 依赖 scripts、references 或 assets，必须把这些依赖纳入 revision manifest。它只表示内容指纹，不承担 revision 身份语义。
- 同名但不同 scope/path 的 Skill 必须拥有不同 `skill_id`。
- 移动、重命名与跨设备同步的身份策略在 Phase 0 明确；未明确前按新安装实例处理，避免错误继承经验。

### 3.2 依赖指纹

```ts
interface DependencyFingerprint {
  sourceHash: string;
  toolSchemaHash?: string;
  permissionPolicyHash?: string;
  environmentClass?: string;
  modelId?: string;       // 仅含 LLM hole 时必需
  promptHash?: string;    // 仅含 LLM hole 时必需
}
```

纯确定性 procedure 不得因为无关模型变更而失效；含 `llm_holes` 的 procedure 必须绑定相关模型与 prompt。

`permissionPolicyHash` 的省略/必填语义（ADR-0011）：

- effectless/permissionless procedure（`declaredEffects=[]` 且 `requiredPermissions=[]`）必须**显式省略**该字段；省略语义为“procedure 未绑定该字段 ⇒ 依赖指纹匹配不构成约束”。不得使用占位值（如 `sha256:4f…`）代替省略。
- 任一 `declaredEffects` 或 `requiredPermissions` 非空 ⇒ `permissionPolicyHash` 必填，且必须是可核验 policy 来源的真实指纹（fail-closed；缺失/占位 ⇒ 不满足快路径 eligibility）。
- 省略 fingerprint 不降低授权要求：运行时授权仍由 procedure 之外的宿主 gate 逐次检查（ADR-0008、ADR-0012 §5）。

## 4. 核心实体

### 4.1 SkillRecord

`SkillRecord` 表示用户已经安装的 Skill 的一个不可变 revision。

```ts
interface SkillRecord {
  schemaVersion: 1;
  skillId: string;
  skillRevision: string;
  name: string;
  description: string;
  scope: "project" | "user" | "temporary";
  sourceLocator: string;
  sourceHash: string;
  disableModelInvocation: boolean;
  declaredAliases: string[];
  declaredEffects: string[];
  declaredPermissions: string[];
  dependencyManifest: Array<{
    locator: string;
    contentHash: string;
    role: "instruction" | "script" | "reference" | "asset";
  }>;
  discoveredAt: string;
}
```

所有者：Skill Registry。  
写入者：宿主 adapter。  
不可由 Activation Learner 或 Procedure Compiler 修改。

### 4.2 SkillCandidate

只有候选卡进入主 Agent 上下文；完整 catalog 留在 prompt 外。

```ts
interface SkillCandidate {
  skillId: string;
  skillRevision: string;
  name: string;
  description: string;
  scope: SkillRecord["scope"];
  retrievalScore: number;
  evidence: Array<
    | { kind: "declared_text"; field: "name" | "description" | "alias" }
    | { kind: "learned_cue"; cueId: string }
  >;
}
```

`retrievalScore` 只表达任务相关性，不包含 procedure maturity、使用次数或历史执行成本。

### 4.3 ActivationProfile

`ActivationProfile` 是 discovery 的可撤销派生层，保存经过归因与验证的检索证据。

```ts
interface ActivationProfile {
  schemaVersion: 1;
  profileId: string;
  parentSkillId: string;
  parentSkillRevision: string;
  status: "draft" | "shadow" | "active" | "suspended" | "retired";
  learnedAliases: Array<{ cueId: string; text: string; evidenceIds: string[] }>;
  positiveExamples: Array<{ cueId: string; features: string[]; evidenceIds: string[] }>;
  nearMissExamples: Array<{ cueId: string; features: string[]; evidenceIds: string[] }>;
  environmentCues: Array<{ key: string; valueClass: string; evidenceIds: string[] }>;
  createdAt: string;
  updatedAt: string;
}
```

约束：

- 不保存未经批准的完整用户文本；优先保存脱敏特征与 evidence reference。
- `nearMissExamples` 只能降权或提供解释，不能在召回阶段硬排除。
- profile 关闭后，系统必须能无损回到作者 metadata 的静态 discovery。
- 每个 cue 可追溯、可删除、可按父 revision 失效。

### 4.4 PracticeEvent

`PracticeEvent` 是 append-only 的证据记录，不直接代表“Skill 成功”。

```ts
interface PracticeEvent {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  tenantScope: string;
  provenance: "real" | "shadow" | "evaluation" | "synthetic";
  parentSkillId: string;
  parentSkillRevision: string;
  sourceHash: string;
  routeDecisionId?: string;
  candidateSkillIds: string[];
  selectedSkillIds: string[];
  executionMode: "skill_md" | "compiled_procedure";
  procedureId?: string;
  redactedTaskFeatures: string[];
  environmentFingerprint?: string;
  dependencyFingerprint?: DependencyFingerprint;
  stepSummaries: Array<{
    stepId: string;
    actor: "agent" | "procedure" | "tool" | "user";
    operationClass: string;
    outcome: "ok" | "failed" | "unknown";
  }>;
  authorizationResults: Array<{
    gateId: string;
    result: "approved" | "denied" | "not_required" | "unknown";
  }>;
  guardResults: Array<{
    predicateId: string;
    phase: "precondition" | "runtime" | "postcondition";
    result: "pass" | "fail" | "unknown";
  }>;
  verifierResults: Array<{
    verifierId: string;
    result: "pass" | "fail" | "unknown";
    observedEffect?: string;
  }>;
  attribution: "verified_skill_effect" | "mixed" | "unknown";
  failureClass?:
    | "precondition_mismatch"
    | "runtime_guard_failure"
    | "procedure_error"
    | "tool_failure"
    | "environment_drift"
    | "permission_denied"
    | "postcondition_failure"
    | "user_interruption"
    | "unknown";
  firstAttributableFailureStepId?: string;
  sensitivity: "none" | "internal" | "confidential";
  retentionClass: string;
}
```

所有者：Practice Store。  
写入者：宿主 observer，经脱敏与 policy gate。  
消费者：离线 Activation Learner、Procedure Compiler 与评估器。

`candidateSkillIds` 与 `selectedSkillIds` 是当次 discovery 决策的快照，不是 gold label。`dependencyFingerprint` 只记录政策允许且与归因有关的版本事实。`firstAttributableFailureStepId` 只有在证据足够时填写；未知不得猜测。

`boundary evidence` 和 `external failure` 的所有权留在 `PracticeEvent` 与离线 proposal。只有经过 discovery 回放验证、并被转换为具体 alias/example/environment cue 的证据才能进入 `ActivationProfile`；失败类别不得直接复制成 active cue。

禁止：

- 把“任务完成”自动改写成 `verified_skill_effect`。
- 把 `evaluation` 或 `synthetic` 事件混入生产学习数据。
- 默认保存秘密、完整文件、完整对话或工具原始输出。

### 4.5 CompiledProcedure

`CompiledProcedure` 是父 Skill 的部分执行快路径，而不是替代 Skill 的新 Skill。

```ts
interface CompiledProcedure {
  schemaVersion: 1;
  procedureId: string;
  parentSkillId: string;
  parentSkillRevision: string;
  procedureRevision: string;
  status: "draft" | "validated" | "canary" | "active" | "suspended" | "retired";
  dependencyFingerprint: DependencyFingerprint;
  inputSchema: object;
  preconditions: Array<{ predicateId: string; description: string }>;
  coveredSteps: Array<{
    stepId: string;
    sourceClauseRefs: string[];
  }>;
  forbiddenAutomationSteps: string[];
  runtimeGuards: Array<{
    predicateId: string;
    description: string;
    beforeStepIds: string[];
  }>;
  llmHoles: Array<{
    holeId: string;
    purpose: string;
    inputBoundary: string[];
    outputSchema: object;
  }>;
  declaredEffects: string[];
  requiredPermissions: string[];
  postconditions: Array<{ verifierId: string; description: string }>;
  artifactLocator: string;
  artifactHash: string;
  evidenceIds: string[];
  validationReportId: string;
  previousStableRevision?: string;
  createdAt: string;
}
```

procedure 必须满足：

- 权限集合是父 Skill 与当前授权政策允许集合的子集。
- 未覆盖步骤仍由原始 Skill 慢路径或显式 `llm_holes` 处理。
- 适用条件、依赖指纹或验证器缺失时不得执行。
- 每个 covered step 必须映射到父 `SKILL.md` 条款；禁止自动化步骤不得出现在 artifact 的可执行路径中。
- 任一 runtime guard 为 `fail` 或 `unknown` 时，必须在下一 effectful step 前停止快路径并记录 `PracticeEvent`；只能在不会重复既有副作用时回退。
- 中途失败不得自动重放已发生的非幂等动作；MVP 直接禁止此类 procedure。
- 选中 Skill 身份必须与 procedure 绑定一致：`selectedSkill.skillId === procedure.parentSkillId`；不一致 ⇒ `parent_skill_mismatch`，不得执行（ADR-0012 §3）。
- artifact 执行必须返回结构化 `disposition ∈ {completed, abstained}`；`abstained` 表示无副作用放弃/越界，走回退路径（ADR-0012 §4）。

### 4.6 ExecutionDecision

```ts
interface ExecutionDecision {
  decisionId: string;
  skillId: string;
  skillRevision: string;
  executionContext: "shadow_replay" | "canary" | "active" | "unknown";
  mode: "compiled_procedure" | "skill_md" | "abstain";
  procedureId?: string;
  checkedPreconditions: Array<{ predicateId: string; result: boolean | "unknown" }>;
  authorizationRequired: boolean;
  reason:
    | "eligible_procedure"
    | "no_procedure"
    | "parent_skill_mismatch"
    | "revision_mismatch"
    | "dependency_mismatch"
    | "precondition_failed"
    | "authorization_required"
    | "unsupported_effect"
    | "insufficient_evidence"
    | "no_skill_selected";
  fallbackMode: "load_parent_skill" | "bounded_reasoning" | "abstain";
}
```

所有者：Execution Resolver。  
`authorizationRequired` 只是声明，真正授权由外部 gate 完成。

`executionContext` 声明本次执行所处的释放门控上下文（ADR-0012）：`shadow_replay` 允许
`validated/canary/active` 且不产生用户可见 effect；`canary` 只允许 `canary`；`active` 只允许
`active`；resolver 将缺失/非法输入规范化为 `unknown` 并 fail closed（不进入快路径）。

每次执行须携带显式的 authorization claims 对象，同时包含 `effects` 与 `permissions` 两数组
（两维分离，不合并、不写“并集”）；数组为空当且仅当 procedure 对应声明为空；不得用占位
字符串（ADR-0012 §5）。当前 artifact 没有 step-level effect plan，`requestedEffects` 必须与
`declaredEffects` 精确相等；Phase 4 resolver 已按该契约实现集合精确相等检查（顺序不敏感，子集、超集与重复项均不放行）。

`parent_skill_mismatch` 表示 `selectedSkill.skillId !== procedure.parentSkillId`（选中了错误的
父 Skill），在 revision 检查之前判定（ADR-0012 §3）。

## 5. 逻辑接口

以下是平台无关的逻辑合同，不是已验证的 Pi API：

```ts
interface SkillMemoryCore {
  discover(taskContext: unknown): Promise<SkillCandidate[]>;
  resolveExecution(
    skillId: string,
    taskContext: unknown,
    environment: unknown,
  ): Promise<ExecutionDecision>;
  appendPracticeEvent(event: PracticeEvent): Promise<string>;
  proposeActivationUpdate(skillId: string, evidenceIds: string[]): Promise<string>;
  proposeProcedure(skillId: string, evidenceIds: string[]): Promise<string>;
}
```

宿主 adapter 负责把真实 lifecycle event 映射到这些接口。Phase 0 未验证的 lifecycle、持久化或权限方法不得按上述名称直接实现。

## 6. 状态机

### 6.1 ActivationProfile

```text
draft → shadow → active → suspended → retired
          ↑          │          │
          └──────────┴──────────┘ 重新验证后可回 shadow
```

- `shadow`：计算但不改变 active discovery。
- `active`：只作为静态 metadata 结果的软 rerank/补充证据。
- 任一退化、安全或删除请求均可使其 `suspended`。

### 6.2 CompiledProcedure

```text
draft → validated → canary → active → suspended → retired
            ↑          │         │
            └──────────┴─────────┘ 修订后必须重新验证
```

- 不允许 `draft → active`。
- 依赖 mismatch 会立即进入 `suspended`，不得边运行边修复。
- rollback 指向 `previousStableRevision`；不存在稳定版本时走父 Skill 慢路径。

## 7. 数据隔离与删除

- `tenantScope` 至少区分用户与项目；不得默认跨项目共享 Practice 数据。
- evaluation 数据、真实用户数据与 synthetic 数据物理或逻辑分区。
- 学到的 cue、procedure 与其 evidence references 必须支持级联删除。
- 原始 Skill 被卸载时，派生数据进入 suspended；是否保留等待重装由保留政策决定。
- 保存期限、加密与跨设备同步属于 Phase 0 的显式产品决定，不能由实现者自行选择。

## 8. 兼容与迁移

- schema 增加字段时保持向后读取；破坏性变化提升 `schemaVersion`。
- 未知字段必须忽略或保留，不得静默改变权限语义。
- 旧 procedure 不满足当前合同则标记 `suspended`，不得自动推断缺失的守卫。
- 原始 Skill revision 更新后，ActivationProfile 可以复用的 cue 也必须先进入 shadow 重新验证；CompiledProcedure 默认失效。

## 9. 验收检查

- [ ] 同名不同 scope/path 的 Skill 不共享 `skill_id`。
- [ ] 全量 catalog 不出现在主 prompt；候选卡包含完整可区分描述。
- [ ] `retrievalScore` 不读取 procedure maturity 或使用次数。
- [ ] Procedure 不能脱离父 Skill revision 存在。
- [ ] 每个 covered step 可追溯父条款，且 forbidden step 与 runtime guard 有合同测试。
- [ ] 修改 source/tool schema/permission 后受影响 procedure 失效。
- [ ] 含 LLM hole 的 procedure 绑定模型与 prompt；纯确定性 procedure 不绑定无关模型。
- [ ] Evaluation trace 不进入生产学习库。
- [ ] `firstAttributableFailureStepId` 若存在，必须引用当次 `stepSummaries` 中失败的步骤；未知时保持空值。
- [ ] 权限 gate 在快慢路径中行为一致。
- [ ] Authorization claims 同时携带 `effects` 与 `permissions` 两数组（两维分离，不合并）；数组为空当且仅当 procedure 对应声明为空；不得用占位字符串（ADR-0012 §5）。
- [ ] 失败可回到父 Skill 或合法 abstain，且不重复非幂等副作用。
- [ ] ExecutionContext 缺失/unknown 时不进入快路径（fail-closed）；`shadow_replay` 不产生用户可见 effect；`canary` 只允许 `canary`；`active` 只允许 `active`（ADR-0012）。
- [ ] `selectedSkill.skillId === procedure.parentSkillId` 不成立时返回 `parent_skill_mismatch` 并走慢路径/拒绝（ADR-0012）。
- [ ] effectless/permissionless procedure 显式省略 `permissionPolicyHash`；声明非空权限时该字段必填且为真实指纹；占位值不得作为 binding evidence（ADR-0011）。
- [ ] artifact 执行返回结构化 `disposition ∈ {completed, abstained}`（ADR-0012）。
- [ ] ActivationProfile 和 Procedure 均可按 evidence 删除、暂停与回滚。

## 10. 仍待 Phase 0 冻结的决定

1. 首个实现宿主及源码目录。
2. `skill_id` 的宿主映射与 move/rename 语义。
3. Practice Store 的持久化介质、保留期限和删除接口。
4. 可用的 pre-agent、post-execution、tool observation 与 authorization hook。
5. 首个可回放、只读或幂等实验 Skill 及其外部 verifier。
6. FTS/BM25 的具体实现和 tokenizer；embedding 不属于默认 MVP。
