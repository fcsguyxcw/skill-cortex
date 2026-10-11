# BM25 Query Expansion Baseline Ablation

日期：2026-08-20  
状态：**development-only evaluation；不是新的 formal held-out**

## 目标与边界

对照当前原始 BM25 与 `BM25 + static Query Expansion`。扩展器只用 14 条静态、动作导向的
中文规则追加英文检索词；不调用模型、不改作者 description、不改 BM25 评分，也不接入当前
production adapter。

评测使用 24 条新建 development cases：calibration/dev 各 12，中文/英文各 12，
single/multi/no-skill 为 12/4/8；query 与 final-heldout 不重复。Gold 是人工编写的
evaluation fixture，只用于开发和 ablation。

运行命令：

```powershell
node src/evaluation/selection/run-query-expansion.ts
```

输入身份：

- catalog hash：`sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7`
- query expansion source SHA-256：`9148a8e1bff6c805da03cddcba64bc4a9a5ae740c9e4d8024108367e3740553e`
- cases source SHA-256：`cc15faf019e17b628fae21ee37cc5d95e4aadcb680e5d10e09a596303e6d5295`
- evaluator source SHA-256：`b365e9af895e9735f86d93d58a7f164e1d73a78cba1e4650a6336313a6121638`
- Top-K：5

## 结果

Gold availability Recall@5 的分母不包含 No-Skill；No-Skill 单独报告“检索返回任意候选”的
candidate false-positive rate。

| 分栏 | BM25 | BM25 + QE | Delta |
|---|---:|---:|---:|
| Overall Gold Recall@5 | 8/16 (50%) | 16/16 (100%) | +50pp |
| 中文 Gold Recall@5 | 0/8 (0%) | 8/8 (100%) | +100pp |
| 英文 Gold Recall@5 | 8/8 (100%) | 8/8 (100%) | 0pp |
| Single Gold Recall@5 | 6/12 (50%) | 12/12 (100%) | +50pp |
| Multi Gold-set Recall@5 | 2/4 (50%) | 4/4 (100%) | +50pp |
| Calibration Gold Recall@5 | 4/8 (50%) | 8/8 (100%) | +50pp |
| Dev Gold Recall@5 | 4/8 (50%) | 8/8 (100%) | +50pp |
| No-Skill candidate FP | 6/8 (75%) | 6/8 (75%) | 0pp |

QE 改善了 8 条中文任务：`QEC01、QEC03、QEC05、QEC09、QED01、QED03、QED05、QED07`。
英文 case 没有 expansion rule 命中，结果与原 BM25 相同。8 条 No-Skill 中没有一条因为 QE
从 true negative 变成 false positive；高达 75% 的 candidate FP 是原 BM25 已有现象，不能被
本实验解释为 QE 回归，也不能声称 No-Skill discovery 已解决。

## 解释

这组结果证明最小静态映射可以修补“中文任务词 → 英文 Skill description”这一已知词法断层，
同时保持规则来源和每次命中可解释。它不证明 100% 可泛化：规则和 development cases 在同一轮
开发，覆盖域有限，且没有新的 untouched held-out。

当前扩展器仍有四个限制：

1. 未覆盖的中文表达仍会 miss；同义词维护成本随 Skill 域增长。
2. 规则只扩展 query，不解决多个互补意图共享一个全局 Top-K 的 coverage starvation。
3. candidate-level No-Skill false positive 仍高；最终 No-Skill 仍依赖 Selection。
4. 规则没有读取 PracticeEvent 或 ActivationProfile，因此不是学习型 Skill Memory。

## 下一步

1. 保持这一路径为可复现实验 arm，不直接替换 production BM25。
2. 新增独立、未参与规则编写的 calibration/held-out，覆盖未见同义词、混淆 Skill 和概念型 No-Skill。
3. 对 static rules 做逐规则 leave-one-out ablation，报告每条规则的增益与误召。
4. 再验证 clause-level retrieval / coverage-aware merge；不要仅把 K 从 5 调到 10。
5. 若静态词典覆盖趋于饱和，再比较本地 multilingual embedding hybrid；仍不引入 Router LLM。
