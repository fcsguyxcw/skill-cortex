# Selection Memory-as-Context Held-out Report

日期：2026-08-21  
状态：**一次性 first-reveal held-out 已完成；Selection hypothesis supported；production/host E2E 未验证**

## 1. Provenance

- source mode：`real_model`
- provider/model：`deepseek/deepseek-v4-flash`
- held-out config hash：`sha256:8b41fe8823196b024ec8f28285d44854df5255fdd187e64d9eca8bebb70291b0`
- calibration report hash：`sha256:a77aef8bf705e885229f8934ab535b54eb5e5f1b1766bb30d7c6ce6925b3861b`
- held-out case hash：`sha256:b93564482ce4c5bdfc3f30e6b56489ace33628fb0ae9dabc491d4836d80d19ac`
- held-out Gold-set hash：`sha256:17a9c5d7a527ca0a5f146a9e13bb0e950bcc49455404d8a862034ad088813422`
- report hash：`sha256:3ad48fbed61c38b266cc4186418288a4493f37776cd56bcf64cf68e69b4406d2`
- calls：`540/540`，全部调用键唯一
- raw prompt、raw response、query：均未保存

原始结构化证据：`docs/reports/2026-08-20-selection-memory-context-heldout.json`。

## 2. Cost and usage

| Calls | Input | Cache read | Output | Reasoning | Total tokens | Provider cost |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 540 | 80,282 | 327,424 | 148,566 | 132,651 | 556,272 | $0.0537547472 |

## 3. Layer A — Selection-isolated

Gold availability：`30/30`。

| Arm | Exact-set | Repeat agreement | No-Skill FP | Mean latency | Mean Memory chars |
| --- | ---: | ---: | ---: | ---: | ---: |
| S0 description only | 84/90 = 93.33% | 90.00% | 4/36 | 3217.65 ms | 0 |
| S1 positive memory | 87/90 = 96.67% | 100.00% | 3/36 | 3447.69 ms | 1018.90 |
| S2 structured memory | 89/90 = 98.89% | 96.67% | 0/36 | 3045.74 ms | 1531.90 |

- positive information gain，S1 − S0：`+3.33 pp`；
- boundary information gain，S2 − S1：`+2.22 pp`；
- S2 − S0：`+5.56 pp`；
- S2 相对 S0 的平均 prompt input 增量：`391.03 tokens/call`，低于冻结上限 1000；
- strict parse、unknown ID、unlisted ID、duplicate ID：均为 0。

### Frozen slices

| Slice | S0 | S1 | S2 |
| --- | ---: | ---: | ---: |
| single | 100.00% | 100.00% | 100.00% |
| multi | 88.89% | 100.00% | 94.44% |
| no-skill | 88.89% | 91.67% | 100.00% |
| hard-confuser | 96.83% | 100.00% | 98.41% |
| zh | 97.78% | 100.00% | 97.78% |
| en | 88.89% | 93.33% | 100.00% |

S2 唯一一次错误发生在 `SMH17` 的第 2 次重复：Gold 为
`chart-visualization + code-documentation`，模型只选了 `chart-visualization`。因此 S2 总体和
No-Skill 边界最佳，但 multi/hard-confuser/zh 分栏略低于 S1；相对 S0 仍提高或持平。

## 4. Layer B — Retrieval-controlled

Gold availability Recall@5：`13/30 = 43.33%`，17 个 retrieval miss：

`SMH03, SMH04, SMH06, SMH07, SMH09, SMH11, SMH12, SMH14, SMH16, SMH17, SMH19, SMH21, SMH22, SMH24, SMH26, SMH27, SMH29`

| Arm | All-case exact-set | Exact-set when Gold available | No-Skill FP |
| --- | ---: | ---: | ---: |
| S0 | 41.11% | 94.87% | 2 |
| S1 | 43.33% | 100.00% | 0 |
| S2 | 43.33% | 100.00% | 0 |

Memory 不改变候选集合，因此 S1/S2 的端到端上限被 Recall@5 锁定为 43.33%。Gold 可用时 S1/S2
均为 100%，说明 held-out 的主要系统瓶颈是 discovery，而不是 Memory-assisted Selection。

## 5. Calibration-to-held-out conclusion

| Layer A metric | Calibration | Held-out |
| --- | ---: | ---: |
| S0 exact-set | 93.33% | 93.33% |
| S1 exact-set | 95.56% | 96.67% |
| S2 exact-set | 100.00% | 98.89% |
| S2 No-Skill FP | 0 | 0 |

结论：**Selection Memory-as-Context 假设获得 held-out 支持。** 结构化 positive + negative Memory
在候选已存在时稳定优于 description-only，并保持 No-Skill fail-closed；但不能据此声称解决 retrieval。

## 6. Evidence boundary

- 支持：受控 evidence 生成的结构化 Memory Card 改善离线真实模型 Selection；
- 不支持：当前 Agent 已能从真实使用自动形成同质量 Memory；
- 不支持：Memory 修复 BM25+QE miss；
- offline comparator 不是 Pi host integration、production profile promotion 或端到端部署；
- 下一研究步骤应分别验证真实 PracticeEvent → Memory formation，以及独立改进 retriever，不能把两者
  与本 held-out 结果混成一个归因不清的实验。
