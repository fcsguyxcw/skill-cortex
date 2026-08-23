# D1 Contribution Verifier Component Seam

日期：2026-08-23  
范围：G1 前置 component；不包含生产 host integration 或 end-to-end learning

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

## 完成口径

本切片只关闭 contribution verifier component seam。生产入口尚无可信 verifier registration，且当前
observer 尚未提供可独立验证 Agent 最终任务结果的宿主证据，所以 G1、D1 host integration 与 D1
end-to-end 继续保持未完成。

## 验证

- `node --test src/activation/contribution-verifier.test.ts`：5 passed，0 failed。
- `npm test`：841 tests；839 passed，0 failed，2 skipped。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
