# Selection Memory-as-Context Calibration Report

日期：2026-08-20  
状态：**真实模型 calibration 已完成；Selection-isolated gate PASS；held-out 未运行**

## 1. Provenance

- source mode：`real_model`
- provider/model：`deepseek/deepseek-v4-flash`
- config hash：`sha256:25cbdea78cf416bb2c3591e6531b37c81917826a8334cd369a5c685930b41972`
- Gold-set hash：`sha256:6f45bc5f03d5729bbfab4d282e26903d848e96096148124a1a79cc3ab82ef44c`
- controlled catalog content hash：`sha256:a06e22fed2885dee73f7ea7fe6a3802287604192b2dfe6c9ec7006df377828cd`
- calls：`540/540`
- raw prompt、raw response、query：均未保存

原始结构化证据：`docs/reports/2026-08-20-selection-memory-context-calibration.json`。

## 2. Cost and usage

| Calls | Input | Cache read | Output | Reasoning | Total tokens | Provider cost |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 540 | 87,970 | 334,592 | 119,625 | 103,417 | 542,187 | $0.0467476576 |

控制台显示的当天累计请求和 token 还包含其他运行，不能归因到本报告。本实验的 usage 以上述
540 个逐调用 provider evidence 汇总为准。

## 3. Layer A — Selection-isolated

Gold availability：`30/30`。

| Arm | Exact-set | Repeat agreement | No-Skill FP | Mean latency | Mean Memory chars |
| --- | ---: | ---: | ---: | ---: | ---: |
| S0 description only | 84/90 = 93.33% | 93.33% | 1/36 | 2736.97 ms | 0 |
| S1 positive memory | 86/90 = 95.56% | 96.67% | 4/36 | 2700.80 ms | 951.00 |
| S2 structured memory | 90/90 = 100.00% | 100.00% | 0/36 | 2726.03 ms | 1424.37 |

- positive information gain，S1 − S0：`+2.22 pp`；
- boundary information gain，S2 − S1：`+4.44 pp`；
- S0 错误涉及 `SMC01`、`SMC18`、`SMC20`；
- S1 错误只涉及 No-Skill boundary：`SMC19`、`SMC22`；
- S2 没有 exact-set 错误。

### Frozen slices

| Slice | S0 | S1 | S2 |
| --- | ---: | ---: | ---: |
| single | 94.44% | 100.00% | 100.00% |
| multi | 83.33% | 100.00% | 100.00% |
| no-skill | 97.22% | 88.89% | 100.00% |
| hard-confuser | 90.91% | 93.94% | 100.00% |
| zh | 93.33% | 91.11% | 100.00% |
| en | 93.33% | 100.00% | 100.00% |

S1 说明只提供 positive history 会扩大 No-Skill 误激活；S2 的 negative boundary 消除了该回归。

S2 相对 S0 的平均 prompt input 增量按 `input + cacheRead` 计算为 `363.53 tokens/call`，低于冻结的
`1000 tokens/case` 上限。平均 latency 没有回归（`-10.94 ms/call`）；该差值只作本次运行诊断，
不声称稳定的性能加速。

## 4. Layer B — Retrieval-controlled

Gold availability Recall@5：`15/30 = 50.00%`。15 个 miss 为：

`SMC02, SMC03, SMC05, SMC06, SMC07, SMC08, SMC09, SMC10, SMC11, SMC12, SMC14, SMC15, SMC16, SMC17, SMC18`

| Arm | All-case exact-set | Exact-set when Gold available | No-Skill FP |
| --- | ---: | ---: | ---: |
| S0 | 50.00% | 100.00% | 0 |
| S1 | 50.00% | 100.00% | 0 |
| S2 | 50.00% | 100.00% | 0 |

Memory 没有改变候选集合，因此不能修复 15 个 retrieval miss。Gold 一旦可用，三臂都已达到 100%，
Layer B 没有剩余 Selection headroom。该层证明当前端到端瓶颈是 discovery，不是否定 Layer A 的
Selection Memory 增益。

## 5. Calibration gate

Selection-isolated gate：**PASS**。

1. S2 exact-set 高于 S0：PASS；
2. S2 exact-set 高于 S1：PASS；
3. No-Skill、hard-confuser、multi-skill 不比 S0 多错：PASS；
4. invalid/unlisted/duplicate/parse failure 为 0：PASS；
5. scope/revision/deletion/status/config-tamper 负对照 fail closed：component tests PASS；
6. S2 平均新增 prompt input 不超过 1000：PASS（363.53）；
7. catalog、Gold、evidence、prompt、model 与 run config 均绑定 hash：PASS。

Layer B 不作为 Memory Selection gate：根据冻结架构，三臂禁止改变 retrieval candidates；其 50%
上限由 Gold availability 决定。Layer B 必须继续作为独立 retrieval+selection 诊断报告，不得与 Layer A
合并成一个分数。

## 6. Evidence boundary

- 本报告支持：在受控候选中，结构化 positive + negative Skill Memory 改善主模型 Selection；
- 本报告不支持：Memory 修复 discovery miss；
- offline real-model comparator 不是 Pi host integration 或 production E2E；
- held-out 尚未读取或运行；进入 held-out 前仍需冻结 held-out run config 和一次性揭示门。
