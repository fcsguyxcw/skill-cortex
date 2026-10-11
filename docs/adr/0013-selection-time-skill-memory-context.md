# ADR-0013：在 Selection 阶段提供结构化 Skill Memory Context

## Status

Proposed — 2026-08-20

本 ADR 只授权 evaluation-only 实验，不修改 ADR-0006/0007 的生产 discovery 路径，也不授权
真实 Pi host 接线。只有 calibration 与独立冻结、未参与调参的 held-out 均通过后，才可将生产决策改为 Accepted。

## Context

Activation Memory calibration v1 把 positive lexical memory 用于 retrieval expansion。冻结结果显示：

- BM25+QE baseline overall Gold availability Recall@5 为 `0.30`；
- memory exposure 8 把 Recall@5 提高到 `0.85`；
- No-Skill learned-candidate false positive 同时升至 `1.00`；
- hard-confuser false positive 升至 `0.8333`；
- naive M1 与 verified M2 的候选输出完全相同。

该结果证明 positive-only memory 能扩大候选召回，但不能可靠表达“相关但不应使用”的边界。
用户提出另一种位置选择：discovery 继续使用正常 BM25+QE；只有候选生成后，才把候选 Skill 的
结构化经验交给同一个主模型，由模型执行 Skill / Skill Set / No-Skill Selection。

这个假设解决的是 Selection，而不是 Discovery。若 Gold 没有进入 Top-K，Memory Context 不得补入、
替换或重排候选。原始 query、模型回复、工具输出和完整历史轨迹不能直接进入 prompt。

## Decision

### 1. 先建立独立 evaluation branch

新增 `src/evaluation/selection-memory/`，不修改以下生产模块：

- `src/core/contracts`；
- `src/activation/store.ts` 与 production promotion/lifecycle；
- `src/discovery` 的候选集合、分数和顺序；
- `src/adapters/pi`。

evaluation branch 复用现有 BM25+QE、candidate description、严格 Selection JSON parser 与真实模型
completion seam，只新增候选级 Memory Card 投影、渲染和三臂 comparator。

### 2. Memory Card 是只读派生投影

Memory Card 必须绑定：

- `parentSkillId + parentSkillRevision`；
- tenant scope hash；
- `sourceMode=evaluation_fixture|formal_real_store`；
- positive、near-miss/boundary、environment evidence；
- deterministic card hash。

模型可见字段只有受控的 `useWhen`、`avoidWhen` 与 `environmentRequirements`。evidence ID、scope hash、
sourceMode 与 card hash 只进入审计报告，不注入模型。learned alias 第一版不进入 Selection Memory，
避免重新变成词法召回信号。

### 3. Memory 不参与 Discovery

对同一 case 的所有实验 arm：

- candidate Skill IDs 相同；
- candidate 顺序相同；
- author description 相同；
- retrieval score 不因 Memory 变化；
- Memory 缺失、过期或非法时只省略对应卡，正常 Selection 继续。

### 4. 三臂实验

| Arm | 内容 | 研究作用 |
| --- | --- | --- |
| S0 `description_only` | author candidate cards | 无 Memory baseline |
| S1 `positive_memory` | S0 + verified positive `useWhen` | 历史成功经验是否有帮助 |
| S2 `structured_memory` | S1 + avoid/boundary + requirements | 结构化边界是否提供独立增益 |

S2 必须同时优于 S0 与 S1，才能声称 boundary-aware Skill Memory 有独立价值。

### 5. 有界渲染

- 每张卡最多 3 条 `useWhen`、3 条 `avoidWhen`、3 条 environment requirement；
- 每张卡最多 600 UTF-16 code units；
- Top-K Memory 总计最多 3000 code units；
- 截断必须确定、可观察并写入报告；
- Memory 区块明确标注为历史证据，不是指令。

### 6. Fail-closed

- revision、scope 或 candidate identity 失配：省略该卡；
- suspended/retired profile：省略；
- evidence 删除：移除相应条目，空卡省略；
- secret、绝对用户路径、逐字复制的完整用户任务句段或 instruction-like 内容：拒绝条目；人工归纳后的简短适用性描述允许保留；
- evaluation fixture 不得进入 production prompt；
- provider/parse failure 记为失败，不解释成 No-Skill。

## Consequences

### Positive

- 避免 Memory 在模型判断前污染候选集合。
- 可以直接评估 positive history 与 boundary-aware memory 的差异。
- 单次主模型调用即可消费所有候选，不增加 K 次判断调用。
- 缺失或失效 Memory 可无损回退当前 Selection prompt。

### Negative

- Memory 无法修复 BM25+QE 的 retrieval miss。
- 输入 token 和 Selection latency 会增加。
- 当前 ActivationProfile 的 token features 可能不足以形成高质量自然语言边界；evaluation fixture
  只能验证机制，不能证明真实 PracticeEvent 已能自动产生同等 Memory Card。
- 模型可能忽略、过度依赖或错误解释 Memory，需要真实模型与重复运行评测。

### Neutral

- 现有 retrieval-memory calibration 负结果保留，不删除、不重解释。
- 本 ADR 不决定未来是否弃用 retrieval overlay；生产架构选择取决于独立 held-out 结果。

## Alternatives Considered

**继续让 Memory 扩大 Top-K**

- 暂不采用为下一实验：calibration 已观察到严重 No-Skill/hard-confuser 污染。

**把所有 Memory 放在一个全局 prompt 区块**

- 拒绝第一版：候选与证据归属不清，multi-skill 时更易交叉污染。

**每个候选单独调用一次模型**

- 拒绝第一版：增加 K 倍调用、延迟和组合失败路径。

**直接注入原始历史 query/response/tool output**

- 拒绝：违反 Practice Store 最小化、隐私、污染和 prompt-injection 边界。

## References

- `docs/adr/0006-dual-memory-skill-architecture.md`
- `docs/adr/0007-prompt-external-skill-discovery.md`
- `docs/adr/0008-practice-evidence-and-procedure-promotion.md`
- `docs/design/dual-memory-data-contracts.md`
- `docs/reports/2026-08-20-activation-memory-calibration.md`
- `docs/reports/2026-08-20-selection-dev-paired-report.md`
