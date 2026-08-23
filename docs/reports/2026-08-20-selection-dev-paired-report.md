# Selection Dev v1 Paired Evaluation

日期：2026-08-20  
证据来源：`real_model`  
模型：`deepseek/deepseek-v4-flash`（thinking=`high`，temperature=`0`）  
范围：Selection component evaluation；**不是 Pi host integration 或端到端执行证据**

## 冻结身份

- catalog：132 个模型可见 Skill；
- catalog hash：`sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7`；
- dev Gold hash：`sha256:45af7f527178dd47903845984b64916a827e1cb6be747cec90cd87d614708966`；
- case：14 条；`single=10`、`multi=2`、`no-skill=2`；
- paired arms：完整 catalog descriptions 与 BM25 Top-5 candidate cards；每个 case 每臂一次。

## 结果

| 指标 | Full catalog | Top-K | 解释 |
|---|---:|---:|---|
| Exact-set accuracy | 13/14（92.9%） | 11/14（78.6%） | Top-K 总分包含 retrieval miss |
| Gold available | 14/14 | 12/14（85.7%） | D01、D04 未检索到 Gold |
| Gold available 子集 exact-set | 11/12（91.7%） | 11/12（91.7%） | 相同 12 条 paired 子集，差值 0 |
| Strict parse failure | 0 | 0 | 28 次均满足严格 JSON |
| Invalid / duplicate ID case | 0 / 0 | 0 / 0 | 无 catalog 外、不可见或重复 ID |
| Actual input tokens | 305,339 | 8,165 | 减少 97.33% |
| Prompt chars | 902,183 | 26,746 | 减少 97.04% |
| Latency mean | 5,113.3 ms | 3,467.8 ms | 降低 32.18% |
| Latency p50 | 3,916.6 ms | 2,006.2 ms | 降低 48.78% |
| Latency p95 | 12,142.3 ms | 21,549.6 ms | 回归 77.48%，受 D12 reasoning 长尾影响 |

Provider usage 字段完整，但 cost 全部返回 `0`；因此成本金额记为 **unavailable**，不得表述为免费。

## 分栏

| 分栏 | Full catalog | Top-K | Top-K Gold available |
|---|---:|---:|---:|
| single | 10/10 | 8/10 | 8/10 |
| multi | 1/2 | 1/2 | 2/2 |
| no-skill | 2/2 | 2/2 | 2/2 |
| 中文 | 6/6 | 4/6 | — |
| 英文 | 7/8 | 7/8 | — |

## 失败分类

### D01 — retrieval miss

- Gold：`diagnosing-bugs`；
- Full catalog 正确选择 Gold；
- Top-K 只返回 `lab-report`，Gold 不可见，模型合法 abstain；
- 归因：中文 query 与英文 Skill description 的当前词法检索不足，不计作模型 Selection 错误。

### D04 — retrieval miss

- Gold：`architecture-designer`；
- Full catalog 正确选择 Gold；
- Top-K 候选为空，模型合法 abstain；
- 归因：中文架构请求没有被当前 BM25/tokenization 召回，不计作模型 Selection 错误。

### D12 — Gold/Selection 边界问题

- 冻结 Gold：`pdf + data-analysis`；两个 Gold 均进入 Top-K；
- Full catalog 只选择 `pdf`；
- Top-K 选择 `pdf + consulting-analysis`；
- `consulting-analysis` 的声明覆盖 financial analysis 与专业研究报告，因此模型选择并非无理由；
- 归因：不是 retrieval miss，而是 dev 案例仍存在 catalog-dependent 标注歧义或模型错选。为保持冻结完整性，本次结果不回写 Gold；D12 只进入 dev v2 的重审队列。

## 结论边界与下一步

本轮证明：真实主模型调用下，Top-K 在 Gold 可见的 paired 子集上与 full catalog 同为 11/12，
同时把 actual input tokens 减少 97.33%。但 14 条 dev、每臂一次不足以证明统计非劣，也不能关闭
真实 Pi host blocker。当前主要问题已经从 Selection parser 转移到中文/cross-language retrieval recall，
其次是 multi-skill Gold 唯一性与 Top-K latency 长尾。

下一步应先修复或评估中文 retrieval（D01、D04），再建立不参与调参的 held-out；D12 保留原结果，
另建 dev v2 替代案，不得修改本报告或 frozen hash。
