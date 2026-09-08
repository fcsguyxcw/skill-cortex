# G3 真实模型 Selection Gate

日期：2026-09-08
证据等级：冻结 cases + DeepSeek 真实模型，evaluation-only

## 协议

- 冻结 commit：`fe5aefe`
- 冻结哈希：`sha256:40c750102dbd8e086b9b0107a09688b3ff6d25fb40747574712f677601740137`
- 12 cases：3 single、3 multi、3 no-skill、3 hard-confuser
- 5 arms：K=5/full、K=3/full、K=3/120、K=3/240、K=3/480
- 每臂每 case 重复 3 次，共 180 次真实模型调用
- 0 provider failure，0 strict parse failure
- 报告不保存原始 prompt 或 response；保留 case ID、selection、hash、usage 与 stop reason

## 结果

| Arm | Overall exact-set | Single | Multi | No-Skill | Hard-confuser |
| --- | ---: | ---: | ---: | ---: | ---: |
| K=5 / full | 91.67% | 100% | 77.78% | 88.89% | 100% |
| K=3 / full | 88.89% | 100% | 55.56% | 100% | 100% |
| K=3 / 120 | 91.67% | 100% | 66.67% | 100% | 100% |
| K=3 / 240 | 86.11% | 100% | 55.56% | 88.89% | 100% |
| K=3 / 480 | 91.67% | 100% | 66.67% | 100% | 100% |

## 判定

**K=3 优化拒绝；候选预算决策关闭并保留 K=5/full。** 所有 K=3 臂的 multi-skill exact-set 都低于
K=5/full 基线，No-Skill 和 hard-confuser 非劣不能抵消该回归。生产入口显式固定 K=5，继续使用完整
作者 description，状态记为 `closed_keep_k5_full`。该状态表示采用已验证基线，不表示 K=3 非劣性通过；
不选择 description limit。G7 仍须单独满足真实自用部署与完整生产 E2E。
