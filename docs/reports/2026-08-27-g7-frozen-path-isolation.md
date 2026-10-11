# G7 Frozen Path Isolation Gate

日期：2026-08-27  
范围：真实 project-local Pi 生产入口的 procedure/runtime 隔离；G7 的最终真实自用证据见
[2026-09-08 G7 报告](2026-09-08-g7-real-self-use.md)

## 验证边界

- 从 `.pi/extensions/skill-cortex/index.ts` 递归解析 project-local 静态 import graph；禁止触达
  `src/procedures/`、`src/runtime/` 与 `src/adapters/pi/execution-adapter.ts`。
- 通过真实 Pi `loadExtensions` 加载生产入口，冻结注册工具清单为 bounded discovery 两项与 learning
  controls 四项；任何 procedure execution tool 加入都会使测试失败。
- 冻结真实 handler 事件与数量，并确认生产入口没有配置 `compiledTool`。有界 gate-status contribution observer 会增加 `agent_end`、`agent_settled` 与 `before_agent_start` handler，但不引入 procedure/runtime 路径。
- 确认生产入口没有配置 `overlayProfiles` 或 `overlayOptions`，避免在 G1/生产发布门未关闭时读取
  active profile 改变 discovery。
- 有界 gate-status 域的 production contribution verifier 已注册；它只接受明确验证证据，不扩展为通用贡献判定。

## 状态口径

本隔离子门已由自动化回归测试覆盖。D2 仍为 shadow-only，procedure/runtime 没有 active path。
K=3 优化已被拒绝，生产保留 K=5/full。本隔离子门与后续真实自用验证共同关闭 G7；本报告自身仍只证明
frozen-path isolation，不单独证明外部模型链路。

## 验证

- `node --test src/evaluation/d4/production-entry-isolation.test.ts`：2 passed，0 failed。
- `node --test src/activation/gate-status-contribution-verifier.test.ts src/evaluation/candidate-budget/selection-report.test.ts src/evaluation/d4/production-entry-isolation.test.ts src/evaluation/phase1/pi-host-integration.test.ts`：17 passed，0 failed。
- `npm test`：861 tests；859 passed，0 failed，2 skipped。
- `npm run typecheck`：通过。
