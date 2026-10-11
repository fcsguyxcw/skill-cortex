# G3 Candidate Budget Frozen Evaluation

日期：2026-08-27  
证据等级：offline component / evaluation fixture  
生产行为：Top-K 与候选卡保持不变

## 冻结输入

- Catalog：132-entry selection catalog snapshot
- Development：14 条 frozen selection dev cases
- Replay：30 条 frozen final-heldout cases
- Retriever：当前静态 BM25
- Budget arms：K=1/2/3/5
- Card arms：作者 description 的 120/240/480 字符确定性投影
- Config hash：`sha256:f829bae90b0410db27d53d46e00240a12950e28b8ad2834854d55aba954057dd`

final-heldout 内容在仓库中已可见，因此这里只称 frozen replay，不称本轮 untouched confirmation。

## Candidate Budget 结果

| Partition | Arm | Gold full-set | Multi full-set | Hard-confuser Gold full-set | Candidates | Description chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dev | K=3 | 10 | 2 | N/A | 28 | 10,062 |
| dev | K=5 | 10 | 2 | N/A | 40 | 14,887 |
| frozen replay | K=3 | 11 | 1 | 9 | 48 | 14,143 |
| frozen replay | K=5 | 11 | 1 | 9 | 71 | 22,770 |

相对 K=5，K=3：

- dev 候选量降低 30.0%，description 字符降低约 32.4%；
- frozen replay 候选量降低约 32.4%，description 字符降低约 37.9%；
- 两个 partition 的 overall 与 multi full-set availability 均未下降；
- frozen replay 的 hard-confuser Gold full-set availability 未下降。

因此 K=3 获得 evaluation-only offline support。K=1/2 在 dev 会丢失 K=5 已保留的 Gold/multi full-set，
不得因字符更少而选择。

## Card Projection 边界

在 K=3 frozen replay 上，120/240/480 三个投影都能降低字符数，但当前只有字符计数与候选 ID 不变的
结构证据，没有真实主模型 Selection、multi-skill 或 hard-confuser 可区分性证据。因此
`supportedDescriptionLimit=null`，不推荐任何截断长度，不修改生产候选卡。

## 状态口径

本报告只记录当时的 offline retrieval 结果。后续 2026-09-08 真实模型 Selection 评测否定 K=3 非劣性；
最终决策为拒绝 K=3 优化、显式保留生产 K=5 + 完整作者 description，状态记为
`closed_keep_k5_full`。K=1/2/3/5 和 120/240/480 comparator 继续仅作 evaluation observation。

## 验证

- `node --test src/evaluation/candidate-budget/frozen-evaluation.test.ts`：5 passed，0 failed。
- 相关 comparator/fixture 测试：14 passed，0 failed。
- `npm test`：854 tests；852 passed，0 failed，2 skipped。
- `npm run typecheck`：通过。
