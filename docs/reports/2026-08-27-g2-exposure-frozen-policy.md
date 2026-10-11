# G2 Exposure Frozen Policy Evaluation

日期：2026-08-27  
证据等级：offline component / evaluation fixture  
生产行为：D2 shadow-only，未接入 active suppress

## 冻结输入

- Catalog：`docs/evaluation/2026-08-20-selection-catalog-snapshot.json`
- Cases：既有 Activation Memory calibration 24 例 + heldout 24 例
- Retriever：当前静态 BM25，Top-K=5
- Config hash：`sha256:ad9c31165dd8cbf76521c4d67d9d70b229d2e6f469a1a74c77c62af6fb4d6f96`

heldout 内容在仓库中已可见，因此本轮只称 frozen replay，不称 untouched confirmation。

## 单一 deterministic policy

仅当 baseline 有候选，且满足以下任一结构化条件时，evaluation comparator 建议 show：

- `exactDeclaredReference=true`；
- `candidateCount>=5`；
- `topScore>=12`。

策略只读取现有 `ExposureObservation`，没有任务类型词典、关键词/正则分类器、Router LLM 或
`expected_gain`。实现位于 `src/evaluation/exposure/`，生产入口与 `src/exposure/` 不返回决策。

## 结果

| Partition | Cases | 基线中含任一 Gold | Baseline necessary exposure recall | Policy recall | Baseline No-Skill FP | Policy No-Skill FP |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| calibration | 24 | 6 | 6/6 (1.00) | 6/6 (1.00) | 2/4 (0.50) | 1/4 (0.25) |
| frozen replay | 24 | 6 | 6/6 (1.00) | 6/6 (1.00) | 2/4 (0.50) | 1/4 (0.25) |

这里的 necessary exposure recall 只以“当前 BM25 Top-5 已包含至少一个 Gold”的 case 为分母；它不把
retrieval miss 伪装成 Exposure Gate 能解决的问题。

## 状态边界

单一 policy 在冻结 replay 上满足 G2 的 offline component 数值条件：必要候选 exposure 非劣，同时降低
No-Skill exposure FP。它不是 production/host/E2E 证据。依据 ADR-0014，在新增 active suppress ADR、冻结
发布阈值和用户明确授权前，D2 继续只记录 observation，候选注入行为不变。

## 验证

- `node --test src/evaluation/exposure/frozen-policy.test.ts`：4 passed，0 failed。
- 相关 Exposure/生产入口测试：11 passed，0 failed。
- `npm test`：849 tests；847 passed，0 failed，2 skipped。
- `npm run typecheck`：通过。
