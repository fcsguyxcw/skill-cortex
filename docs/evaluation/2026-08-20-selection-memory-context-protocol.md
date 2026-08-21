# Selection Memory-as-Context Experiment Protocol v1

日期：2026-08-20  
状态：**协议与 Gold v1 已冻结；Memory Card、数据 fixture、prompt、three-arm runner、真实模型 adapter/config 与 dry-run 已通过 component tests；真实模型未调用**

## 1. Research questions

1. Gold 已在候选中时，verified positive history 是否提高主模型 exact-set Selection？
2. 加入 near-miss/boundary 后，是否相对 positive-only history 改善 No-Skill 与 hard-confuser？
3. Memory token/latency 增量是否保持有界？
4. Selection 改善在冻结实验 catalog 内的 BM25+QE Top-5 下能否转化为 retrieval+selection 增益？

不研究：Memory 修复 retrieval miss、额外 Router LLM、生产 profile promotion 或 host E2E。

## 2. Frozen architecture invariants

```text
Query
  -> BM25 + static Query Expansion
  -> fixed Top-K candidates
  -> join candidate-bound Memory Cards
  -> one main-model Selection call
  -> Skill / Skill Set / No-Skill
```

同一 case 的 S0/S1/S2 candidate IDs、顺序、author descriptions 与 retrieval scores 必须完全相同。
Memory 不得新增、删除、替换或重排候选。

## 3. Memory Card contract

```ts
interface SelectionMemoryCard {
  schemaVersion: 1;
  parentSkillId: string;
  parentSkillRevision: string;
  tenantScopeHash: string;
  sourceMode: "evaluation_fixture" | "formal_real_store";
  useWhen: Array<{ features: string[]; evidenceIds: string[] }>;
  avoidWhen: Array<{
    kind: "near_miss" | "boundary";
    features: string[];
    evidenceIds: string[];
  }>;
  environmentRequirements: Array<{
    key: string;
    valueClass: string;
    evidenceIds: string[];
  }>;
  cardHash: string;
}
```

Memory Card 是 evaluation-only 投影，不新增 production Store。模型 prompt 不包含 evidence IDs、scope
hash、card hash 或原始历史文本。每卡最多 `3/3/3` 条目、600 code units；Top-K Memory 总计不超过
3000 code units。所有截断与省略原因进入 report。

## 4. Experimental arms

| Arm | Prompt delta | Allowed evidence |
| --- | --- | --- |
| S0 `description_only` | 无 | 无 |
| S1 `positive_memory` | `Use when` | verified positive only |
| S2 `structured_memory` | `Use when` + `Avoid when` + requirements | verified positive + verified near-miss/boundary/environment |

三臂使用同一 model/provider、system prompt、temperature、reasoning、max tokens、candidate serialization、
candidate order 与 invocation count。

## 5. Evaluation layers

### Layer A — Selection-isolated

每个 case 冻结一个包含 Gold Skill 与 hard confusers 的 bounded candidate bundle。Gold label、Gold
metadata 和任何答案标记绝不进入模型 prompt；模型只能看到与各 arm 约定相同的候选字段。该层只回答
“Gold 已由实验设计保证存在于候选集合时，Memory 是否改善 Selection”，不声称 runtime retrieval 质量。

### Layer B — Retrieval-realistic within the controlled catalog

同一 query 在冻结的 19-Skill 实验 catalog 内正常执行 BM25+QE Top-5，不补 Gold。该 catalog 是所有
Layer A candidate bundle 的并集，membership hash 为
`sha256:17307bc426e4ea973412cc706c25bf31b2fd4156a186a8fac077e6b0b6e06b8e`，并绑定父 132-Skill
catalog hash。分别报告 retrieval Gold availability、全部 case exact-set 与 Gold-available 子集 exact-set。
retrieval miss 不计为模型 Selection 错误，但计入 retrieval+selection 结果。

该层只证明受控 catalog 内的检索现实性。它不能宣称完整 132-Skill runtime end-to-end；完整 catalog
存在职责重叠的替代 Skill，需要 alternative-Gold/等价类协议后才能公平评测。

Layer A 与 Layer B 必须分别报告、分别解释；不得相加、平均或合并成一个 accuracy。Layer A 是
selection-isolated evidence，Layer B 是受控 catalog 内的 retrieval+selection evidence。

## 6. Data partitions

新增独立数据，不复用：

- Selection final-heldout；
- Activation Memory held-out；
- Query Expansion evaluation cases；
- 任何模型输出或当前 retriever 选择作为 Gold。

计划规模：

| Partition | Cases | single / multi / no-skill | zh / en | hard-confuser |
| --- | ---: | ---: | ---: | ---: |
| Calibration | 30 | 12 / 6 / 12 | 15 / 15 | ≥18 |
| Held-out | 30 | 12 / 6 / 12 | 15 / 15 | ≥18 |

Memory evidence 与 evaluation query 分区。运行前执行 NFKC exact、token Jaccard `≤0.50`、evaluation
containment `≤0.80` audit。Gold 与 candidate bundles 必须同时绑定父 catalog snapshot/hash 和 19-Skill
实验 catalog membership hash，并人工确认。

## 7. Model protocol

第一版复用当前 Selection comparator 的真实 provider seam：

- provider/model：在 calibration config 中冻结；初始候选为 `deepseek/deepseek-v4-flash`；
- temperature：`0`；
- reasoning：`high`；
- Top-K：`5`；
- 输出：严格 `{ "selected_skill_ids": [...] }`；
- 每 case/arm 计划 3 次重复，用于稳定性指标；
- raw prompt/response 不落报告，仅保存 hash、parsed IDs、usage、latency、stop/failure category。

任何 credential、model alias 或 provider availability 不在代码中伪造；运行前按现有 runner 只读解析。

### Frozen calibration run config

- config hash：`sha256:25cbdea78cf416bb2c3591e6531b37c81917826a8334cd369a5c685930b41972`；
- controlled catalog content hash：`sha256:a06e22fed2885dee73f7ea7fe6a3802287604192b2dfe6c9ec7006df377828cd`；
- calibration Gold-set hash：`sha256:6f45bc5f03d5729bbfab4d282e26903d848e96096148124a1a79cc3ab82ef44c`；
- 30 cases × 2 layers × 3 arms × 3 repeats，共 `540` 次 planned model invocations；
- 默认及 `--dry-run` 路径不调用 provider、不生成报告；只有显式 `--execute` 才允许真实调用；
- provider error 或 aborted response 后立即停止，不继续产生后续付费调用；报告使用 project-local 独占创建，禁止覆盖已有结果。

上述 adapter/config/dry-run 只证明执行边界和报告结构，不能替代真实模型 calibration evidence。

## 8. Metrics

分别报告，不计算加权总分：

- exact-set accuracy；
- exact-set accuracy when Gold available；
- single/multi/no-skill/hard-confuser/zh/en；
- No-Skill accuracy 与 hard-confuser rejection；
- invalid、unlisted、duplicate ID 与 strict parse failure；
- 三次重复的 exact-set agreement 与 pairwise set Jaccard；
- card coverage、omission/truncation reason、memory chars；
- actual input/output/cache/reasoning tokens；
- latency mean/p50/p95；
- S1/S2 相对 S0 的 token 与 latency delta。
- positive information gain：`S1 exact-set - S0 exact-set`，并报告逐 case `incorrect→correct` / `correct→incorrect` 转移；
- boundary information gain：`S2 exact-set - S1 exact-set`，同样报告逐 case 转移；
- 上述两项按 no-skill、hard-confuser、single、multi、zh、en 分栏，不能只报总体差值。

## 9. Calibration gate

只有 S2 同时满足以下条件，才允许冻结 held-out config：

1. exact-set 高于 S0；
2. exact-set 高于 S1；
3. No-Skill、hard-confuser 和 multi-skill 不比 S0 多错；
4. invalid/unlisted/duplicate/parse failure 为 0；
5. scope/revision/deletion/status/tamper 负对照全部 fail closed；
6. 平均新增 actual input tokens 不超过 1000/case；
7. 所有结果绑定 catalog、Gold、evidence、card、prompt、model 与 run config hash。

Calibration 可用于冻结 renderer cap 与正式阈值；任何规则变化必须生成新 config hash。未过门则停止，
不得读取或运行 held-out。

## 10. Evidence boundary

- fixture cards 只能证明 prompt/Selection 机制，不能证明真实 PracticeEvent 已自动形成同等语义 Memory；
- real-model offline comparator 不是 Pi host integration；
- component、real-model、host integration、end-to-end 分开验收；
- 生产接线必须另行把 ADR-0013 从 Proposed 更新为 Accepted，并补 active/formal-real-store gate。

## 11. Protocol order

1. 实现并验证 Memory Card 纯函数；
2. 人工编写、复核并冻结 evidence/calibration/held-out；
3. 实现 faux-provider/component runner；
4. 冻结 calibration run config；
5. 运行 real-model calibration；
6. 过门后冻结并一次性运行 held-out；
7. 只有 held-out 支持假设时才设计 production/host 接线。
