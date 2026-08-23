# Phase 2 Observer（B3）验收报告：project-local 真实 Pi Practice observer

日期：2026-08-15（更新：host version 漂移修复 + E2E 完成）
状态：**Component implemented；Host integration complete（隔离 0.84.1 runner 链 + 真实 0.84.2 E2E）；B3 相关证据链完整**
对应 blocker：implementation-progress-audit **B3**（Practice Store 尚未连接真实 Agent 事件）
协调：phase12 的 `onDiscovery` seam 与 `load_skill details.source_hash` 已落地（工作区 `src/adapters/pi/core.ts` / `index.ts`，同事改动，本报告未修改）

## 1. 交付

| 文件 | 内容 | 所有权 |
|---|---|---|
| `src/adapters/pi/practice-observer.ts` | 消费式 Practice observer：`registerPracticeObserver`、`RunCollector`、`createDiscoverySnapshotSource`、fail-closed 校验链 | C（本 Agent） |
| `src/adapters/pi/practice-observer.test.ts` | 18 个 fake-host 单元测试（含 stale-snapshot 回归） | C（本 Agent） |
| `src/evaluation/phase2/observer-integration.test.ts` | 3 个真实 0.84.1 extension runner 集成测试 | C（本 Agent） |
| `src/evaluation/phase2/observer-entry-integration.test.ts` | 1 个生产入口集成测试（真实 `loadExtensions([.pi entry])`） | C（本 Agent） |

未修改 `src/adapters/pi/core.ts` / `index.ts` / `.pi/extensions/skill-cortex/index.ts`（他人所有权）；接线已由 leader 完成，入口顺序为 cortex 先、observer 后。

## 2. 设计契约（与 phase12 seam 对齐）

observer 是**纯消费者**，不自行摄入、不独立重算候选、不把 shadow/fail-open 候选冒充已暴露：

```text
cortex before_agent_start（inject 成功）→ onDiscovery(result) → createDiscoverySnapshotSource.push
observer before_agent_start（随后执行）   → takeRouteSnapshot() → 绑定到 RunCollector
主 Agent 调用 load_skill                  → tool_call/tool_result 采集（脱敏）
agent_settled                             → source.clear() → 快照校验 → 合成并 append
```

- `RouteSnapshot` 最小化：只含 `candidateSkills[{skillId, skillRevision}]` + `exposedToAgent`（主 Agent 是否实际看到候选）。
- 父 source binding 只来自对应 `load_skill` 的 `tool_result.details.source_hash`（snake_case，严格 sha256，缺失/格式坏 fail-closed）；不使用 camelCase、不依赖快照携带 hash。
- **host version 不落盘**：无法从已验证宿主 API 可靠取得正在运行的 Pi 版本（真实宿主为 0.84.2，仓库锁定 0.84.1），observer 不硬编码 `environmentFingerprint` / `dependencyFingerprint.environmentClass`（相关字段可选，省略不违反合同）；如未来需要环境事实，必须由已核验调用方显式传入并受 policy 校验。
- `exposedToAgent !== true`（shadow / rewrite fail-open）⇒ 不产生 provenance=real 事件。
- 快照时序：同一次 `before_agent_start` 内一次性 take；settled 后 `clear()` 清 pending；新 run/rewrite 失败不残留旧快照（stale-snapshot 回归测试覆盖）。
- 无 verifier/guard/授权结果可观察 ⇒ 空数组 + attribution=unknown；绝不产生 `verified_skill_effect`。
- 任务文本只落盘派生 hash（`prompt-hash:<32hex>`、`candidate-count`、`selected-count`）；secret/路径/URL 不落盘。

## 3. 分层验证

### Component（局部测试）

```text
node --test src/adapters/pi/practice-observer.test.ts
  PASS；18 tests；18 pass；0 fail
```

覆盖：完整链路、seam 未接线、快照缺失、exposedToAgent=false、候选外、revision 失配、load 被拒、`source_hash` 缺失/格式坏/裸 64hex、自定义 verify 钩子、脱敏、多 run、无 sessionId、工具失败分类、非法工具名 sanitize、**两轮连续 run 的 stale-snapshot 回归（第二轮只消费新快照 / 第二轮无新快照不串用旧快照）**。

### Host integration（真实 0.84.1 extension runner 链，隔离环境）

```text
node --test src/evaluation/phase2/observer-integration.test.ts src/evaluation/phase2/observer-entry-integration.test.ts
  PASS；4 tests；4 pass；0 fail
```

被断言路径全部为宿主真实实现：`loadExtensionFromFactory`、`ExtensionRunner`、`SessionManager.inMemory`、`loadSkillsFromDir`、`buildSystemPrompt`（含原生全量 Skill block）、cortex 的 `onDiscovery`（真实 inject / shadow 分支）、`load_skill` 真实执行（details 带真实 SKILL.md 内容指纹 `source_hash`）。入口集成测试额外使用真实 `loadExtensions([.pi/extensions/skill-cortex/index.ts])`（jiti 加载生产入口）验证 cortex→snapshot→observer→project-local PracticeStore 完整接线。

1. **seam 未接线**（observer 无 routeSnapshotSource）⇒ 0 事件，onStatus 报告 unwired。
2. **真实完整链路**（inject + onDiscovery + 真实 load_skill + 真实事件发射）⇒ 1 个 `provenance=real` 事件：`parentSkillId/parentSkillRevision/sourceHash` 与真实 load details 一致、candidate 来自当次真实 discovery 快照（≤5）、attribution=unknown、policy 通过、store round-trip 与 `queryEvidence` 可见。
3. **shadow 模式**（cortex 报告 exposedToAgent=false）⇒ observer fail-closed，0 事件。

### End-to-end（真实交互式 Pi 会话，host=0.84.2）

**已完成（2026-08-15 两轮）**：

```text
pi --no-session -ne -e ./.pi/extensions/skill-cortex/index.ts --print <只读任务>
```

任务要求：从候选卡选择 Skill → 先调用 `load_skill` → 只用只读命令检查 `git status --short` 与 `git diff` → 汇报。主 Agent 两轮均选中 `github-repo-search` 并成功加载，随后只读检查 git；未执行 edit/write/安装/git 修改。真实事件经 `.skill-cortex/practice`（project-local，`.gitignore` 覆盖）落盘：`provenance=real`、`parentSkillId/parentSkillRevision/sourceHash` 与 load details 一致、candidate 为当次真实 Top-K（5）、selected 与 parent 一致、`attribution=unknown`（无 verifier）、policy 通过。

**首次 E2E 发现并修复 host version 漂移**（详见 §8）。

## 4. 全仓回归

```text
npm run typecheck   PASS（tsc --noEmit）
npm test            PASS；271 tests；269 pass；0 fail；2 skip
git diff --check    PASS
```

2 个 skip 为既有 Windows symlink 权限相关，与上一轮 audit 口径一致。

## 5. 接线建议（未执行；提交给 leader）

`.pi/extensions/skill-cortex/index.ts` 最小改动：

```ts
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSkillCortex } from "../../../src/adapters/pi/index.ts";
import { registerPracticeObserver, createDiscoverySnapshotSource } from "../../../src/adapters/pi/practice-observer.ts";
import { PracticeStore } from "../../../src/practice/store/index.ts";

export default function skillCortexEntry(pi: ExtensionAPI): void {
  const projectRoot = process.cwd();
  const source = createDiscoverySnapshotSource();
  registerSkillCortex(pi, { mode: "inject", onDiscovery: (r) => source.push(r) });
  registerPracticeObserver(pi, {
    store: new PracticeStore({
      rootDir: path.join(projectRoot, ".skill-cortex", "practice"),
      projectRoot,
    }),
    projectRoot,
    routeSnapshotSource: source,
    onError: (error, phase) => console.error(`[skill-cortex-observer] ${phase}:`, error),
  });
}
```

约束：注册顺序必须是 cortex 先、observer 后（同一 before_agent_start 链内 take 才能拿到 cortex push 的快照）；接线后首次运行需用户信任项目。

## 6. Known failures / 未验证边界

1. 真实会话只覆盖 `--print` 单轮路径；并行工具事件交错、自动 compaction 续跑、用户中断后 `agent_settled` 是否触发的语义以 docs 文本为准，未做交互式观测。
2. 跨进程 append / 断电 fsync 未压测（沿用 Phase 2 Gate 的既有风险）。
3. 多 session 并发 run 只做了单 session 多 run 测试；Map 按 sessionId 隔离，未并发压测。
4. 快照 push 依赖 cortex/observer 的注册顺序；顺序颠倒（observer 先注册）会 unwired fail-closed，但不产生错误事件。
5. `/skill:name` 命令展开路径、search_skills 补搜路径不产生事件（无 load_skill 证据，fail-closed 有意为之）。
6. 工具步骤只记录工具名类别（operationClass），args/result 一律不落盘；步骤级因果归因留待 verifier 可用后。
7. host version 不落盘意味着环境类证据缺失：若未来需要环境事实，必须先取得已验证的宿主接口并经 policy 校验，当前不做推断。

## 7. Downstream unblocked

- B3 证据链已完整（隔离 runner + 真实会话各产生 policy-valid real 事件）；是否正式关闭由 leader 依据本报告判定。
- 真实、可归因、policy-valid 的 PracticeEvent 已产生，满足 B4 的输入前置（多条父 Skill real 事件 → 最小 induction seam）；本报告不启动 B4/Phase 4。
- observer 的 `RouteSnapshot` 契约已与 phase12 `onDiscovery` 对齐，phase6 Activation Learner 可直接消费 `redactedTaskFeatures` + 快照字段，无需再改 seam。

## 8. 修复记录：host version 漂移（2026-08-15）

**问题**：真实宿主为 Pi **0.84.2**，但仓库锁定基线为 0.84.1。此前 observer 将 `environmentFingerprint` / `dependencyFingerprint.environmentClass` 硬编码为 `pi:0.84.1` / `pi-0.84.1`，首次真实 E2E 落盘的事件携带错误环境证据，不满足 production-eligible。

**修复（仅改本 Agent 文件）**：
1. `src/adapters/pi/practice-observer.ts`：删除 `OBSERVER_ENVIRONMENT_CLASS` / `OBSERVER_ENVIRONMENT_FINGERPRINT` 常量；`buildPracticeEvent` 不再输出 `environmentFingerprint`，`dependencyFingerprint` 仅保留 `sourceHash`；注释明确 host version 不落盘（无法从已验证宿主 API 可靠取得）。
2. `src/adapters/pi/practice-observer.test.ts`：断言改为 `environmentFingerprint===undefined` 且 `dependencyFingerprint?.environmentClass===undefined`（sourceHash 断言保留）。

**错误事件失效（保留 tombstone，不直接 rm）**：

```text
PracticeStore.invalidate("project:bcf863bcbed32e5513c21e03a7fbebab", ["obs-84586c21b9a534235994db5a6a455c687b5e258f"])
→ invalidatedEventIds=["obs-84586c21b9a534235994db5a6a455c687b5e258f"]
验证：getEvent=undefined；queryEvidence=0；listProvenance(real)=0；claim+tombstone 保留（ID 不复用、审计留存）；再次 invalidate 幂等。
```

**0.84.2 重跑验证**：以相同 `--no-session` 命令重跑，新事件 `obs-3bf8d613531604c011be6897bffcf1bf2f50fa7c`：`hasEnvironmentFingerprint=false`，`dependencyFingerprint={sourceHash:"sha256:e07f…"}`（无 environmentClass），`provenance=real`、`attribution=unknown`、policy 通过 —— 不谎报 0.84.1。

**结论**：仓库依赖/测试基线保持 0.84.1 不变；真实宿主可能是 0.84.2 等其它版本，observer 对无法验证的 host version 采取省略而非猜测。

## 9. B4：真实 pagination PracticeEvent（带 verifier）（2026-08-15）

**目标**：≥2 条真实、可归因、policy-valid、带 verifier 的 pagination PracticeEvent，使
`resolvePracticeEvidence` 验收门（Phase 3 Gate 失败项 `practice_evidence`）可过。

**机制设计**（observer 保持通用，不硬编码任何 verifier/operationClass）：

```text
真实 0.84.2 --no-session 会话（harness -e 加载，生产 .pi 入口未改）
  → 主 Agent 真实 discovery → 选中 supabase-postgres-best-practices → load_skill
  → observer 采集（B3 机制不变）
  → agent_settled 时调用 evidenceHook.collect(run, selection)
  → pagination hook：从 run.prompt（内存，不落盘）提取 SQL → detectPagination 复算
    → 结构化验证（class 受控 + evidence.matchText 真实存在于输入 + uses_offset 含 OFFSET）
  → 注入 step detect-offset-pagination(ok) + verifier phase3-pagination-structured-finding(pass)
  → policy 计算 attribution=verified_skill_effect → append
```

- 证据来源是真实宿主会话（任务由验收方提供项目原创 SQL），detector 与结构化验证均为
  确定性复算，不是 LLM 自评，也不把 evaluation/synthetic 案例改标 real。
- 无 SQL 的会话（hook 返回 undefined）事件保持 attribution=unknown；hook 验证失败 ⇒
  fail verifier + failed step（attribution=mixed）；hook 抛错 ⇒ fail-closed 不落盘。

**新增/修改文件**（全部本 Agent 所有）：

| 文件 | 内容 |
|---|---|
| `src/adapters/pi/practice-observer.ts` | 新增通用 `EvidenceHook`（steps/verifierResults 注入）；`RunCollector.prompt` 仅内存；`buildPracticeEvent` 合并 hook 证据并统一 stepId |
| `src/adapters/pi/practice-pagination-hook.ts` | `createPaginationEvidenceHook()`：SQL 提取、`detectPagination` 复算、结构化验证 |
| `src/evaluation/phase2/practice-evidence-b4.test.ts` | 7 个测试：hook 单元 + observer 集成 + `resolvePracticeEvidence` 门 + fail 路径 |
| `src/evaluation/phase2/b4-e2e-entry.ts` | E2E harness 入口（`-e` 加载，注入 evidenceHook；生产 `.pi` 入口未改） |

**验证**：

```text
node --test src/evaluation/phase2/practice-evidence-b4.test.ts
  PASS；7 tests；7 pass；0 fail
npm run typecheck（本 Agent 范围） PASS（非 phase12 induction WIP 错误为 0）
```

**真实 0.84.2 会话（两轮）**：

```text
pi --no-session -ne -e ./src/evaluation/phase2/b4-e2e-entry.ts --print <只读任务含项目原创 SQL>
```

| 字段 | 事件 1（obs-9ee1fe77…） | 事件 2（obs-79b95a72…） |
|---|---|---|
| provenance | real | real |
| parentSkillId | skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2 | 同左 |
| parentSkillRevision | rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec | 同左 |
| sourceHash | sha256:8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830 | 同左 |
| candidateSkillIds | 5（含父 Skill） | 5（含父 Skill） |
| selectedSkillIds | [父 Skill] | [父 Skill] |
| step | detect-offset-pagination:ok | detect-offset-pagination:ok |
| verifier | phase3-pagination-structured-finding=pass | 同左 |
| attribution | verified_skill_effect | verified_skill_effect |
| policy | ok | ok |

真实绑定与 Phase 3 Gate 报告的冻结绑定逐字段一致（skill id/revision/source hash）。

**resolvePracticeEvidence 验收门（真实绑定）**：

```text
resolvePracticeEvidence({ tenantScope, eventIds: [obs-79b95a72…, obs-9ee1fe77…],
  expectedParentSkillId/Revision/SourceHash=真实绑定,
  requiredOperationClass="detect-offset-pagination",
  requiredVerifierId="phase3-pagination-structured-finding" })
→ { ok: true, distinctRealCount: 2, reason: "ok" }
```

**未解决风险**：
1. hook 的 verifier 语义是"结构化 finding 独立验证"（class 受控 + 证据真实存在于输入），
   不验证 label 正确性（真实使用无 oracle）；detector/verifier 的 label 质量由 Phase 3
   held-out 已证明，B4 只补真实宿主证据链。
2. `run.prompt` 现由 observer 内存持有供 hook 使用；落盘仍只写派生 hash 与结构化结果，
   但内存生命周期内存在原始文本（harness 仅限验收，生产入口未启用 evidenceHook）。
3. 生产 `.pi` 入口是否/何时启用 evidenceHook 由 leader 决定（B4 仅提供机制与验收 harness）。
4. Phase 4 未启动；B4 不改变 procedure 状态（draft 保持），不触发 promotion。
