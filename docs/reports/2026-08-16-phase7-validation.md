# Phase 7 系统验证与交接

日期：2026-08-16

状态：**Phase 0～6 全部 Complete；Phase 7 分层验证完成，系统可交接。** 三个系统 seam（search_skills overlay / host lifecycle cascade / 冻结 real-skill 评估 provider）已关闭。

本报告按 plan §12 的六层验证口径，逐层列出已验收证据（component / host integration / end-to-end）与已知边界。unit test / typecheck 只证明 component；host integration 与 end-to-end 分别标注。已知边界（真实宿主部署、真实主模型 Selection、crash consistency）如实列出，不冒充完成。

验证基线（2026-08-16）：`npm test` 687 tests / 685 pass / 0 fail / 2 skip（skip 为 Windows 文件 symlink 权限）；`npm run typecheck` PASS；`git diff --check` PASS。

## 1. Catalog / 安全

- **证据**：`src/core/registry/`（`buildSkillRecord`、`computeSkillRevision`/`computeSourceHash`/`computeContentHash`、`enumerateManifest`）与测试；`src/adapters/pi/core.ts` 的 `load_skill` 六重 fail-closed（unknown_skill / revision_mismatch / revision_drift / source_drift / size_exceeded / encoding_failed / path_failure）。
- **覆盖点**：scope 区分（user/project/temporary）、`disableModelInvocation` 过滤、稳定 revision（覆盖 scripts/references/assets 全 manifest）、SKILL.md 内容指纹、路径包含（realpath + 父 baseDir）、大小/编码上限。
- **验收**：component PASS（registry + adapter 单测）；host integration 经真实 Pi runner（B2，`9af7e67`）。真实宿主部署未启动（不冒充）。
- **边界**：权限继承只保存作者声明（`declaredPermissions/Effects`），不推断；真实宿主 canary/active 授权链未接线。

## 2. Discovery

- **证据**：`src/discovery/`（BM25 + tokenize + 词法相关门槛）；`src/activation/evaluate.ts`/`rerank.ts`（分栏评估）；`src/activation/calibration.ts`（门槛校准 12 例）+ `final-heldout.ts`（untouched 12 例，高词汇重叠 hard-confuser）。
- **覆盖点**：Recall@K / set recall、no-skill 不误召、hard-confuser 不误召、跨语言（learned 中文 alias）、gold 不挤出 Top-K（退化检测）；prompt 外 discovery（inject 精确移除原生全量 block，B1）。
- **验收**：Gate P1 PASS；Gate P6 held-out PASS（冻结门槛 recall/confuser=0.9、noSkill=1、goldPreserved=1）；active overlay（`applyActiveProfiles`，revision 匹配）component + discovery seam + E2E PASS。
- **边界**：真实主模型对候选卡的 exact-set 选择（Selection 层）不在本层；跨语言依赖作者声明 alias + learned alias（ADR-0007），非 tokenizer 魔法。

## 3. Selection

- **证据**：`src/adapters/pi/core.ts`（`buildInjectionBlock`、候选卡 single/multi/no-skill 选择说明）+ `index.test.ts`。
- **覆盖点**：有界 Top-K 候选卡注入、原生全量 block 移除、rewrite 失败 fail-open。
- **验收**：component PASS（inject block 结构 + 移除 marker 校验）。
- **边界（如实）**：plan §12 的「同一主模型在候选卡 vs 离线全量 baseline 下的 exact-set match、token、延迟」**未做**（需真实主模型在线评测，属真实宿主部署前任务）。Selection 的模型侧质量未验证。

## 4. Resolver

- **证据**：`src/runtime/resolver.ts`（`resolveExecution` + 状态矩阵 + guard/fallback）+ `resolver.test.ts`。
- **覆盖点**：ADR-0012 executionContext 矩阵（shadow_replay={validated,canary,active}；canary={canary}；active={active}；unknown/缺失 fail-closed）、父 Skill 身份、revision 双重 fail-closed、依赖指纹、effects 精确相等、授权声明、precondition、reason 区分。
- **验收**：component PASS（resolveExecution 全分支）；host integration（shadow）经真实 Pi 事件 PASS（b7b8d42）。
- **边界**：真实 canary/active 上下文未部署（`validated ≠ active`）。

## 5. Execution

- **证据**：`src/runtime/executor.ts` + `src/procedures/phase3/`（detector/verifier）+ `src/evaluation/phase3/cost-benchmark.ts`；execution-adapter（Phase 4 pilot shadow）。
- **覆盖点**：executor 全 outcome（fast_path/fallback/abstain/denied/safety_stop）、guard fail-closed、verifier binding、零副作用 safety_stop；真实成本复测 `N_break-even=0.000109`（B6 修正）。
- **验收**：component + project-local shadow replay PASS；Gate P4 project-local canary PASS。
- **边界**：真实 LLM/tool 次数、p50/p95、Cost per Successful Skill Invocation 的真实宿主统计**未做**（成本 benchmark 是离线复测口径）。

## 6. Lifecycle / Security

- **证据**：`src/procedures/lifecycle/`（状态机 + dependency diff + rollback + evidence cascade + identity）+ `src/procedures/store/`；`src/activation/store.ts`/`cascade.ts`/`host.ts`（ActivationProfile 状态机 + 删除级联 + 父 revision 回 shadow + 受控 promotion）。
- **覆盖点**：版本漂移（drift fail-closed）、rollback（stale-prior / immutable / stableNow / 目标权威）、evidence 删除级联、Skill uninstall/scope/move-rename identity、promotion trust boundary（store 重算 verdict + 冻结 real-skill 评估 provider）、跨 scope 泄漏（project-local 强制 + tenantScope SHA-256 + 白名单复制 + fail-closed 读取）。
- **验收**：Gate P5 PASS（失效矩阵 + rollback + host E2E 9 场景）；Phase 6/7 cascade + 受控 promotion component + E2E PASS；三 seam 关闭（`ef880c6` / `14b90d0` / `c2c27ec`）。
- **边界（如实）**：crash consistency / WAL（transition/rollback 的 current 覆盖与 event append 无原子性）是 real-host 部署前 blocker；真实宿主当次 tool/permission/environment/model 指纹来源未接线。

## 交接结论

- 六层中，Catalog / Discovery / Resolver / Execution / Lifecycle-Security 五层有 component +（shadow/host integration）+（project-local E2E）证据；Selection 层仅 component（模型侧 exact-set 未做）。
- 未关闭 blocker（真实宿主部署前）：Selection 模型侧评测、真实 canary/active 部署、crash consistency / WAL、真实宿主指纹来源。
- Phase 0～6 全部 Complete；Phase 7 分层验证完成。后续真实宿主部署须先关闭上述 blocker（尤其 crash consistency），再启动 canary/active。
