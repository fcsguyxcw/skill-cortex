# G6 Active Overlay Evidence and Production Scope Lock

日期：2026-08-27  
当前范围：Activation Memory component + project-local evaluation host seam；生产入口保持 disabled

## 当前证据

- `src/activation/final-heldout.ts` 的 12 条 untouched final-heldout 在首次揭示后保持冻结；本轮只重跑，
  未修改 cases、Gold、profile、overlay 参数或门槛。
- 四栏各 3 例全部通过：hard-confuser recall、confuser rejection 与 Gold preservation 均为 1；
  No-Skill precision 为 1；multi-skill/cross-language 达冻结门槛。
- 隔离的真实 Pi `ExtensionRunner` 验证 active profile revision 精确匹配时追加 learned cue 并重排，
  无 overlay provider 时无损回静态；受控 promotion 只能使用冻结评估 provider。
- production entry scope-lock 明确断言 `.pi/extensions/skill-cortex/index.ts` 不配置
  `overlayProfiles` 或 `overlayOptions`。

## 状态口径

G6 在 component + project-local evaluation host seam 层 PASS。该结论复用 2026-08-16 首次揭示的
untouched held-out；本轮是冻结重跑，不是新的独立 held-out。

依据 ADR-0014 和当前 G1 blocker，生产入口继续不读取 active profile、不改变 discovery。这里没有授权
production active overlay、真实自用部署或 G7 完成，也没有启用 procedure/runtime。

## 验证

- G6 held-out + host seam + production scope-lock：12 passed，0 failed。
- `npm test`：855 tests；853 passed，0 failed，2 skipped。
- `npm run typecheck`：通过。
