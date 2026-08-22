# ADR-0014：主线收缩为低打扰 Discovery 与可归因 Activation Memory

## Status

Accepted — 2026-08-22

本 ADR 取代 ADR-0006 中“双记忆均为当前主线”的范围决定，并冻结 ADR-0008、ADR-0011、
ADR-0012 中面向 `CompiledProcedure` 的后续实施。它不撤销这些 ADR 已建立的安全合同，也不授权
删除已有 procedure、runtime、评测或测试代码。

## Context

当前仓库已经分别实现和验证了 prompt 外 discovery、Practice Store、ActivationProfile，以及
一条 project-local procedure 验证链。但现有证据不支持继续把 Procedural Memory 作为主研究：

- procedure 收益主要来自隔离的静态 pagination pilot 与 project-local shadow/canary，真实宿主
  canary/active 的质量、成本和维护收益未验证；
- 当前 project-local Pi 入口只接 discovery 与 Practice observer，没有启动 procedure 执行入口；
- Activation Memory calibration 显示 positive-only memory 虽能扩大召回，却会显著增加 No-Skill
  与 hard-confuser 误召；
- Selection Memory held-out 支持结构化 positive + boundary Memory 改善候选内 Selection，但 retrieval
  仍是端到端瓶颈，且尚未证明真实 PracticeEvent 能自动形成同质量 Memory。

继续同时维护 discovery、selection memory、activation learning 和 procedure runtime，会扩大接口、
验证矩阵与研究声明，而最重要的用户问题仍未解决：系统是否能少打扰 Agent、少塞上下文，并且只从
真正可归因的 Skill 使用中学习。

## Decision

### 1. 当前主线

当前主线收缩为：

> 在不常驻完整 Skill catalog、不增加 Router LLM 的前提下，只在 Skill 有明显预期增益时向 Agent
> 展示最少候选；只把经过验证、可归因且版本绑定的 Skill 使用证据转化为可撤销 Activation Memory。

主线只回答两个问题：

1. 当前任务是否值得展示任何 Skill？
2. 若值得，最少需要展示哪些 Skill，以及哪些经验足以改善以后“何时使用”的判断？

“选中 Skill 后自动执行多少”不再是当前主线问题。选中后默认读取父 `SKILL.md`，继续由主 Agent
按原始 Skill 约束执行。

### 2. Procedural Memory 冻结语义

自本 ADR 接受起：

- 不新增 `CompiledProcedure` 类型、compiler、resolver、executor、promotion 或宿主接线能力；
- 不把 procedure promotion、canary、active、成本回本或执行快路径列入当前完成标准；
- 不删除、重写或降级现有 procedure/runtime 实现与测试；安全修复、依赖兼容和证据审计仍可在用户
  明确授权的独立任务中进行；
- 现有 procedure ADR、合同、报告和代码标记为 `frozen experimental track`，只作为历史证据、
  comparator 与未来重新立项的基础；
- 当前生产/项目入口不得因为本 ADR 自动启用任何 procedure 快路径。

重新启用该方向必须新增 ADR，并至少提供：真实宿主重复任务分布、慢/快路径 paired evidence、完整
摊销成本、维护与漂移成本、安全非劣、失败回退，以及相对“直接读取 `SKILL.md`”的明确实际增益。

### 3. 主运行路径

当前目标运行路径冻结为：

```text
TaskContext
  -> Exposure Gate: show none | show candidates
  -> Adaptive Candidate Budget: 0 | 1 | bounded multi-skill set
  -> Lightweight Candidate Cards
  -> Main Agent: Skill / Skill Set / No-Skill
  -> selected => load parent SKILL.md
  -> observe redacted evidence
  -> Learning Admission
  -> draft/shadow/active ActivationProfile
  -> prompt-external retrieval/rerank or bounded selection hint
```

`Exposure Gate`、`Candidate Budget` 与 `Learning Admission` 是三个独立 seam。不得用一个综合分数同时
控制候选展示、Skill 相关性和 Memory 晋升。

第一版 `Exposure Gate` 只建立 **shadow observation seam**，不做任务类型分类，也不立即改变当前
候选注入行为：

- 不维护“翻译、改写、问答、聊天、简单任务”等手写类别或规则表；
- 不声称能估计 Skill 的边际收益或任务复杂度；
- 只记录当前 retriever 是否返回候选、候选数量/分数/匹配字段，以及候选最终是否被选择；
- retriever 返回空集合时继续不注入候选；返回非空集合时，第一版仍沿用当前 bounded baseline；
- 只有 shadow 数据证明一个简单、确定性的 retrieval-confidence abstention policy 能在必要 Skill recall
  非劣时降低 No-Skill exposure，才允许新增 ADR/冻结门槛后进入 active suppress；
- 用户显式写出已安装 Skill 的精确 name、ID 或声明 alias，可以作为可审计的 bypass evidence，但不得
  扩展成自然语言意图分类器。

因此第一版的价值是测量和建立 seam，不是假装已经可靠解决“简单任务无需 Skill”。在 active gate
有证据前，主要通过轻量卡、候选预算实验和强化 Agent 的 No-Skill 指导降低干扰。

### 4. Memory 准入

“任务完成”与“Skill 有贡献”必须分开表示和验证：

- positive Activation Memory 只接受 `skill_contribution=verified` 的真实、版本绑定证据；
- 经过验证的 negative、near-miss 与 boundary evidence 可以进入对应负向资料，因为它们是 No-Skill
  与 hard-confuser 判断所必需的证据；
- `mixed`、`unknown`、evaluation、synthetic、来源不明或已失效证据不得参与 active learning；
- Practice Store 可以按最小化保留策略保存 observation，但 observation 不等于长期 Activation Memory；
- 任何派生 cue 必须支持查看、暂停影响、按 evidence 删除和回到作者 metadata 静态基线。

具体字段与状态迁移在实施前按本 ADR 更新数据合同；不得继续把“clean verifier pass”单独解释为
Skill 的因果贡献证明。

### 5. 渐进披露

候选展示采用分层披露：

- Level 0：Exposure Gate abstain，不向 Agent 展示 Skill 区块；
- Level 1：只展示最少候选的 `name + bounded display description + load handle`；load handle 必须保留
  `skill_id + skill_revision`，避免名称歧义和版本漂移；
- Level 2：Agent 选中后才加载完整父 `SKILL.md`；
- Activation Memory 默认留在 prompt 外影响检索或降权。只有候选确有歧义且预算允许时，才可展示
  与该候选绑定的极短 `use/avoid` hint；不得注入完整 ActivationProfile。

“完整 Memory 等最终决定后再加载”不作为 Selection 机制，因为最终决定后 Memory 已无法帮助
“什么时候该用”；其余执行说明仍坚持选中后加载。

### 6. 用户控制

当前主线必须提供以下用户可见能力后，才允许声称 Memory 可控：

- 查看系统记住了哪些 Skill、cue、状态和证据摘要；
- 暂停/恢复新 evidence 持久化与 Activation learning；暂停不得删除已有数据；
- 删除错误 evidence 或 Memory，并级联停止其 active 影响；
- 查看当前是否启用 learning，以及静态 discovery 与 active overlay 的状态。

控制动作必须由用户显式触发并可审计。Agent 不得自行恢复 learning 或绕过删除。

### 7. 证据与完成口径

主线分别报告：

- Exposure：No-Skill exposure FP、展示率、显式 Skill 请求保留率；
- Discovery：Gold Recall@K、multi-skill full-set recall、hard-confuser FP；
- Context：平均/p95 候选数、注入字符/token；
- Selection：Skill/Skill Set/No-Skill exact-set 与 No-Skill FP；
- Learning：positive admission precision、negative/boundary precision、删除与 revision 失效；
- Operations：索引重建率、cache hit、查询 p50/p95；
- Control：list/pause/resume/delete 的功能与持久化证据。

不得用召回提升抵消 No-Skill、安全、隐私或控制回归，也不得把 evaluation fixture、offline comparator
或 project-local smoke 描述为生产 learning E2E。

Exposure shadow 指标通过不等于 active suppress 可发布；任何 active policy 必须保持单一、可解释、
无任务类别词典，并在独立冻结集上证明必要 Skill recall 非劣。

## Consequences

### Positive

- 研究目标与当前最强证据对齐，减少维护面和证据债务。
- 候选展示、相关性和学习准入各自可测，失败更容易定位。
- 保留负向证据，能直接约束 No-Skill 与 hard-confuser 污染。
- Procedure 资产可供未来复用，但不再拖累当前完成标准。

### Negative

- 项目不再声称“逐渐形成部分程序快路径”是当前交付目标，README、研究规范、计划和报告解释必须
  使用新的 applicability note。
- 选中 Skill 后仍需读取完整 `SKILL.md`，暂不追求执行 token 或延迟的程序化节省。
- 增加 Exposure Gate 后存在漏掉必要 Skill 的新风险，必须用显式请求保留率和 Recall 指标约束。

### Neutral

- 现有 procedure 验证结果仍然有效于其原始 project-local 证据范围，但不构成当前生产能力。
- ADR-0013 的 held-out 结果继续作为 Selection comparator；是否将 bounded hint 接入真实 host 仍需
  独立生产设计和验证。

## Alternatives Considered

**立即删除所有 Procedural Memory 代码**

- 拒绝：删除会混淆“当前不投入”与“既有证据无效”，同时扩大迁移和回归风险，且没有帮助解决
  Exposure、No-Skill 或 learning attribution。

**继续双主线，只降低 Procedure 优先级**

- 拒绝：权威文档和完成标准仍会要求维护 procedure 生命周期，无法真正收缩范围。

**只修改候选提示，不增加独立 Exposure Gate**

- 拒绝为最终状态：No-Skill 任务仍会收到候选区块，不能实现“少打扰 Agent”。但第一版 Gate 只做
  shadow observation；没有可靠 suppress 证据前，不为追求形式完整而加入手写分类规则。

**只保存成功正例**

- 拒绝：缺少 verified negative/boundary evidence 会削弱 No-Skill 与 hard-confuser 判断。

## References

- `docs/design/activation-memory-first-architecture.md`
- `docs/adr/0006-dual-memory-skill-architecture.md`
- `docs/adr/0007-prompt-external-skill-discovery.md`
- `docs/adr/0008-practice-evidence-and-procedure-promotion.md`
- `docs/adr/0013-selection-time-skill-memory-context.md`
- `docs/reports/2026-08-20-activation-memory-calibration.md`
- `docs/reports/2026-08-20-selection-memory-context-heldout.md`
