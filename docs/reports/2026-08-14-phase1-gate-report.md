# Phase 1 Gate P1 验收报告

日期：2026-08-14（更新：2026-08-15，B1/B2 关闭证据）
状态：**COMPONENT PASS；HOST INTEGRATION COMPLETE（B1/B2 已关闭，见 §7）；end-to-end 部分完成**
范围：project-local Registry、静态 BM25 discovery、候选卡、补搜工具、inject/shadow Pi adapter 与 project-local `load_skill`

> 2026-08-14 实施进度审计修正：原 `Gate P1 = PASS` 只适用于上述 project-local
> 组件与 fake-host 验收，不证明 Pi 最终 prompt 已只保留 Top-K。当前宿主集成和端到端状态
> 以[实施进度审计](../reviews/2026-08-14-implementation-progress-audit.md)为准。

## 1. 实际交付

- `src/core/contracts/`：冻结的数据合同 TypeScript 形状。
- `src/core/registry/`：完整 SHA-256 的 Skill 身份、source/revision、dependency manifest 与路径边界。
- `src/discovery/`：确定性 tokenizer、BM25、词法相关性 guard 与有界候选卡。
- `src/adapters/pi/`：基于当前真实 `ExtensionAPI`、`defineTool`、`Type.Object` 的薄适配层，
  含 `search_skills` 补搜与 project-local `load_skill` 按需加载（路径/revision/hash/大小 fail-closed）。
- `.pi/extensions/skill-cortex/`：project-local 入口，以 `inject` 模式移除原生全量 Skill block 并注入有界 Top-K。
- `src/evaluation/phase1/`：single/multi/no-skill、中文 alias、模糊名称和 hard confuser smoke。

## 2. 验证命令与结果

```text
npm install --ignore-scripts --cache .npm-cache
  PASS；240 packages audited；0 vulnerabilities

npm test
  PASS；100 tests；99 pass；0 fail；1 skip

npm run typecheck
  PASS；tsc --noEmit；覆盖 src/**/*.ts 与 .pi/**/*.ts

project-local extension runtime import smoke
  PASS；注册 before_agent_start handler 与 search_skills TypeBox object schema

production anti-pattern rg
  PASS；Router LLM、appendEntry、PracticeEvent 写入、CATEGORY_RULES、maturity/procedure ranking 命中 0
```

唯一 skip 是 Windows 当前权限不允许创建文件 symlink；junction 指向 baseDir 内、外以及角色目录逃逸均有实测。实现同时使用 `lstat`/`realpath`，拒绝链接形式的 `SKILL.md`，忽略 manifest 中的链接目录。

## 3. Smoke 指标

数据：8 个 synthetic Skill、9 个手工 smoke case；不作统计普适性声明。

| 指标 | 结果 |
|---|---:|
| Recall@5 | 1.0 |
| Set recall | 1.0 |
| No-skill accuracy | 1.0 |
| Router LLM calls | 0（结构性约束，不是运行时计费器） |
| 最大候选数 | 2 |
| 总候选卡字符 | 1283 |
| 估算 token | 324 |

p50/p95 与索引构建时间由每次 `npm test` 输出；该微型 smoke 的亚毫秒结果不代表真实 catalog 性能。

## 4. 安全与回退

- 生产入口为 `inject`：移除原生全量 block 成功后才注入有界 Top-K；任何 rewrite 失败 fail open，
  宿主保留原始 prompt 慢路径，绝不产生“全量 + Top-K”混合。`mode="shadow"` 仍可用（不注入）。
- Registry/index 失败时不修改原 system prompt，回到宿主原始 Skill 慢路径。
- `search_skills` 未初始化、构建失败、空查询或无匹配时均返回有界诊断，不返回全量 catalog。
- `load_skill` fail closed：未知 id/revision 失配/source drift/revision drift/超限/非 UTF-8/路径逃逸全部拒绝；
  只读正文，不执行脚本、不授予权限。
- 模型可见错误只包含稳定错误类别，不含绝对路径或原始错误文本。
- Phase 1 不写 Practice Store、不调用 Router LLM、不写用户级 Pi 环境。
- Skill package 的自定义 `SKILL.md` 路径必须位于 real baseDir 内；链接逃逸与非 `ENOENT` I/O 错误不会静默形成 revision。

## 5. 已知限制

1. 真实 Pi `Skill` 类型不暴露作者 aliases；adapter 当前不解析未知 frontmatter，因此中文 alias 结果只证明 synthetic 明确 alias 的 BM25 链路，不证明真实 installed Skill 的跨语言召回。
2. 未运行真实 Pi 项目信任交互，也未把候选注入用户日常环境；入口运行验证使用 project-local fixture 与真实 ExtensionRunner 链（`.pi/extensions/skill-cortex/index.ts` 经宿主 jiti loader 加载）。
3. `onError` 可把原始错误交给调用方作本地诊断；默认入口不配置该回调。调用方不得将其直接持久化或注入模型。
4. 当前相关性 guard 是第一版词法规则；出现真实 hard confuser/跨语言 miss 后再按 ADR 提案，不增加 Router LLM。
5. （已关闭，见 §7）原生全量 Skill block 残留问题。
6. （已关闭，见 §7）`load_skill` 按需加载路径。

## 6. Gate 结论

**Gate P1 component = PASS；host integration（B1/B2）= COMPLETE；end-to-end = PARTIAL。**
project-local shadow、候选注入测试、补搜、确定性身份与安全回退均通过；真实 Pi 0.84.1
extension runner 链上已证明最终 prompt 只含 Top-K、`load_skill` 按 project-local 约束可加载。
仍缺：真实用户日常环境的端到端运行（未授权写入）与真实 installed Skill 的跨语言召回证据。
不得据此启动下游 active path；后续修复顺序以实施进度审计为准。

## 7. B1/B2 关闭证据（2026-08-15）

### B1：prompt-external discovery 接管真实 Pi

- inject 路径先精确移除 `formatSkillsForPrompt(systemPromptOptions.skills)` 原生全量 block，再追加有界 Top-K；
  任何无法保证“最终 prompt 只含 Top-K”的路径都 fail open（返回 undefined，宿主保留原 prompt 慢路径）：
  原生 block 缺失/非唯一、skills 为空但 prompt 残留 `<available_skills>`、唯一 block 移除后仍有残留 marker。
- 新增真实宿主链测试 `src/evaluation/phase1/pi-host-integration.test.ts`：
  用真实 `loadExtensions`（jiti 加载 `.pi/extensions/skill-cortex/index.ts`）+ 真实 `ExtensionRunner.emitBeforeAgentStart`
  + 真实 `buildSystemPrompt`，断言未选中 Skill 的 name/description/location 全部消失、Top-K 与 CWD 保留；
  多扩展顺序下先执行扩展的修改保留、全量 block 不得残留。
- 真实 `agent-session.js`（0.84.1）核验：`_baseSystemPrompt` 与 `_baseSystemPromptOptions` 来自同一快照，
  `emitBeforeAgentStart` 传入的 `systemPrompt` 与 `systemPromptOptions.skills` 同源，移除算法与真实构建顺序一致。

### B2：project-local 按需加载 `load_skill`

- 项目自身注册 `load_skill`（真实 `defineTool` + TypeBox schema：`skill_id`/`skill_revision` 均 `minLength=1`）。
- 加载约束（fail closed）：只接受成功摄入 catalog 中的 `skill_id`；`skill_revision` 精确匹配；
  `sourceLocator` 必须绝对、常规文件、非 symlink/junction、realpath 在父 baseDir 内；
  大小 ≤ `MAX_SKILL_MD_BYTES`（256 KiB，边界含恰等值测试）；严格 UTF-8；
  重算 SKILL.md `sourceHash`（source_drift）与完整 dependency manifest + `skillRevision`（revision_drift，
  合同 §3.1：scripts/references/assets 变化同样失效缓存 revision）；枚举/IO 失败一律 path_failure。
- 只读正文，不执行 scripts、不返回 declaredPermissions/Effects/Aliases（权限边界测试）。
- 真实宿主链测试：`load_skill` 由 project-local 入口注册（不依赖用户全局扩展），真实 runner 链上
  按 `search_skills` 结果成功加载 fixture 并返回 `source_hash` 内容指纹。
- 对 B3 observer 的 seam：`onDiscovery` 回调（inject/shadow 均触发）携带当次有界候选快照与
  `exposedToAgent`/`deliveryMode`；归因边界为——shadow 报告 `exposedToAgent=false`，inject 仅当原生
  block 成功移除、最终 prompt 确定后报告 `exposedToAgent=true`，rewrite 失败不产出快照（只走
  `onError(prompt_rewrite)`）。`load_skill` 成功 details 返回 `source_hash`（`sha256:…`，可审计，非路径/正文）。
  接线 B3 `RouteSnapshotSource` 时只需过滤 `exposedToAgent===true` 并映射 `candidates → candidateSkills`。

### 验证命令（2026-08-15 全量）

```text
npm run typecheck   PASS（tsc --noEmit）
npm test            PASS；267 tests；265 pass；0 fail；2 skip（Windows symlink 权限，与本套件既有 skip 一致）
git diff --check    PASS
```
