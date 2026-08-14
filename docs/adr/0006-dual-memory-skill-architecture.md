# ADR-0006：Activation Memory 与 Procedural Memory 双记忆架构

## Status

Accepted — 2026-08-14

Supersedes ADR-0001 and ADR-0002.

## Context

项目最初把 skill discovery、文本渐进披露、从轨迹创造新技能和 habit 编译混在同一套层级模型中，随后又把 routing-only 放大成第一阶段主研究。当前冻结的研究对象更窄：用户已经安装了声明式 Skill；Agent 在真实使用中逐渐学习何时应激活该 Skill，以及其中哪些稳定步骤可以在满足条件时不再重新阅读和推导完整 `SKILL.md`。

这包含两个正交问题：

- Discovery：当前任务可能需要哪个已有 Skill？
- Execution：Skill 被选中后，应执行已验证 procedure，还是读取完整 `SKILL.md` 并恢复 LLM 慢路径？

如果用一个统一的 `maturity` 或置信度同时控制二者，常用 Skill 会因为被频繁选择而越来越容易被再次选择，并可能在证据不足时获得更高执行自治，形成不可归因的自强化循环。

## Decision

采用一个外部 Skill Registry 和两类彼此独立的派生记忆。

### Installed Skill 是语义来源

每个已安装 Skill 由稳定 `skill_id` 下的不可变版本表示，至少绑定：

- `skill_revision`；
- `source_hash`；
- 作者提供的 `name`、`description`、`SKILL.md`、scripts 与 references；
- scope、依赖、权限和来源信息。

原始 Skill package 是语义、约束和权限的最终来源。派生记忆不得覆盖或改写作者内容。

逻辑文档统一使用 `skill_revision`；TypeScript 字段映射为 `skillRevision`。`source_hash`/`sourceHash` 只表示内容指纹，不承担 revision 身份语义。

### Activation Memory

Activation Memory 只回答“什么情况下应把父 Skill 召回为候选”，可以保存：

- 经验证的成功任务示例；
- negative 与 near-miss 示例；
- 别名、跨语言表达和 learned cues；
- 环境要求、scope 与已知混淆对象；
- 证据来源、版本和适用范围。

Activation Memory 是父 Skill 的派生激活资料，不是新的 Skill，也不能仅凭使用频率提高召回权重。

### Procedural Memory

Procedural Memory 只回答“父 Skill 被选中后，哪些步骤可以走受约束快路径”，每个 Compiled Procedure 必须绑定父 Skill，并至少包含：

- `procedure_id` 与版本；
- `applicable_when` 和前置条件；
- 已覆盖步骤与仍需 LLM 判断的 `llm_holes`；
- 参数、依赖、权限清单和允许的 effect；
- 后置条件、外部 verifier 与失败守卫；
- 来源轨迹、验证证据和回滚点。

Procedure 不进入全局 discovery 候选集合，不得脱离父 Skill 独立获得权限。

### Practice Store

真实调用产生不可变 Practice Events。Activation Memory 和 Procedural Memory 可以读取同一证据库，但必须通过独立的提案、验证和发布流程更新，不能共享一个模糊的“熟练度”分数。

评测轨迹、包含秘密或来源不明的数据不得自动进入长期记忆。数据治理和晋升规则由 ADR-0008 规定。

### Runtime 路径

```text
User Task
   -> prompt 外 discovery
   -> Skill / Skill Set / No-Skill
   -> Execution Resolver
      -> procedure 存在且版本、前置条件、权限与守卫匹配
         -> 执行受约束快路径
         -> 检查后置条件
      -> 不存在、不匹配或检查失败
         -> 加载父 Skill 的完整 SKILL.md
         -> 恢复 LLM 慢路径
   -> 写入可审计 Practice Event
```

`SKILL.md`、工具 schema、权限、模型或关键环境依赖发生变化时，相关派生资料必须按绑定条件失效或重新验证。熟练化不得降低审批、授权、sandbox 或不可逆操作的安全门槛。

## Consequences

### Positive

- Skill discovery 与执行自治可以独立评测和归因。
- 已安装 Skill 的真实使用经验同时改善激活线索与执行成本，但不会把 procedure 膨胀成新的候选 Skill。
- 原始 `SKILL.md` 始终提供可恢复的慢路径和语义依据。
- 来源、版本、验证证据与回滚点均可审计。

### Negative

- 需要维护 Registry、Practice Store 和两类派生资料之间的版本关系。
- 编译和验证产生一次性成本，只有被充分复用后才可能回本。
- 部分任务始终需要 LLM 判断，不能为了“成熟”而强行完全程序化。

### Neutral

- 人类熟练化只是机制启发，不构成生物学等价声明。
- 本 ADR 不规定具体索引、存储引擎、DSL 或编程语言。

## Alternatives Considered

**从自由轨迹直接创造新的 Skill**

- 拒绝为当前主线：这是不同且已有大量先行工作的研究问题，也会模糊用户安装 Skill 的所有权和语义边界。

**安装时立即编译整份 `SKILL.md`**

- 拒绝：缺少真实使用分布、失败边界和稳定步骤证据；当前研究关注经验引导的渐进式部分程序化。

**用统一 maturity 分数同时控制召回与执行**

- 拒绝：会产生选择频率自强化，并把“相关性”“条件满足”“执行成功”三个不同概率混为一谈。

**Ability -> Skill -> Procedure 硬目录树**

- 拒绝为必经路径：顶层误判会传播，跨类别 Skill 难以表达。Ability 可以是检索字段，但不能成为硬门。

## References

- `docs/adr/0007-prompt-external-skill-discovery.md`
- `docs/adr/0008-practice-evidence-and-procedure-promotion.md`
- `docs/reviews/2026-08-14-skill-cortex-audit.md`
- `docs/research/2026-08-14-experience-guided-installed-skill-proceduralization.md`
