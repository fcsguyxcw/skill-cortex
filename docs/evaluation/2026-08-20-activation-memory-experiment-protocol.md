# Activation Memory Experiment Protocol v1

日期：2026-08-20  
状态：**Calibration v1 已运行并判定不通过；held-out/model 未运行**

Formation contract hash：`sha256:a3372888d4ab4b4fb6deae36453457a29f71c676ac3f3f49942eb38f2b265541`

Frozen fixture hash：`sha256:5f2bd1da0372601cba3cc45ee5285c2243f4024ffc4950abbd098f46a8570a30`  
Calibration config hash：`sha256:770e80357df5a2f5e11334844a9c2748ef5fca899fa28300b38bf3ca674748c1`

Calibration report：`docs/reports/2026-08-20-activation-memory-calibration.json`  
Report hash：`sha256:18853ae73ed77444123e774bb0b24d42d6f64d04ad440a7f44c4858bab9342b0`

## Objective

评估 verified experience-derived ActivationProfile 是否在未见 query 上改善 installed Skill discovery，
并且相对 BM25 + static Query Expansion 不降低 No-Skill、hard-confuser、版本失效和证据治理边界。

## Frozen decisions

- 复用现有 `PracticeEvent → induction → ActivationProfile → promotion → overlay`，不新增 cache store；
- retrieval 与 memory producer 作为两个独立实验因子；
- learning-curve exposure 固定为 0/1/2/4/8 条嵌套 verified experience；
- primary claim 是 held-out Gold availability，不是 exact-cache latency；
- Selection 是下游独立指标，不与 retrieval 合成总分；
- final-heldout v1 与 Query Expansion development cases 均不得成为本实验 experience；
- shuffled、unverified、stale、deleted-evidence、cross-scope、near-miss contamination 为必测负对照；
- component、real-model Selection、host longitudinal E2E 分开验收。

## Memory producer factor

| Producer | 输入 | 允许用途 | 禁止 |
| --- | --- | --- | --- |
| M0 `none` | 无 | A/B retrieval baseline | 生成 profile |
| M1 `naive` | 成功 query 的直接词法特征 | evaluation-only 弱基线 | 写 Store、晋升、冒充 verified memory |
| M2 `verified` | attribution、verifier、父 revision、evidence-bound semantic features | 核心 treatment | 未验证成功直接产 cue |

M1 的作用是检验“保存任务词”本身能带来多少收益。只有 M2 相对 M1 仍有改善且安全对照通过，
才能把增益归因于 verified experience distillation。

## Frozen experimental conditions

| Condition | Retriever | Producer | Role |
| --- | --- | --- | --- |
| A | BM25 | M0 | baseline |
| B | BM25 + QE | M0 | strong retrieval baseline |
| C1 | BM25 | M1 | naive-memory control |
| C2 | BM25 | M2 | verified-memory treatment |
| D1 | BM25 + QE | M1 | naive-memory + strong retriever |
| D2 | BM25 + QE | M2 | complete treatment |

Learning curve 固定为 `0/1/2/4/8` 条嵌套 experience。A/B 只运行 0；C1/C2/D1/D2
运行全部 exposure 点。不得把 6 条 condition 压成一个加权总分。

## Formation evidence contract

| Evidence class | Formation disposition |
| --- | --- |
| verified positive | positive cue；必须有独立 verifier |
| near miss | soft-negative cue；不得硬过滤 |
| boundary | proposal-only；经 discovery replay 后才可转 cue |
| external failure | ignore，不归因给 Skill |
| unverified success | reject |

真实路径继续使用现有 `PracticeEvent → induceActivationProfile → shadow → promotion`。当前普通
`skill_md` observer 只落 `prompt-hash/candidate-count/selected-count`，不足以形成语义 cue；真实
host semantic feature producer 是后续显式工作，不得用 evaluation fixture 替代其证据。

Evaluation 路径必须保留 `sourceMode=evaluation_fixture`。M1 永不可持久化；M2 fixture 只能证明
formation/retrieval 结构，不能写入 Practice Store、不能晋升为生产 active profile。只有默认
project-local real Store 的 verified evidence 才可能在既有 gate 后进入生产派生层。

## Query-leakage policy

在任何 profile formation 或 retrieval 输出出现前冻结：

- NFKC + lowercase + 非字母数字折叠后的 exact match：禁止；
- pairwise token Jaccard：`≤ 0.50`；
- evaluation-query token containment：`≤ 0.80`；
- tokenizer 与 BM25 discovery 相同，中文使用同一 CJK bigram 逻辑；
- 报告只保存 case IDs 与数值，不保存原始 query/cue。

比较对象包括 experience query → calibration/held-out query，以及 3B 形成后的 cue →
calibration/held-out query。任一超阈值 case 必须在运行 retrieval 前停止，不得看到结果后调阈值。

Step 3A pre-run query audit：3,072 pair，max Jaccard `0.3333`，max evaluation containment
`0.5000`，0 violation。该结果不包含 formation 后的 cue，不能替代 3B cue-level audit。

Step 3B cue-level structural audit（只形成 cue，不运行 retrieval）：M1/M2 各 3,072 pair，max
Jaccard `0.3333`，max evaluation containment `0.5000`，0 violation。M1 artifact hash
`sha256:48298a8c817e8bd44e0ba0f9a217d1547239d5c9a41c912e23bbd6a65dfb4489`；M2 artifact hash
`sha256:a2989b8bbc4a87e8415be2a7d2e4817f37f6f0b29c123f84dae340e1060f6dba`。哈希已绑定
evaluation tenant scope；旧的 3B 哈希因此失效。

## Step 3B runner boundary

- `formEvaluationActivationMemory`：输入 experience 前缀，输出 deterministic draft profile；
- M1 使用直接词法 alias；M2 使用 evidence-bound positive features；两者共享同一个
  `memoryBoost`，不按 cue 数量重复加分；
- memory channel 可以把静态 Top-K 外、revision 匹配且 cue 命中的父 Skill 补入候选池；
- 补入只存在于 evaluation runner。当前 production `applyActiveProfiles` 仍是静态候选集内 rerank，
  不得声称 host 已具备 learned-cue recall expansion；
- runner 只接受 `partition=calibration`；held-out 在独立 post-freeze entry point 实现前直接拒绝；
- 所有 producer 的 cue-level leakage 必须在 index search 前通过，否则 fail closed；
- report 只保存 case ID、candidate Skill IDs、artifact hash 和数值，不保存 query/cue 原文。

## Step 3C metrics and safety controls

- formation：输入 experience、profile/cue/evidence 数量、evidence completeness、父 revision binding、
  persistence eligibility 与 cue leakage；
- discovery：Gold availability Recall@K、multi-skill full-set availability、per-Gold recall、MRR、
  learned cue coverage 与 static Gold preservation；
- 分栏：overall、中文、英文、single、multi、No-Skill、hard-confuser，不计算加权总分；
- No-Skill candidate false positive 在本实验中严格定义为：No-Skill case 出现 learned-cue candidate，
  用于隔离 memory 的新增风险；静态 BM25 返回候选本身不自动计为 memory false positive；
- 负对照 runner 覆盖 shuffled artifact tamper、unverified draft、stale revision、deleted evidence、
  cross-scope 和 near-miss soft penalty；结果只保存 control/candidate IDs 与受控 outcome；
- 当前只以 synthetic catalog 验证 6/6 控制执行路径，尚未运行 development fixture 的正式安全门。

## Evidence boundary

Calibration v1 已在冻结 catalog/fixture/config 上运行。D2 exposure 8 的 overall Recall@5 为
`0.85`，但 No-Skill FP 为 `1.00`、hard-confuser FP 为 `0.8333`，且 M1/M2 全部候选输出相同。
因此 calibration verdict 为不通过：不得运行 held-out，不得声称 verified memory 相对 naive memory
有独立增益。没有真实模型或 host 调用；不得报告 production learning gain、promotion 或 E2E 完成。

权威详细设计见 `docs/design/skill-memory-baseline.md`。
