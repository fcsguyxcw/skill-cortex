# Selection Memory-as-Context Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不改变 BM25+QE 候选集合的前提下，验证结构化 Skill Memory 是否改善主模型 Selection。

**Architecture:** 新增隔离的 `src/evaluation/selection-memory/` 分支。Memory Card 从受控 evidence/profile
确定性投影并与候选卡相邻渲染；S0/S1/S2 只改变 Memory 上下文，候选 ID、顺序、description 和
retrieval score 保持相同。实验通过前不修改 production contracts、discovery 或 Pi adapter。

**Tech Stack:** TypeScript 5.9、Node 24 `node:test`、现有 BM25+QE、Selection strict parser、
`ModelRuntime.completeSimple`。

---

## Phase 0：Documentation discovery and decision freeze

### Task 1：审查并确认 ADR 与协议

**Files:**

- Create: `docs/adr/0013-selection-time-skill-memory-context.md`
- Create: `docs/evaluation/2026-08-20-selection-memory-context-protocol.md`
- Create: `docs/plans/2026-08-20-selection-memory-context-implementation-plan.md`

**Allowed APIs:**

- `src/discovery/query-expansion.ts`：`buildQueryExpansionIndex`；
- `src/discovery/candidate-card.ts`：`formatCandidateCards`；
- `src/evaluation/selection/paired.ts`：`parseSelectionResponse`、`exactSkillSetEqual`；
- `src/evaluation/selection/real-model.ts`：completion/usage evidence pattern；
- `@earendil-works/pi-coding-agent`：已验证的 `ModelRuntime.completeSimple`。

**Steps:**

1. 阅读 ADR-0006/0007/0008、最新 implementation audit 与 Activation Memory calibration report。
2. 确认 ADR-0013 为 `Proposed`，只授权 evaluation branch。
3. 确认协议明确候选集合不变量、三臂、数据隔离、门槛和停止条件。
4. 运行：

   ```powershell
   rg -n "Memory.*(新增|重排|提高.*score)|Router LLM" docs/adr/0013-selection-time-skill-memory-context.md docs/evaluation/2026-08-20-selection-memory-context-protocol.md
   git diff --check
   ```

5. 人工确认后再进入 Phase 1。未经用户授权不创建 commit。

**Anti-pattern guards:** 不把 Proposed 写成生产可用；不声称真实 experience induction 已完成。

## Phase 1：Memory Card component

### Task 2：先写合同测试

**Files:**

- Create: `src/evaluation/selection-memory/memory-card.test.ts`
- Create: `src/evaluation/selection-memory/memory-card.ts`
- Create: `src/evaluation/selection-memory/index.ts`

**Steps:**

1. 写失败测试，固定接口：

   ```ts
   projectSelectionMemoryCard({ candidate, profile, tenantScopeHash, sourceMode })
   renderSelectionMemoryCard(card, limits)
   computeSelectionMemoryCardHash(card)
   ```

2. 覆盖：valid binding、revision/scope/status mismatch、empty card、evidence deletion、排序/hash、
   `3/3/3` cap、600/3000 char cap、secret/path/verbatim-full-user-task/instruction-like rejection；人工归纳后的简短适用性描述有效。
3. 运行并确认测试先因模块不存在而 FAIL：

   ```powershell
   npm.cmd test -- src/evaluation/selection-memory/memory-card.test.ts
   ```

4. 实现最小纯函数；evaluation fixture 允许显式 draft，formal-real-store 只允许 active。
5. 重跑定向测试与 typecheck，预期 PASS。

**Anti-pattern guards:** 不修改 `ActivationProfile` schema；不把 evidence IDs 渲染给模型；不持久化卡。

## Phase 2：Evidence 与 Gold fixture

### Task 3：建立 evidence、calibration、held-out 分区

**Files:**

- Create: `src/evaluation/selection-memory/evidence-cases.ts`
- Create: `src/evaluation/selection-memory/calibration-cases.ts`
- Create: `src/evaluation/selection-memory/heldout-cases.ts`
- Create: `src/evaluation/selection-memory/cases.test.ts`
- Create then freeze as: `docs/evaluation/2026-08-20-selection-memory-context-gold-v1.md`

**Steps:**

1. 为 8 个目标 Skill 编写 verified positive 与 near-miss/boundary evidence；不直接编写成品卡。
2. 编写 30 calibration + 30 held-out，满足 `12/6/12`、`15/15` 与 hard-confuser 配额。
3. 为 Layer A 人工冻结包含 Gold 与 confusers 的 candidate bundle；Layer B 在这些 bundle 的冻结并集
   catalog 内正常检索且不保存补 Gold 逻辑，不冒充完整 132-Skill runtime E2E。
4. 测试 catalog identity、case/query/Gold 唯一、partition import boundary 与配额。
5. 复用 `measureQueryLeakage` 执行 exact/Jaccard/containment audit；任一 violation 阻止后续 runner。
6. 人工复核 Gold 后，将 draft hash 改为 frozen hash；确认前不得调用模型或运行 held-out。

**Verification:**

```powershell
npm.cmd test -- src/evaluation/selection-memory/cases.test.ts
npm.cmd run typecheck
```

**Anti-pattern guards:** 不根据 retriever/model 输出改 Gold；不复用任何现有 held-out query。

## Phase 3：Three-arm component runner

### Task 4：实现 prompt 与候选不变量

**Files:**

- Create: `src/evaluation/selection-memory/prompt.ts`
- Create: `src/evaluation/selection-memory/prompt.test.ts`

**Steps:**

1. 先测试 S0/S1/S2 的候选 card serialization 完全相同。
2. 测试 S1 只含 `Use when`，S2 才含 `Avoid when`/requirements。
3. 测试 Memory 被 delimiter 包围并标注为 evidence/not instructions。
4. 实现 `buildSelectionMemoryPrompt`；复用现有 candidate description 格式与严格 JSON contract。

### Task 5：实现 runner 与指标

**Files:**

- Create: `src/evaluation/selection-memory/runner.ts`
- Create: `src/evaluation/selection-memory/runner.test.ts`

**Steps:**

1. 写 faux invoker 测试，固定每 case 三臂、同候选、严格 parse、invalid/unlisted/duplicate 分类。
2. 增加 Layer A/Layer B、Gold-available 条件、single/multi/no-skill/hard/zh/en 指标。
3. 增加三次重复 agreement/Jaccard、memory chars、omission/truncation reason、latency/token seam。
4. 报告只保存 IDs、hash 与数值；断言不包含 query、card text、raw response。
5. 定向运行：

   ```powershell
   npm.cmd test -- src/evaluation/selection-memory/prompt.test.ts src/evaluation/selection-memory/runner.test.ts
   npm.cmd run typecheck
   ```

**Anti-pattern guards:** 不修改 `src/evaluation/selection/paired.ts` 的现有报告；不混用 SelectionArm 类型。

## Phase 4：Real-model calibration

### Task 6：真实模型 adapter 与冻结配置

**Files:**

- Create: `src/evaluation/selection-memory/real-model.ts`
- Create: `src/evaluation/selection-memory/calibration-config.ts`
- Create: `src/evaluation/selection-memory/calibration-config.test.ts`
- Create: `src/evaluation/selection-memory/run-calibration.ts`

**Steps:**

1. 复制 `src/evaluation/selection/real-model.ts` 的 completion/usage/hash/failure evidence 模式，
   不创建新的宿主 API。
2. 冻结 catalog、Gold、evidence、card renderer、prompt、model、inference、Top-K、repeat count 与 arm order hash。
3. 配置测试必须在首次 billable call 前通过。
4. runner 使用 `flag: "wx"` 写 project-local JSON；不得写用户 `.pi/.codex/.agents`。
5. 首次只运行 calibration。provider/credential 缺失时停止并报告，不 fallback cached/faux result。

**Verification:**

```powershell
npm.cmd test -- --test-name-pattern="selection memory" src/evaluation/selection-memory/*.test.ts
npm.cmd run typecheck
node src/evaluation/selection-memory/run-calibration.ts
```

**Stop gate:** S2 未同时通过协议 §9 时，不创建 held-out runner。

## Phase 5：Conditional held-out

### Task 7：只在 calibration PASS 后运行 untouched held-out

**Files:**

- Create: `src/evaluation/selection-memory/heldout-config.ts`
- Create: `src/evaluation/selection-memory/run-heldout.ts`
- Create: `src/evaluation/selection-memory/heldout-report.test.ts`
- Create: `docs/reports/2026-08-20-selection-memory-context-heldout.json`
- Create: `docs/reports/2026-08-20-selection-memory-context-heldout.md`

**Steps:**

1. 先冻结 threshold/config hash；assert calibration verdict=PASS。
2. 一次性运行 held-out；禁止修改 cards、prompt、Gold 或 model 后重跑覆盖。
3. 写 report hash integrity test，并分别报告 component/real-model/evidence boundary。

**Anti-pattern guards:** 不用 calibration 输出改 held-out；不把 offline model comparator 称为 host E2E。

## Phase 6：Conditional production proposal

### Task 8：仅在 held-out 支持假设后提出生产接线

**Potential files（当前不得修改）:**

- `docs/adr/0013-selection-time-skill-memory-context.md`：Proposed → Accepted；
- `src/activation/selection-context.ts`；
- `src/discovery/candidate-card.ts`；
- `src/adapters/pi/*`；
- 对应 host integration/E2E tests。

必须新增 active + formal-real-store gate、真实 scope/revision/evidence deletion tests、prompt token budget
和真实主 Agent Selection E2E。若 held-out 不支持假设，保留负结果并停止，不重构生产模块。

## Final verification

```powershell
npm.cmd test
npm.cmd run typecheck
git diff --check
rg -n "Router LLM|maturity.*rank|raw prompt|raw response" src/evaluation/selection-memory docs/adr/0013-selection-time-skill-memory-context.md
```

交付分别报告 component、real-model、host integration、end-to-end；没有实际证据的层级标记“未验证”。
