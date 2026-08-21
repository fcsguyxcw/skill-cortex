# Skill Memory Baseline：Experience-Guided Activation Memory

日期：2026-08-20  
状态：**Calibration v1 已运行但安全门不通过；held-out 保持 untouched**

## 1. 研究对象

本实验研究：经过验证、可归因的 Skill 使用经验，能否生成新的 activation cues，使未来措辞不同、
跨语言或包含 hard confuser 的任务更准确地召回已安装 Skill。

它不是 exact-key cache，也不新增第三类 memory。实现必须复用现有链路：

```text
PracticeEvent
  → cue induction
  → ActivationProfile draft
  → shadow evaluation
  → promotion gate
  → active discovery overlay
```

作者提供的 `name / description / declaredAliases` 仍是不可变语义来源；learned aliases、positive、
negative 与 near-miss cues 只存在于父 Skill 的派生 `ActivationProfile`，不得覆盖 catalog。

## 2. Research Questions

- **RQ1 — Generalization**：Activation Memory 是否提高未见 query 的 Gold availability Recall@K？
- **RQ2 — Sample efficiency**：从 0、1、2、4、8 条 verified experience 增长时，收益曲线如何？
- **RQ3 — Complementarity**：Activation Memory 相对静态 Query Expansion 是否仍提供独立增益？
- **RQ4 — Safety**：提升召回时，No-Skill、hard-confuser、错误归因和 stale memory 是否保持非劣？
- **RQ5 — End-to-end**：候选可用率改善是否转化为相同主模型下的 exact Skill-set 改善？

不把本地 BM25 延迟节省或 exact-query cache 命中作为主要研究 claim。132 Skill 下 BM25+QE 已是
亚毫秒路径，且同一 query 的候选集合确定；exact cache 不会证明经验泛化或 Selection 稳定性。

## 3. Retrieval × Memory producer factorial

| Condition | Retriever | Producer | 回答的问题 |
|---|---|---|---|
| A | BM25 | M0 none | 原始词法 baseline |
| B | BM25 + static QE | M0 none | 强静态 retrieval baseline |
| C1 | BM25 | M1 naive | 直接保存 query 词法特征能带来多少收益 |
| C2 | BM25 | M2 verified | verified formation 相对 BM25 的收益 |
| D1 | BM25 + static QE | M1 naive | naive memory 在强 retriever 上的边际收益 |
| D2 | BM25 + static QE | M2 verified | 完整 treatment 与互补性 |

六条件必须共享相同 catalog、Top-K、候选卡格式和静态 BM25 参数。C1/C2/D1/D2 只能使用当前
learning-curve 前缀形成的 evaluation artifact；不得读取 held-out 输出。

### 3.1 M0 / M1 / M2

- **M0**：不形成 memory。
- **M1 naive**：从成功 query 直接提取受控词法特征。它故意不要求独立 verifier，只作为
  evaluation-only 弱基线，永不写 Store、永不晋升。
- **M2 verified**：必须由 `PracticeEvent` 的 attribution、verifier、父 Skill revision、source 与
  evidence-bound semantic features 形成。Production 使用既有 induction/promotion；fixture 使用
  独立 evaluation seam，保留 `evaluation_fixture` 来源且永不持久化。

M2 必须相对 M1 报告差值。否则实验只能证明“保留任务关键词有效”，不能证明 verified memory 有效。

### 3.2 Evaluation retrieval seam

当前生产 `applyActiveProfiles` 只对静态 BM25 已返回的候选软重排，因此不能恢复完全不在静态
Top-K 的 Gold。离线实验新增显式 memory channel：对 evaluation profile 的 cue 做匹配，把身份与
revision 均匹配的父 Skill 补入候选池，再与静态候选统一排序并截断 Top-K。

该 seam 只证明 learned-cue recall expansion 的 component 行为，不是 production/host parity。
如果 calibration 证明有价值，后续须单独设计并验证生产索引或 learned-cue retrieval channel；
不得用离线 runner 结果宣称现有 Pi host 已改善 recall。

## 4. Causal Negative Controls

负对照不参与主分数，只验证机制价值来自 verified、attributable、version-bound learning：

1. **Shuffled profile**：把 Skill A 的 cues 绑定到 Skill B；应被身份检查拒绝或造成可观察退化。
2. **Unverified success**：只有模型选择/成功声明，没有 verified evidence；不得生成 active profile。
3. **Stale revision**：父 `skillRevision` 改变；profile 必须回 shadow 或不生效。
4. **Deleted evidence**：删除 profile 引用的 evidence；受影响 profile 必须 suspend。
5. **Cross-scope profile**：不同 tenant/project 的 profile 不得参与当前 retrieval。
6. **Near-miss contamination**：相似任务实际需要 confuser Skill；positive cue 不得硬过滤正确候选。
7. **Query leakage**：experience/cue 与 calibration/held-out 的 exact match、Jaccard 或 evaluation
   containment 超过冻结阈值时，在 retrieval 前停止。

## 5. Data Split

所有 Gold 只相对于冻结 catalog snapshot 成立，必须在任何模型/检索结果出现前由人工复核。

### 5.1 Experience set

每个目标 Skill 准备 8 条 verified positive experience，组成嵌套前缀：

```text
E0 = []
E1 = [e1]
E2 = [e1,e2]
E4 = [e1..e4]
E8 = [e1..e8]
```

同一个 learning-curve 点始终使用前一点的超集，避免不同样本组成伪造曲线。Experience 只能作为
induction 输入，不直接作为 cue，也不得与 calibration/held-out 共享完整 query 或模板。

每个 Skill 另外准备 boundary、near-miss 与 external-failure 事件；只有合同允许的类别可进入 cue
proposal。Evaluation/synthetic 事件必须保持 `evaluation_fixture`，不能改标为真实经验。

### 5.2 Calibration set

只用于 profile shadow evaluation、promotion threshold 和静态 QE 规则冻结。至少覆盖：

- positive paraphrase；
- cross-language；
- hard-confuser；
- No-Skill；
- multi-skill full-set availability。

Calibration 输出可反复查看，但不得进入 Practice Store 或成为 experience evidence。

### 5.3 Untouched held-out

在所有 cue induction、QE 规则、Top-K、门槛和模型配置冻结后一次性运行。必须满足：

- query 与 experience/calibration 不重复；
- 不机械复制 Skill name/description；
- 中文/英文均衡；
- single/multi/no-skill/hard-confuser 分栏；
- 包含同一意图的新措辞，而非 exact-query 重放；
- 运行后转为 revealed regression set，不再用于调参。

## 6. Metrics

### 6.0 Formation metrics

- 各 exposure 点的 producer 输入数、产出 cue 数与 cue/evidence ratio；
- evidence completeness 与父 revision binding；
- unverified/external/boundary 输入的 reject/ignore/proposal-only 结果；
- M1 与 M2 的 cue 数、词汇覆盖和 leakage 指标；
- sourceMode 与 persistence eligibility。

### 6.1 Discovery primary metrics

- Gold availability Recall@K；
- multi-skill full Gold-set availability；
- per-Gold recall；
- Gold rank / MRR；
- No-Skill candidate false-positive rate；
- hard-confuser recall/false-positive；
- learned cue coverage；
- 0/1/2/4/8 experience learning curve。

### 6.2 Selection metrics

使用同一真实主模型、温度、thinking、prompt、Top-K 和顺序：

- exact Skill-set accuracy；
- Gold-available 条件下 exact Skill-set accuracy；
- No-Skill accuracy；
- invalid/unlisted Skill ID；
- strict parse failure。

Activation Memory 只直接声称改善候选可用性。只有候选改善同时转化为 exact-set 改善时，才报告
end-to-end Selection 增益；不得把模型随机性归因给 memory。

### 6.3 Safety and invalidation

- shuffled/unverified/cross-scope rejection；
- revision drift reversion；
- evidence deletion suspension；
- static Gold preservation；
- No-Skill 与 confuser 非劣；
- sourceMode 与 evidence provenance 分栏。

不使用加权总分。Recall、No-Skill、confuser、Selection、失效与成本分别判门。

## 7. Protocol Order

1. 冻结目标 Skill 和 catalog identity。
2. 人工编写并复核 experience/calibration/held-out；计算独立 hash。
3. 只用 experience 前缀分别执行 M1/M2 formation；M2 必须经过 induction seam，不接受人工成品 cue。
4. 只用 calibration 执行 shadow evaluation 和 promotion gate。
5. 运行 A/B/C/D component ablation 与 0/1/2/4/8 learning curve。
6. 冻结模型配置和 Selection 阈值。
7. 一次性运行 untouched held-out real-model Selection。
8. 最后接真实 host PracticeEvent → profile proposal → active overlay 的 longitudinal E2E。

上一步 gate 未关闭不得启动下一步。Component fixture 不能冒充真实经验或 host E2E。

## 8. Stop Conditions

出现以下任一情况时停止晋升并报告，不为了得到正结果修改 Gold：

- D 相对 B 没有独立 Recall@K 增益；
- No-Skill 或 hard-confuser 退化超过 calibration 冻结容忍值；
- shuffled/unverified/cross-scope profile 能进入 active retrieval；
- revision/evidence 漂移后 profile 仍生效；
- learning curve 只在 exact-query 或复制 description 时改善；
- M2 相对 M1 没有增益，或增益完全可由 query-token leakage 解释；
- held-out 结果已揭示但 protocol/hash 不完整。

## 9. Rejected Baseline：Verified Candidate Cache

Exact-key candidate cache 可作为工程微基准，但不作为本研究的 Skill Memory：

- BM25+QE 同 query 本来确定，candidate-set stability 无提升空间；
- cache hit 后仍运行相同 Selection，不能控制模型随机性；
- 恢复相同候选卡不减少 Selection prompt tokens；
- 当前 132 Skill 下只节省约亚毫秒本地检索。

因此主实验聚焦“经验能否产生可泛化且安全的 activation cues”。
