# Activation Memory calibration ablation

日期：2026-08-20  
证据等级：**offline component / evaluation fixture**

- Catalog hash：`sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7`
- Fixture hash：`sha256:5f2bd1da0372601cba3cc45ee5285c2243f4024ffc4950abbd098f46a8570a30`
- Config hash：`sha256:770e80357df5a2f5e11334844a9c2748ef5fca899fa28300b38bf3ca674748c1`
- Top-K / boost / near-miss penalty：`5 / 5 / 1`
- Held-out：未运行
- Model / host：未调用

## Learning curve

| Exp. | Arm | Overall R@K | ZH R@K | EN R@K | Multi full | Per-Gold | MRR | No-Skill FP | Hard R@K | Hard FP | Static preserve |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | A | 0.2000 | 0.0000 | 0.4000 | 0.0000 | 0.2500 | 0.2417 | 0.0000 | 0.2000 | 0.0000 | 1.0000 |
| 0 | B | 0.3000 | 0.2000 | 0.4000 | 0.2500 | 0.3500 | 0.3417 | 0.0000 | 0.3000 | 0.0000 | 1.0000 |
| 0 | C1 | 0.2000 | 0.0000 | 0.4000 | 0.0000 | 0.2500 | 0.2417 | 0.0000 | 0.2000 | 0.0000 | 1.0000 |
| 0 | C2 | 0.2000 | 0.0000 | 0.4000 | 0.0000 | 0.2500 | 0.2417 | 0.0000 | 0.2000 | 0.0000 | 1.0000 |
| 0 | D1 | 0.3000 | 0.2000 | 0.4000 | 0.2500 | 0.3500 | 0.3417 | 0.0000 | 0.3000 | 0.0000 | 1.0000 |
| 0 | D2 | 0.3000 | 0.2000 | 0.4000 | 0.2500 | 0.3500 | 0.3417 | 0.0000 | 0.3000 | 0.0000 | 1.0000 |
| 1 | C1 | 0.5500 | 0.5000 | 0.6000 | 0.0000 | 0.6250 | 0.4958 | 0.2500 | 0.5500 | 0.2917 | 1.0000 |
| 1 | C2 | 0.5500 | 0.5000 | 0.6000 | 0.0000 | 0.6250 | 0.4958 | 0.2500 | 0.5500 | 0.2917 | 1.0000 |
| 1 | D1 | 0.6000 | 0.6000 | 0.6000 | 0.2500 | 0.6500 | 0.5208 | 0.2500 | 0.6000 | 0.2917 | 1.0000 |
| 1 | D2 | 0.6000 | 0.6000 | 0.6000 | 0.2500 | 0.6500 | 0.5208 | 0.2500 | 0.6000 | 0.2917 | 1.0000 |
| 2 | C1 | 0.5500 | 0.5000 | 0.6000 | 0.0000 | 0.6250 | 0.4625 | 1.0000 | 0.5500 | 0.5833 | 1.0000 |
| 2 | C2 | 0.5500 | 0.5000 | 0.6000 | 0.0000 | 0.6250 | 0.4625 | 1.0000 | 0.5500 | 0.5833 | 1.0000 |
| 2 | D1 | 0.6000 | 0.6000 | 0.6000 | 0.2500 | 0.6500 | 0.5125 | 1.0000 | 0.6000 | 0.5417 | 1.0000 |
| 2 | D2 | 0.6000 | 0.6000 | 0.6000 | 0.2500 | 0.6500 | 0.5125 | 1.0000 | 0.6000 | 0.5417 | 1.0000 |
| 4 | C1 | 0.5500 | 0.5000 | 0.6000 | 0.0000 | 0.6250 | 0.4308 | 1.0000 | 0.5500 | 0.7500 | 1.0000 |
| 4 | C2 | 0.5500 | 0.5000 | 0.6000 | 0.0000 | 0.6250 | 0.4308 | 1.0000 | 0.5500 | 0.7500 | 1.0000 |
| 4 | D1 | 0.6000 | 0.6000 | 0.6000 | 0.2500 | 0.6500 | 0.4808 | 1.0000 | 0.6000 | 0.7500 | 1.0000 |
| 4 | D2 | 0.6000 | 0.6000 | 0.6000 | 0.2500 | 0.6500 | 0.4808 | 1.0000 | 0.6000 | 0.7500 | 1.0000 |
| 8 | C1 | 0.8500 | 0.9000 | 0.8000 | 0.7500 | 0.8750 | 0.5258 | 1.0000 | 0.8500 | 0.8333 | 1.0000 |
| 8 | C2 | 0.8500 | 0.9000 | 0.8000 | 0.7500 | 0.8750 | 0.5258 | 1.0000 | 0.8500 | 0.8333 | 1.0000 |
| 8 | D1 | 0.8500 | 0.9000 | 0.8000 | 0.7500 | 0.8750 | 0.5758 | 1.0000 | 0.8500 | 0.8333 | 1.0000 |
| 8 | D2 | 0.8500 | 0.9000 | 0.8000 | 0.7500 | 0.8750 | 0.5758 | 1.0000 | 0.8500 | 0.8333 | 1.0000 |

## Negative controls

结果：6/6 passed。

| ID | Control | Expected | Observed | Pass |
| --- | --- | --- | --- | --- |
| AMN01 | shuffled_profile | no_cross_task_transfer | no_cross_task_transfer | yes |
| AMN02 | unverified_success | no_active_overlay | no_active_overlay | yes |
| AMN03 | stale_revision | fallback_baseline | fallback_baseline | yes |
| AMN04 | deleted_evidence | fallback_baseline | fallback_baseline | yes |
| AMN05 | cross_scope | fallback_baseline | fallback_baseline | yes |
| AMN06 | near_miss_contamination | no_cross_task_transfer | no_cross_task_transfer | yes |

## Findings

- BM25 baseline A 的 overall Gold availability Recall@5 为 `0.20`；QE baseline B 为 `0.30`。
- D2 在 exposure `1` 达到 `0.60`，exposure `8` 达到 `0.85`；此时中文/英文分别为
  `0.90/0.80`，multi-skill full-set availability 为 `0.75`。
- 所有 memory arm 的 static Gold preservation 均为 `1.00`，说明没有挤掉原本已在 Top-5 的 Gold。
- 安全性不通过：D2 的 No-Skill learned-candidate FP 从 exposure `1` 的 `0.25` 升到
  exposure `2/4/8` 的 `1.00`；hard-confuser FP 从 `0.2917` 升到 `0.8333`。
- M1 与 M2 在全部 exposure、两种 retriever 下的候选结果完全相同。当前 M2 仍是与 M1
  等价的 token bag + any-overlap matcher，无法证明 verified experience distillation 有独立增益。
- D2 exposure `8` 仍有 3 个 full-set miss：`AMC09`、`AMC10` 和 `AMC18`。前两条均漏掉
  `code-documentation`；`AMC18` 在单次全局 Top-5 中保留 `video-frames`，但漏掉
  `image-generation`，暴露 multi-skill 候选竞争问题。
- 6/6 负对照只证明 artifact/scope/revision/evidence 等结构性 fail-closed；不能抵消 No-Skill 与
  hard-confuser 的语义误召回。

## Calibration verdict

**不进入 held-out，不允许 promotion。** 当前结果只支持“positive-only lexical memory 可以提高
Recall”，不支持“verified Activation Memory 优于 naive memory”，且安全指标明显退化。

下一轮应保持 held-out untouched，并在 calibration 上单独消融：

1. 让 M2 使用不同于 M1 的 evidence-derived intent cue，而不是相同 token bag；
2. 将单 token any-overlap 改为可解释的最小证据门槛，并加入 verified near-miss/No-Skill boundary；
3. 对 multi-skill 比较单次全局 Top-K 与按意图/Skill 预留候选位的 bounded merge；
4. 任何 producer、matcher 或候选合并规则变化都生成新的 config hash，再运行 calibration。

## Evidence boundary

该报告只证明冻结 fixture 上的离线 formation/retrieval component 行为。它不证明真实 PracticeEvent formation、生产 active overlay、主模型 Selection 或 Pi host E2E。
