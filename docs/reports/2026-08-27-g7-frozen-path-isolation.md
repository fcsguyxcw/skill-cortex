# G7 Frozen Path Isolation Gate

日期：2026-08-27  
范围：真实 project-local Pi 生产入口的 procedure/runtime 隔离；不代表 G7 总体完成

## 验证边界

- 从 `.pi/extensions/skill-cortex/index.ts` 递归解析 project-local 静态 import graph；禁止触达
  `src/procedures/`、`src/runtime/` 与 `src/adapters/pi/execution-adapter.ts`。
- 通过真实 Pi `loadExtensions` 加载生产入口，冻结注册工具清单为 bounded discovery 两项与 learning
  controls 四项；任何 procedure execution tool 加入都会使测试失败。
- 冻结真实 handler 事件与数量，并确认生产入口没有配置 `compiledTool`。
- 确认生产入口没有配置 `overlayProfiles` 或 `overlayOptions`，避免在 G1/生产发布门未关闭时读取
  active profile 改变 discovery。
- production contribution verifier 尚未就绪，因此入口继续不得注册
  `registerContributionAssessmentObserver`。

## 状态口径

本隔离子门已由自动化回归测试覆盖。D2 仍为 shadow-only，procedure/runtime 没有 active path。
G7 总体仍未关闭：真实自用 Pi 部署、可信 production contribution verifier 以及完整生产 E2E 仍缺证据。

## 验证

- `node --test src/evaluation/d4/production-entry-isolation.test.ts`：2 passed，0 failed。
- `node --test src/evaluation/d4/production-entry-isolation.test.ts src/evaluation/phase2/observer-entry-integration.test.ts`：3 passed，0 failed。
- `npm test`：845 tests；843 passed，0 failed，2 skipped。
- `npm run typecheck`：通过。
