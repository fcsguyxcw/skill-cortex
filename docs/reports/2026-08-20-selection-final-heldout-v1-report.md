# Selection Final-Heldout v1 Paired Evaluation

日期：2026-08-20  
状态：**首次揭示已完成；冻结 gate 未通过**

## 结论

正式结果没有支持“Top-K discovery 已达到发布门槛”。唯一失败 gate 是 Top-K retrieval Gold
availability：`21/30 = 70%`，低于预先冻结的 `80%`。

在 Top-K 已包含完整 Gold 的 21 个同案样本中，Full Catalog 与 Top-K 均为 `21/21 = 100%`，
paired exact-set regression 为 `0`。因此本轮主要瓶颈是 discovery recall，不是候选可用时的
主模型 Selection。

## 冻结身份

- catalog hash：`sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7`
- Gold Set hash：`sha256:15a19f154ee904cb624cb3e680c67de173695a11391f2a853795f692a5df4843`
- threshold config hash：`sha256:df11ad053b95508b265ec48966525b0bfb20933b74f84cd7565644ece0d0fb0d`
- EvaluationRunConfig hash：`sha256:30dbdaa057ba98c2fdbb622108e0d16a1fce1c8ba5ba8af53360768550e3ab7b`
- JSON report SHA-256：`8d55936aaf711990d2888fd7851cf1e2957ace6977fb9eaab2298fb5ccdee2ac`
- evidence mode：`final_heldout_first_reveal`
- 调用数：30 cases × 2 arms = 60；60 次均以 `stop` 结束

## 冻结 gate

| Gate | 实际值 | 门槛 | 结果 |
|---|---:|---:|---|
| retrieval Gold availability | 70.00% | ≥80% | **FAIL** |
| Gold-available 同案例 exact-set 回归 | 0.00% | ≤5% | PASS |
| No-Skill accuracy 回归 | 0.00% | ≤0% | PASS |
| Full / Top-K strict parse failure rate | 0% / 0% | 0% | PASS |
| Full / Top-K invalid Skill ID case rate | 0% / 0% | 0% | PASS |
| actual input-token reduction | 97.85% | ≥80% | PASS |

## 分栏

| 分栏 | N | Full exact-set | Top-K exact-set | Retrieval Gold available |
|---|---:|---:|---:|---:|
| single | 15 | 14/15 (93.33%) | 10/15 (66.67%) | 10/15 (66.67%) |
| multi | 5 | 3/5 (60.00%) | 1/5 (20.00%) | 1/5 (20.00%) |
| no-skill | 10 | 10/10 (100%) | 10/10 (100%) | 10/10 (100%) |
| hard-confuser | 21 | 18/21 (85.71%) | 13/21 (61.90%) | 13/21 (61.90%) |
| 中文 | 15 | 13/15 (86.67%) | 8/15 (53.33%) | 8/15 (53.33%) |
| 英文 | 15 | 14/15 (93.33%) | 13/15 (86.67%) | 13/15 (86.67%) |
| overall | 30 | 27/30 (90.00%) | 21/30 (70.00%) | 21/30 (70.00%) |

## 失败归因

Top-K 的 9 个 exact-set failure 全部同时是 retrieval Gold miss：
`S04、T03、T04、T05、T08、M03、M04、M06、M07`。

Full Catalog 的 3 个失败为 `T05、M03、M04`，且三者也都落在上述 retrieval-miss 集合内。
不得据此修改 frozen Gold；这些案例在首次揭示后已转为 revealed regression set。

## 成本与延迟

- actual input tokens：Full `650,453`；Top-K `13,988`；减少 `97.85%`
- total tokens：Full `667,541`；Top-K `25,633`
- Full latency：mean `4,415.58 ms`，p50 `3,346.83 ms`，p95 `7,065.71 ms`
- Top-K latency：mean `2,775.14 ms`，p50 `1,582.14 ms`，p95 `12,835.79 ms`
- provider usage 完整；cost 字段为 `0`，但 provider 未返回可独立核验的计费金额，因此不作“零成本”主张

## 证据边界与下一步

这是离线 real-model Selection component evidence，不是 Pi AgentSession host E2E，也不证明
`search_skills` 补搜路径、PracticeEvent 归因或 procedure 执行质量。

下一步应在新 dev/calibration 数据上改进 discovery，优先处理 multi-skill、中文同义表达及
专业 Skill 名称不直接出现的查询；不得使用本报告的 30 条 revealed cases 调阈值或改 Gold。
改进冻结后可把本集作为 regression set 重放，但新的正式质量主张必须使用另行冻结的 untouched
held-out。
