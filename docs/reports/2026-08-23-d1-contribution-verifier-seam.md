# D1 Contribution Verifier Component Seam

日期：2026-08-23  
范围：G1 前置 component + project-local Pi host seam；不包含生产 verifier 或 end-to-end learning

## 目标

阻止 `PracticeEvent.verifierResults=pass` 或“Skill 存在于 catalog”直接生成 positive learning
assessment，同时提供一个可接可信任务特定 verifier 的最小持久化入口。

## 实现

- 新增 `verifyAndStorePositiveContribution`：只读取 Practice Store 中已持久化的 real `skill_md` event。
- parent 必须精确匹配当次 catalog 的 `skillId + skillRevision + sourceHash`。
- verifier 必须显式注册到同一 immutable binding；同一 binding 无 registration 或存在多个 registration
  均 fail closed。
- registration 指定的 operation step 与 Practice verifier 必须都 pass；随后 verifier implementation 仍须
  独立返回 `verified_contribution`。
- 只有上述条件同时满足才生成 `verified_success + verified contribution + positive` assessment，并通过
  `LearningAssessmentStore.append` 再次复核真实 event binding。

## 回归边界

- exact binding + unique registration + independent verification 可写 assessment；
- 任意 catalog Skill 没有 registration 时零 assessment；
- revision/source drift、缺少所需 step/result、复核 unverified、重复 registration 均零 assessment；
- 没有修改 D2 Exposure 行为，也没有修改或接入 procedure/runtime active path。

## 2026-08-27：Pi host evidence seam

- 新增 `registerContributionAssessmentObserver`，消费真实 Pi `before_agent_start`、`agent_end` 与
  `agent_settled` 生命周期。
- 原始 prompt 与最终 assistant 文本仅保存在 session-keyed 内存状态；只接受
  `stopReason=stop` 且非空、有界的最终文本，不写入任何 Store。
- PracticeObserver 成功 append 后通过带 sessionId 的 `onEvent` 把 event 交给 assessment observer；observer
  再从 Practice Store 重读事件，避免 caller 临时事件绕过持久化绑定。
- 隔离的真实 `AgentSession` 使用真实 `load_skill` 工具链跑两轮：正确 marker 形成一条 positive
  assessment；错误 marker 返回 `contribution_unverified`，没有第二条 assessment。
- 生产入口不注册任何 verifier；普通 Practice verifier pass、catalog 存在或 assistant 自报成功仍不能
  自动产生 contribution assessment。

## 完成口径

当前关闭 contribution verifier component 与 project-local Pi host evidence seam。生产入口尚无可信
verifier registration，也没有可普遍验证任意任务因果贡献的实现，所以 G1、D1 production integration
与 D1 end-to-end 继续保持未完成。

## 验证

- `node --test src/activation/contribution-verifier.test.ts`：6 passed，0 failed。
- `node --test src/activation/contribution-verifier.test.ts src/adapters/pi/practice-observer.test.ts src/evaluation/phase2/observer-integration.test.ts src/evaluation/phase2/practice-evidence-b4.test.ts src/evaluation/d1/contribution-host-integration.test.ts`：44 passed，0 failed。
- `npm test`：843 tests；841 passed，0 failed，2 skipped。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
