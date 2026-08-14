# Phase 3 Gate 报告：OFFSET pagination partial procedure

日期：2026-08-14
结论：**Gate P3 未通过；procedure 保持 `draft`，不得进入 canary/active。**
停止边界：Phase 3 实现与离线评测已完成；按用户要求不启动 Phase 4。

## 1. 实际交付

- `src/procedures/phase3/`：bounded SQL lexer/detector、完整
  `CompiledProcedure` draft builder、dependency/source fail-closed 检查，以及仅允许
  `draft → validated` 的不可变转换函数。
- `src/evaluation/phase3/`：19 个冻结原创案例、独立 verifier、分项指标、真实成本证据合同、
  Practice evidence 充分性门和跨模块 held-out replay。
- `docs/adr/0010-phase3-pagination-pilot.md`：因 proprietary `docx` 许可禁止复制/派生，
  Phase 3 改用 MIT pagination 静态检测 pilot。
- 来源清单与阈值在候选实现产生前已分别由 Pi 和 CC 冻结；两者没有共同修改文件。

procedure 绑定：

| 字段 | 值 |
|---|---|
| parent skill | `skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2` |
| parent revision | `rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec` |
| procedure id | `procedure:phase3-pagination:3fa65ed335945a40` |
| procedure revision | `rev:4b13123ccd7b06076418268afa038f3fbda036c3985e5e7d49c99d8dc03fabb2` |
| artifact hash | `sha256:5624a8b61efec7ccacfa62525f6480d03e9fc1d855a5dab93809bb7f84f19dad` |
| status | `draft` |
| bound Practice evidence | 0 |

父身份由只读 installed package 通过当前 Registry 算法重新计算，manifest 共 32 项。绑定检查
返回 `ok: true`。本地 `SKILL.md` 与 selected rule 的 SHA-256 分别为
`8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830` 和
`73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa`。

## 2. Held-out 结果

冻结 held-out 共 15 例，detector 结果：

| 指标 | 结果 | 门槛 | 判定 |
|---|---:|---:|---|
| accuracy | 1.00 (15/15) | >= 0.95 | PASS |
| OFFSET recall | 1.00 (5/5) | = 1.00 | PASS |
| OFFSET false-positive rate | 0.00 (0/10) | <= 0.05 | PASS |
| expected-abstain recall | 1.00 (3/3) | = 1.00 | PASS |
| abstain rate | 0.20 (3/15) | <= 0.20 | PASS，边界值 |
| unexpected-abstain rate | 0.00 (0/12) | <= 0.10 | PASS |

fresh Pi slow path 使用 `pi.cmd -ne`，只读完整 installed `SKILL.md` 与
`references/data-pagination.md`，不读取 detector 或 oracle。该批次耗时 14,613.530 ms，
归一化结果为 13/15；两条残缺的 `OFFSET;` 被慢路径判成 `uses_offset`，冻结 oracle 要求
`abstain`。原始模型对话和推理未写入仓库，仅保留本报告中的聚合结果。

## 3. 成本结果

真实成本单位为 wall-clock `latency_ms`。分子采用首次完整 Phase 3 验收流水线的保守墙钟
（targeted tests + project typecheck）；它不是 authoring 人力成本，也不与独立的字节 comparator
共用口径。该口径在看到是否过门之前即按实际首次运行保留，没有用后续热缓存结果替换：

| 分量 | 结果 |
|---|---:|
| Phase 3 targeted tests | 274.221 ms |
| project typecheck | 7,620.740 ms |
| compile + validation | 7,894.961 ms |
| slow path mean | 974.235333 ms/例（1 个 fresh Pi 批次，15 例） |
| fast path mean | 0.002703 ms/例（10,000 x 15 次，1,000 次预热） |
| expected fallback mean | 194.847067 ms/例（3/15 abstain） |
| `N_break-even` | **10.129724** |
| 冻结门槛 | <= 10 |

计算：

```text
7894.961 / (974.235333 - 0.002703 - 194.847067) = 10.129724
```

因此成本门轻微失败。slow path 只有单批样本，无法估计方差，`N_break-even` 是保守点估计而非
稳定性能声明。字节 comparator 只作参考，不用于覆盖真实延迟结果。后续复测必须预先冻结
采样次数和聚合方法，不能用更快的热运行选择性替换本结果。

## 4. Gate P3 判定

PASS：OFFSET recall、结构化安全、source/dependency binding、train/held-out 独立性、
verifier 独立性、correctness、fallback、真实成本证据结构、scope conformance。

FAIL：

1. `practice_evidence`：0 个 Store-verified `provenance=real` PracticeEvent；ADR-0008
   要求多次真实、可归因使用。resolver 会重新读取 Store、执行 policy 校验，并核对父
   Skill/revision/source、covered operation 和对应 verifier PASS；evaluation/synthetic/shadow、
   重复 ID、其它 rule 的事件或普通对象都不能冒充本 procedure 的真实证据。
2. `cost`：`N_break-even=10.129724 > 10`。

最终 `judgePromotion` 返回 `draft`。没有调用 validated transition，没有生成 canary/active
状态，也没有把当前 Agent 的选择写成 gold label。

## 5. 验证命令与结果

- Phase 3 targeted：49/49 PASS（CC 独立复验）。
- 全仓 `npm.cmd test`：212 PASS / 0 FAIL / 1 SKIP；skip 为 Windows 无权限创建文件 symlink 的既有 Registry 用例，不伪通过。
- `npm.cmd run typecheck`：PASS。
- production effect scan：procedure 无 filesystem/network/process/database import 或调用。
- verifier independence scan：`verifier.ts`、`metrics.ts` 不导入 detector。
- `git diff --check`：PASS。

## 6. 未解决风险与下一边界

- 必须先获得至少 2 个真实、可归因、policy-valid 的 pagination PracticeEvent，并保持与
  held-out 分离；事件必须匹配本 procedure 的 covered operation 与 verifier，不得用同一父
  Skill 的其它 rule 事件，也不得手工把现有 synthetic SQL 改标为 `real`。
- 成本需在同一冻结口径下复测并达到 `N_break-even <= 10`；不能挑选更快的重复运行覆盖
  本次首个完整验收样本。
- installed Skill 的本地版本为 1.1.0，而 upstream main 已变化；当前 procedure 只绑定本地
  installed revision，不跟随 upstream main 自动更新。
- 当前 Registry revision 覆盖整个 package manifest，因此无关 reference 变化也会造成父
  revision mismatch 并保守 suspend。更细 dependency diff 属后续阶段，Phase 3 不绕过父
  revision 契约。
- Pi 在早期评测实现时误写过 Git Bash `/tmp` 测试日志；按项目外路径只读规则未删除，且后续
  已停止外部写入。仓库内没有这些文件。

## 7. 来源

- https://github.com/supabase/agent-skills
- https://github.com/supabase/agent-skills/blob/main/LICENSE
- `docs/adr/0008-practice-evidence-and-procedure-promotion.md`
- `docs/adr/0010-phase3-pagination-pilot.md`
- `docs/evaluation/2026-08-14-phase3-pagination-thresholds.md`
- `docs/research/2026-08-14-phase3-pagination-pilot-inventory.md`
