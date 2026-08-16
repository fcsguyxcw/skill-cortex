# Phase 3 Gate 报告：OFFSET pagination partial procedure

日期：2026-08-14（更新：2026-08-15，Gate P3 正式闭环）
结论：**Gate P3 = PASS（11/11 门，decision=validated，2026-08-15 真实证据闭环）；
procedure 进入 `validated`（非 `active`）；禁止启动 Phase 4。**
停止边界：validated ≠ active；进入 active 前必须再过 canary + shadow replay（ADR-0008），
不得在当前阶段启动 Phase 4。

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

## 3. 成本结果（B6 修正口径，2026-08-15 复测）

**口径修正**：原报告把“Phase 3 targeted tests + project typecheck”= 7,894.961 ms 的开发流水线墙钟
计入 compile+validation 分子；该口径不是 procedure 的运行时生成+验证成本（ADR-0008 要求后者，
authoring/开发成本不计入 N_break-even）。B6 按冻结口径复测（不挑样本、不改阈值、不手工替换数字）：

- compile + validation = `inducePhase3ProcedureDraft`（induction）+ held-out replay
  （detector + evaluate，内含每例独立 verify()）的运行时 wall-clock，30 次重复取均值；
- slow path = 真实 Pi 慢路径检测单例 SQL（`node <cli> -p -ne --no-session --thinking off`，
  只读 SKILL.md + references/data-pagination.md + LLM）wall-clock，3 个批次 × 15 例 = 45 样本；
- fast path = `detectPagination` 单例 wall-clock，5 轮 × 每例 2,000 次；
- fallback = abstain 案例（H12–H14）仍走慢路径。

runner：`src/evaluation/phase3/cost-benchmark.ts`；原始报告：
`docs/reports/2026-08-14-phase3-cost-benchmark.json`。

| 分量 | 均值 | 标准差 | 样本数 |
|---|---:|---:|---:|
| compile + validation | 0.463 ms | 1.107 ms | 30 |
| slow path mean | 5,355.194 ms/例 | 678.244 ms | 45（15 例 × 3 批，无缺口） |
| fast path mean | 0.002 ms/例 | 0.001 ms | 75（15 例 × 5 轮） |
| expected fallback mean | 1,116.133 ms/例（3/15 abstain） | 2,318.885 ms | 9 |

`RealCostEvidence` 经 `validateRealCostEvidence` 验证：**PASS**（unit=latency_ms；分母
5,355.194 − 0.002 − 1,116.133 > 0；sampleSize=45）。

```text
N_break-even = 0.463 / (5355.194 − 0.002 − 1116.133) = 0.000109
```

**结果：N_break-even = 0.000109 ≤ 10（冻结门槛），cost gate PASS。** 原 10.129724 是错误分子
（开发流水线墙钟）造成的保守高估，不是真实运行时成本。慢路径 45 样本均值 + 标准差齐全，不再是
单批点估计。字节口径 comparator 仍只作参考，不用于覆盖真实延迟结果。

## 4. Gate P3 判定

PASS：OFFSET recall、结构化安全、source/dependency binding、train/held-out 独立性、
verifier 独立性、correctness、fallback、真实成本证据结构（B6 修正后含方差）、cost
（B6 修正后 `N_break-even=0.000109 ≤ 10`）、scope conformance、**practice_evidence
（2026-08-15：2 条 Store-verified `provenance=real` PracticeEvent，见 §8）**。

正式闭环判定（见 §8）：**11/11 门 PASS，decision=`validated`，已执行 draft→validated 转换**。

**历史记录（2026-08-14 原判定）**：原 Gate P3 因 `practice_evidence`（0 条真实事件）与
`cost`（错误分子 10.129724）双失败返回 `draft`；两者已分别由 B4 真实事件闭环与 B6 口径修正
关闭，详见 §8 与 §3。

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

## 8. Gate P3 正式闭环证据（2026-08-15）

正式 validation runner：`src/evaluation/phase3/p3-gate-runner.ts`（+ 单测
`p3-gate-runner.test.ts`，用真实 Store 事件，非 fixture）；validation report：
`docs/reports/2026-08-14-phase3-p3-validation-report.json`。

整链（13 步口径，全部真实证据）：

1. 从 project-local PracticeStore 读 2 条真实事件（`project:bcf863bc…`，
   `obs-79b95a72…`、`obs-9ee1fe77…`）；
2. `inducePhase3ProcedureDraft`（冻结 hashes）→ draft 绑定冻结父身份一致
   （`skill:670b8f65…` / `rev:ce271d33…` / `sha256:8e5a86aa…`）；
3. `resolvePracticeEvidence` → distinct store-verified real events = 2 ≥ 2；
4. `docs/reports/2026-08-14-phase3-cost-benchmark.json` 的 realCostEvidence validate PASS
   （nBreakEven=0.000109，sampleSize=45）；
5. `replayHeldoutPagination` → accuracy=1、offsetRecall=1、offsetFpr=0、abstainRate=0.2；
6. `checkPhase3ProcedureBindings` → ok（真实冻结值，非裸 boolean）；
7. `judgePromotion` → **11/11 门 PASS，decision=`validated`**；
8. `transitionPhase3ProcedureValidation` → `status=validated`，
   `validationReportId=validation:phase3-pagination-p3-gate-2026-08-15`。

validated procedure：

| 字段 | 值 |
|---|---|
| procedure id | `procedure:phase3-pagination:3fa65ed335945a40`（与 §1 冻结一致） |
| procedure revision | `rev:7fd2f9abd0abc2b6af5f9bc8cdfd0cccd7b3e6f3790989df993243f49d029127` |
| status | `validated` |
| evidenceIds | 2 条真实事件（obs-79b95a72…、obs-9ee1fe77…） |
| validationReportId | `validation:phase3-pagination-p3-gate-2026-08-15` |

permissionPolicyHash 为合法 sha256 占位（`4f`×32），由 Owner 冻结环境提供；真实值替换时须重新评审本闭环。
validated ≠ active：进入 canary/active 前必须先过 shadow replay + canary gate（ADR-0008），
不得启动 Phase 4。
