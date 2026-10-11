# G4 Controls Production Entry Verification

日期：2026-08-27  
范围：project-local 真实 Pi production entry；不代表真实自用部署或 G7 完成

## 验证路径

测试通过真实 Pi `loadExtensions` 三次加载 `.pi/extensions/skill-cortex/index.ts`，所有状态与证据均位于
隔离 fixture 的 `.skill-cortex/`：

1. 第一个 entry 实例通过真实 `skill_memory_set_learning` 暂停学习；
2. 第二个 entry 实例重载持久化 pause，并验证真实 discovery/settled lifecycle 不新增 Exposure 或
   Practice evidence；
3. 在真实 production Store 中写入绑定的 PracticeEvent、LearningAssessment 与依赖 profile；
4. 真实 `skill_memory_list` 只返回脱敏摘要；
5. 真实 `skill_memory_forget(evidence_id)` 删除 PracticeEvent/assessment，并级联 suspend profile；
6. 恢复学习后，第三个 entry 实例重载持久化 resume。

## 状态口径

G4 的 list/pause/resume/forget、跨 entry reload 持久化、pause 零新增 evidence 与 evidence deletion cascade
已具备 component + project-local production-entry host integration 证据，可在该层标记 PASS。

测试没有部署到用户日常 Pi，没有启用 active overlay，也没有接入 procedure/runtime。真实自用部署和
完整 G7 仍未验证。

## 验证

- `node --test src/evaluation/d4/controls-production-entry.test.ts`：1 passed，0 failed。
- 相关 controls/production-entry 测试：9 passed，0 failed。
- `npm test`：855 tests；853 passed，0 failed，2 skipped。
- `npm run typecheck`：通过。
