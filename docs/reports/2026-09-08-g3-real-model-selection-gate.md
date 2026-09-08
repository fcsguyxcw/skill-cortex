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

**G3 BLOCKED**。所有 K=3 臂的 multi-skill exact-set 都低于 K=5/full 基线。
No-Skill 和 hard-confuser 非劣不能抵消 multi-skill 回归，不选择 description limit，不改变生产
Top-K、排序或候选卡。生产保持 K=5 + 完整作者 description；依赖 G3 的 G7 active path
不得启动。
