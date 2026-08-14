# Phase 0 — Project-local 实现基线与 Pilot 决策

日期：2026-08-14
状态：Phase 0 交付物（Documentation Discovery，已按 Leader 验收修订）
性质：基于当前安装版本证据的基线冻结；区分「已验证宿主能力」「设计决策」「未决」，未决不伪冻结。

---

## 0. 结论速览（Gate P0）

| # | 交付物 | 结论 | 类型 |
|---|---|---|---|
| 1 | 源码根目录 / 语言 / 模块布局 | 冻结：`D:\Users\a1324\Desktop\skill机制` + TypeScript + `src/*` 模块布局 | 设计决策 |
| 2 | package manager / 精确命令 / 版本来源 | 冻结：npm + npm scripts；`npm install` / `npm test` / `npm run typecheck`；版本见 §2.3 | 证据 + 决策 |
| 3 | skill_id / revision / source_hash / manifest / 同名 / move-rename | 冻结：完整 SHA-256（64 hex）内容与路径派生；move/rename 按新实例 | 设计决策（宿主无 ID） |
| 4 | 首个 pilot Skill + 外部 verifier | 历史选择：`docx`；已由 ADR-0010 替换为只读 SQL pagination 静态检测 | 证据 + 决策 |
| 5 | persistence / retention / delete seam | 冻结：Phase 1 不持久化真实事件；Phase 2 仅 `sensitivity=none`，`retentionClass=project_manual`，无自动 TTL | 设计决策 |
| 6 | 风险 / 阻塞 / Gate P0 结论 | **Gate P0 = PASS**（六项均有文件证据）；仍待验证项见 §6.3，均不阻塞 Phase 1 fixture | 结论 |

---

## 1. 已验证宿主能力（`@earendil-works/pi-coding-agent@0.84.1`）

以下均来自随包类型定义与文档的全文读取，非推断。宿主包位于
`C:\Users\a1324\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent`。

### 1.1 版本与运行环境

| 项 | 值 | 证据来源 |
|---|---|---|
| `@earendil-works/pi-coding-agent` | **0.84.1** | 该包 `package.json` |
| `@earendil-works/pi-ai` | **0.84.1** | 嵌套 `node_modules/@earendil-works/pi-ai/package.json` |
| `pi-agent-core` / `pi-client` / `pi-protocol` / `pi-tui` | **0.84.1** | 嵌套 `node_modules/@earendil-works/*/package.json` |
| Node engine | `>=22.19.0` | pi-coding-agent `package.json` engines |
| 本机 Node | **v24.11.0** | `node --version` |
| 本机 npm | **11.6.1** | `npm --version`（另有 pnpm 10.33.0、bun 1.3.14） |
| TypeBox（`Type` 来源） | **1.3.7** | pi-coding-agent `dependencies.typebox` |
| TypeScript（宿主 devDep） | **5.9.3** | pi-coding-agent `devDependencies.typescript` |

`skill-router.ts` 中 `Type` 由 `@earendil-works/pi-ai` 再导出（TypeBox 1.3.7）。

### 1.2 扩展加载方式（决定“无需写 `~/.pi`”）

来源：宿主 `docs/extensions.md` §Extension Locations。自动发现位置：

| 位置 | 作用域 |
|---|---|
| `~/.pi/agent/extensions/*.ts` / `*/index.ts` | 全局 |
| `.pi/extensions/*.ts` / `*/index.ts` | **project-local**（仅项目受信后加载） |

- 扩展经 **jiti** 加载，TypeScript 免编译直接运行（`docs/extensions.md`）。
- 扩展目录内放 `package.json` + `npm install` 后，`node_modules/` 自动可解析。
- 默认导出 `function (pi: ExtensionAPI)` 工厂。

结论：整个原型可放在项目 `.pi/extensions/` 下，**无需写入 `C:\Users\a1324\.pi`**，满足实施计划 §3.3 第 6 项与 AGENTS.md 的 project-local 约束。

### 1.3 核心类型（逐字段核对）

来源：`dist/core/skills.d.ts`、`dist/core/source-info.d.ts`。

```ts
interface Skill {
  name: string;
  description: string;
  filePath: string;    // 指向 SKILL.md
  baseDir: string;     // skill 根目录
  sourceInfo: SourceInfo;
  disableModelInvocation: boolean;
}

interface SourceInfo {
  path: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  baseDir?: string;
}
```

**关键结论：宿主 `Skill`/`SourceInfo` 不提供任何稳定 `skill_id`、`skill_revision`、`source_hash`、依赖清单。** 数据合同 §3.1 要求 Phase 0 冻结其派生算法——见 §3。

`SkillFrontmatter`（`dist/core/skills.d.ts`）仅结构化暴露 `name`、`description`、`disable-model-invocation`（其余为 `[key: string]: unknown`）。因此 `SkillRecord` 的 `declaredAliases` / `declaredPermissions` / `declaredEffects` / `dependencyManifest` 无宿主来源。其中 `declaredPermissions` / `declaredEffects` 只保存作者显式声明，**不得从脚本行为或未知 frontmatter 推断**——见 §3.6。

### 1.4 生命周期事件（`pi.on(...)` 完整清单）

来源：`dist/core/extensions/types.d.ts` 中 `ExtensionAPI.on()` 与 `ExtensionEvent` 联合类型。已验证事件名：

- 会话：`project_trust`、`resources_discover`（可返回 `skillPaths`）、`session_start`、`session_info_changed`、`session_before_switch`、`session_before_fork`、`session_before_compact`、`session_compact`、`session_shutdown`、`session_before_tree`、`session_tree`
- 推理：`input`（可拦截/改写/处理用户输入）、`context`（可改 messages）、`before_provider_request`、`before_provider_headers`、`after_provider_response`
- Agent 循环：`before_agent_start`、`agent_start`、`agent_end`、`agent_settled`、`turn_start`、`turn_end`
- 消息：`message_start`、`message_update`、`message_end`
- 工具：`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`tool_call`（可 block / 原位改 input）、`tool_result`（可改 result）
- 其他：`model_select`、`thinking_level_select`、`user_bash`

**关键结论（对照实施计划 §3.2 的未决项）**：

1. `before_agent_start` **确实提供当前用户任务**：`BeforeAgentStartEvent.prompt`（“The raw user prompt text (after expansion)”，见 types.d.ts 第 543–553 行）。原计划标注“是否提供当前用户任务”未决 → 现在**已验证据**，可作自动 discovery 触发源。
2. 工具观察 hook **存在**：`tool_call` / `tool_result` / `tool_execution_*`；执行后 hook 存在：`agent_end`（带 `messages`）/ `agent_settled` / `turn_end`（带 `toolResults`）。
3. 仍**不存在**（见 §6）：rename/move/uninstall 通知事件、持久化 API、独立鉴权/审批/sandbox API、secret-scan/redaction API。

### 1.5 允许复制的当前工作模式

来源：现有扩展 `C:\Users\a1324\.pi\agent\extensions\skill-router.ts`（及 `skill-router/directory.ts`、`directory.test.ts`），与实施计划 §3.1 一致：

- `pi.registerTool(defineTool({...}))`；`defineTool` 的 `execute` 返回 `{ content, details }`。
- `pi.on("before_agent_start", (event, ctx) => ...)` 可读取并替换 `event.systemPrompt`；`event.systemPromptOptions.skills ?? []` 提供当前 `Skill[]`。
- 现有代码读取 `Skill.name` / `description` / `filePath` / `disableModelInvocation` / `sourceInfo.scope`。
- 现有测试用 `node:test` + `node:assert/strict`（`directory.test.ts`）。

---

## 2. 源码根目录、语言、模块布局、命令（冻结）

### 2.1 根目录与语言

- **Project root（唯一源码根）**：`D:\Users\a1324\Desktop\skill机制`
- **语言**：TypeScript（宿主扩展即 TS，jiti 免编译；数据合同以 TS 形状表示）。
- **运行时**：Node `>=22.19.0`（本机 v24.11.0 满足）。

### 2.2 模块布局（对齐实施计划 §5 模块所有权）

```text
D:\Users\a1324\Desktop\skill机制\
├── .pi/extensions/skill-cortex/        # Pi 薄适配层入口（自动发现；project-local）
│   └── index.ts                        # export default (pi: ExtensionAPI)
├── src/
│   ├── core/contracts/                 # schema、不变量、序列化（Workstream A）
│   ├── core/registry/                  # Skill ingest、revision、依赖指纹（A）
│   ├── discovery/                      # FTS/BM25、候选卡、补搜（B）
│   ├── practice/                       # observer、脱敏、隔离、retention/delete（C）
│   ├── procedures/                     # 部分编译、artifact、验证输入（D）
│   ├── runtime/                        # resolver、guard、fallback、invalidation（E）
│   ├── adapters/pi/                    # 已验证宿主 API 薄适配
│   └── evaluation/                     # fixtures、paired replay、安全/成本报告（F）
├── fixtures/                           # 项目内复制的 skill fixture 与测试数据
└── package.json                        # 命令与依赖（Phase 1 创建）
```

说明：上述为**冻结的目录决策**；实际建目录/建 `package.json` 属 Phase 1 起的工作，不在本 Phase 0 文件所有权内。共享类型只由 Workstream A 修改（计划 §5）。

### 2.3 package manager 与精确命令

冻结的 `package.json` 内容（Phase 1 创建）：

```json
{
  "devDependencies": { "typescript": "5.9.3" },
  "scripts": {
    "test": "node --test",
    "typecheck": "tsc --noEmit"
  }
}
```

| 项 | 命令 | 依据 |
|---|---|---|
| 包管理器 | **npm** | 现有 `C:\Users\a1324\.pi\agent\npm\package-lock.json`（lockfileVersion 3）+ 宿主 `npm` scripts；本机 npm 11.6.1 |
| 安装 | `npm install` | 生成 lockfile + node_modules（Phase 1 首次执行） |
| 测试 | `npm test`（= `node --test`） | 现有 `directory.test.ts` 用 `node:test`/`node:assert/strict`；Node ≥22.19 原生跑 `.ts`（type-stripping） |
| 类型检查 | `npm run typecheck`（= `tsc --noEmit`） | 本地 devDependency `typescript@5.9.3`（精确锁定，非 `^`） |
| 构建门 | 等同 `npm run typecheck` | jiti 直跑 TS，无 emit；`tsc --noEmit` 即构建门 |
| lint / format | **MVP 不引入** | 现有扩展无任何 lint/format 配置；以 typecheck + test 为质量门 |

**版本来源汇总**：Node v24.11.0（本机实测）、npm 11.6.1（本机实测）、TypeScript 5.9.3（宿主 `devDependencies`，本项目精确锁定）、TypeBox 1.3.7（宿主 `dependencies`）、宿主 API 0.84.1（随包 `package.json`）。

> **重要：以上命令为“冻结的决策”，当前尚未运行。** Phase 1 创建 `package.json` 并执行 `npm install` 后，`npm test` 与 `npm run typecheck` 须首次实测通过，届时把实际输出与退出码回写实施计划 §12。本 Phase 0 不把未运行的命令表述为已验证。
>
> 另注：`node --test` 对 `.ts` 的 native type-stripping 依赖“仅可擦除语法”（接口、类型注解）。本项目契约均为可擦除 TS；若后续引入 enum/namespace/参数属性需改用 `--experimental-transform-types` 或 tsx 加载器，届时在 Phase 1 实测并回写。

---

## 3. 标识与版本（冻结；宿主无 ID，全部为派生算法）

数据合同 §3.1 要求 `skill_id` 算法“根据真实宿主能力冻结”。宿主不提供任何稳定 ID，故以下为**本项目自研派生算法（设计决策）**，不构成对宿主能力的假设。所有哈希均为**完整 SHA-256（64 hex）**，无截断。

### 3.1 skill_id（逻辑标识）

```
skill_id = "skill:" + sha256( scope + "\u0000" + normalize(baseDir) )     # 64 hex
normalize(p) = NFKC → lowercase → path.resolve → 反斜杠转 "/"
```

- 规范定位符 = `scope + 绝对 baseDir`。`SourceInfo.path`（SKILL.md 绝对路径）与 `baseDir` 是宿主仅有的稳定定位信息。
- **同名不同 scope/path ⇒ baseDir 不同 ⇒ 不同 `skill_id`**，满足数据合同验收“同名不同 scope/path 不共享 id”。
- Windows 路径大小写不敏感，`lowercase` 处理保证同一实例跨大小写写法稳定。

### 3.2 skill_revision（不可变逻辑 revision）

```
skill_revision = "rev:" + sha256( join(按 role、相对路径排序的 "role\u0000relpath\u0000contentHash" 条目) )   # 64 hex
```

- 覆盖整个依赖清单（含 SKILL.md、scripts、references、assets），任何内容变化产生新 revision。
- 逻辑文档统一用 `skill_revision`，TS 字段 `skillRevision`（ADR-0006）。

### 3.3 source_hash（内容指纹，非 revision 身份）

```
source_hash = "sha256:" + sha256(SKILL.md 字节)     # 64 hex
```

- 至少覆盖 `SKILL.md`（ADR-0006）；仅表示内容指纹，不承担 revision 身份语义。

### 3.4 dependency manifest

```ts
Array<{ locator: string /* 相对 skill 根、正斜杠 */; contentHash: string /* 64 hex */; role: "instruction" | "script" | "reference" | "asset" }>
```

- 枚举规则：`SKILL.md`→instruction；`scripts/**`→script；`references/**`→reference；`assets/**` 与 `templates/**`→asset。
- 该清单是 `CompiledProcedure.dependencyFingerprint` 的源头（数据合同 §3.2）；纯确定性 procedure 不绑定模型，含 `llm_holes` 的才绑定 `modelId`/`promptHash`。

### 3.5 同名 scope/path 与 move/rename 语义

- **同名不同 scope/path**：不同 `skill_id`（§3.1 保证）。
- **move/rename/跨设备**：宿主无 rename/move 通知事件（§1.4 结论）。冻结语义 = **按新安装实例处理**（数据合同 §3.1 默认），避免错误继承经验。
- **未决**：内容指纹相同的“新路径即旧实例移动”的内容级对账（source_hash 相等 + name 相等 + 路径不同）**不在 MVP 冻结**——需要更多证据（重复安装 vs 移动无法仅靠内容区分）。留 backlog。

### 3.6 declaredPermissions / declaredEffects 语义（只存作者显式声明）

`SkillRecord` 的 `declaredPermissions` / `declaredEffects`（数据合同 §4.1）遵循：

1. **只保存作者在 `SKILL.md` frontmatter 中显式声明的字段**（如 `allowed-tools` 等被明确认可的声明字段）；**不得从脚本行为、文件系统副作用或未知 frontmatter 推断**。
2. **缺失时保存为空数组**，并保留 provenance（记录“来源 = 作者未声明”）。
3. **空数组 ≠ 宿主授权**：有效权限始终由独立 runtime policy 逐次决定（ADR-0006“熟练度不得扩大权限”），Phase 4 前验证该 policy。空数组仅表示“作者无声明”，不代表“无需权限/无副作用”。

例：pilot `docx` 的 frontmatter 只有 `name` / `description` / `license`，无任何权限/副作用声明 → `declaredPermissions = []`、`declaredEffects = []`（附 provenance）。这不会被误读为宿主授权。

---

## 4. 首个 Pilot Skill 与外部 verifier（冻结）

### 4.1 历史选择：`docx`（已由 ADR-0010 替换）

> 2026-08-14 复核发现 `docx/LICENSE.txt` 禁止在服务外保留复制件、复制及制作派生作品，因此本节的 fixture 与 procedure 方案不得执行。Phase 3 当前 pilot、边界和许可决策以 ADR-0010 为准；本节只保留为决策历史。

| 项 | 值 |
|---|---|
| 名称 / 描述触发 | `docx`（Word 文档创建/读取/编辑） |
| 安装位置 | `C:\Users\a1324\.agents\skills\docx\`（Pi 默认全局 `~/.agents/skills/`，scope=**user**） |
| frontmatter license | `Proprietary`（见 `SKILL.md`、`LICENSE.txt`） |

选定理由（对齐实施计划 §8 Pilot 选择门槛）：

1. **只读/幂等边界可明确划分**：`office/validate.py`（XSD 校验）与 `office/unpack.py`（解包）只读或写入项目临时目录；“生成新文件”步骤**首版排除**，其可重复性未经重复运行验证（见 §4.2）。
2. **输入/环境/工具依赖可枚举**：输入=docx 文件路径；工具=`office/validate.py`、`office/unpack.py`（Python3 + lxml/xsd）；可选=`office/pack.py`、`office/soffice.py`（LibreOffice）、`docx`（npm 库，属生成，首版不用）。
3. **外部可观测 postcondition/verifier**：`python scripts/office/validate.py doc.docx` 做 OOXML XSD schema 校验，退出码 0/1（确定性、非 LLM）；内容正确性用 `unpack.py` + 对 `word/document.xml` 的确定性文本片段断言回读。
4. **多任务变体与边界反例**：报告/备忘录/信函/表格/TOC/页码/批注/修订等变体；边界=缺 page-size（默认 A4 陷阱）、`xml:space="preserve"`、paraId/durableId 溢出（可 auto-repair）、空内容、非 docx 输入。
5. **原 Skill 只读（历史提议，已禁止）**：曾计划复制到 `fixtures/skills/docx/`；许可复核后确认不得复制，且未执行该计划。

**Proprietary fixture 约束（已否决）**：project-local 与 gitignore 都不能消除许可限制；不得复制该 Skill，也不得从中派生 procedure。

### 4.2 首版 procedure 边界（收窄）

- **首版覆盖（确定性、可回放、只读或幂等）**：
  1. `validate.py` —— OOXML XSD 结构校验（只读，退出码 0/1，外部 verifier）。
  2. `unpack.py` —— docx→XML，写入**项目临时目录**（可清理、重复运行结果一致 ⇒ 幂等）。
  3. 文本回读 —— 对 `word/document.xml` 做确定性文本片段断言（内容后置，非 LLM judge）。
- **首版排除**：`pack.py`（XML→docx）、docx-js 生成新文件、`soffice` 转换、`accept_changes` 修订。**“生成新文件”未经重复运行验证前不视为可重复操作**，是否进入快路径留在 held-out 实测后再决定。
- **llm_hole**：自然语言内容 → XML/docx 规格映射（属生成，首版不进快路径）。

---

## 5. Project-local Persistence / Retention / Delete seam（冻结）

宿主无任何持久化 API（`pi.appendEntry` 仅写会话状态，非通用库）。故持久化为本项目**自研 seam（设计决策）**，全部落在 project-local。

| 维度 | 冻结决策 |
|---|---|
| 介质 | **已由 ADR-0009 修订**：project-local 文件库 `<project>/.skill-cortex/`；每个 `PracticeEvent` 使用不可变 JSON 事件文件，并以 claim/tombstone 支持原子身份与物理删除。Registry/Profile/Procedure 仍使用 JSON 索引。 |
| Phase 1 持久化 | **不持久化真实 `PracticeEvent`**；discovery 为纯离线 fixture/shadow，只产出项目内 synthetic/shadow fixture，不写真实 store |
| 写入门槛 | Phase 2 的 store **仅接受 `sensitivity=none` 的最小化事件**；`internal` / `confidential` 默认拒绝写入 |
| retention 策略 | `retentionClass=project_manual`：保留至显式 tenant/project 删除，**不设自动 TTL** |
| at-rest 加密 | **不由应用提供**；仅依赖项目目录 OS ACL。因此高敏（internal/confidential）数据**禁止进入** store |
| 跨设备同步 | **关闭**（off） |
| tenantScope 隔离 | 至少区分 `user`/`project`；MVP 默认 `project`（全部 project-local） |
| 数据分区 | `real`/`shadow`/`evaluation`/`synthetic` 分目录物理隔离；eval/synthetic 永不进生产 proposal 查询（ADR-0008、数据合同 §7） |
| 脱敏 | 自研最小化/secret-scan seam（宿主无 redaction API）；默认不落盘原始任务、完整文件、工具原始输出 |
| 删除 seam（**必须可测试**） | `delete(evidenceId)` 级联：依赖该 evidence 的 cue/procedure 重新评估或 `suspended`（数据合同 §7）。Phase 2 必须有删除后级联失效的自动化测试 |
| 卸载语义 | 原始 Skill 卸载 ⇒ 派生数据 `suspended`；是否保留待重装由 `retentionClass=project_manual` 决定（保留至显式删除） |

---

## 6. 风险、阻塞与 Gate P0 结论

### 6.1 已验证 / 已解除的原计划未决项

| 计划 §3.2 未决项 | 现状 |
|---|---|
| `before_agent_start` 是否提供任务上下文 | **已验证提供**：`event.prompt`（原始用户任务，types.d.ts 543–553） |
| post-execution / tool hook 名称与 payload | **已验证存在**：`tool_call`/`tool_result`/`tool_execution_*`/`agent_end`/`agent_settled`/`turn_end` |
| project-local 加载 adapter 的标准方式 | **已验证**：`.pi/extensions/*/index.ts`（jiti 免编译，项目受信后加载） |

### 6.2 仍不存在 / 未验证（不阻塞 Phase 1 fixture）

| 缺口 | 影响 | 处置 |
|---|---|---|
| 无稳定 skill ID / rename / move / uninstall 通知 | 身份与生命周期需自研 | 已冻结内容+路径派生方案（§3）；move 按新实例 |
| 无独立 authorization / approval / sandbox API | 快路径鉴权 gate 无宿主实现 | `tool_call` 可 block，但“真实审批语义”**未验证**；Phase 4 前需实测 `tool_call` 阻断是否等价审批 |
| 无持久化 / secret-scan / redaction API | Practice Store 需自研 | project-local 文件库（§5）；脱敏 seam 自研 |
| `SkillRecord` 的 aliases/effects/permissions 无宿主来源 | 需自行解析 frontmatter/文件树 | 已冻结派生规则（§1.3、§3.4、§3.6） |
| `pi.exec` 与 agent 自带 bash 的权限/沙箱语义未核对 | procedure 执行载体选择 | Phase 0 未实测；procedure 快路径执行载体留 Phase 3 实测后冻结 |
| `npm test` / `npm run typecheck` 首次运行 | 命令尚未执行 | Phase 1 建 `package.json` 后实测，回写实施计划 §12 |

### 6.3 Gate P0 结论

**Gate P0 = PASS。**

- 实施计划 §3.3 六项交付物均已给出**文件证据**：源码根/语言/布局（§2）、命令与版本（§2.3）、身份/revision/hash/manifest/move（§3）、pilot+verifier（§4）、project-local 持久化/retention/删除（§5）、无 `~/.pi` 写入（§1.2）。
- 计划 §3.3 判定条件为“六项均有文件证据”→ 满足，**PASS**，可启动 Phase 1。

**仍待验证、但不阻塞 Phase 1 fixture 的事项**（Phase 1 只做 Registry + 静态 discovery 的离线 fixture 实现，无需触碰下列项）：

1. 鉴权/审批/sandbox 宿主等价性（Phase 4 前验证）。
2. `pi.exec` 沙箱语义（Phase 3/4 前验证）。
3. `npm test` / `npm run typecheck` 首次运行结果（Phase 1 首次执行时验证）。
4. `validate.py` / `unpack.py` 的 Python 依赖（lxml/xsd）在本机是否已安装（fixture 实测时验证）。

---

## 交接

```text
Ownership:
  docs/research/2026-08-14-phase0-project-baseline.md（唯一）

Files changed:
  docs/research/2026-08-14-phase0-project-baseline.md（修订：retention 政策、npm scripts、
  SHA-256 全长度、declaredPermissions/Effects 语义、pilot 边界收窄、Gate P0 判 PASS）

Docs/API sources followed:
  - AGENTS.md / README.md / ADR-0006 / ADR-0007 / ADR-0008
  - docs/design/dual-memory-data-contracts.md
  - docs/plans/2026-08-14-dual-memory-implementation-plan.md
  - docs/research/2026-08-14-experience-guided-installed-skill-proceduralization.md
  - docs/adr/0005-benchmark-data-boundary.md / docs/reviews/2026-08-14-skill-cortex-audit.md（历史依据）
  - 宿主包 @earendil-works/pi-coding-agent@0.84.1：dist/core/skills.d.ts、
    dist/core/source-info.d.ts、dist/core/extensions/types.d.ts、docs/skills.md、docs/extensions.md
  - 现有扩展 C:\Users\a1324\.pi\agent\extensions\skill-router.ts + skill-router/directory.ts + directory.test.ts
  - 现有扩展依赖 C:\Users\a1324\.pi\agent\npm\package.json + package-lock.json
  - pilot 源 skill C:\Users\a1324\.agents\skills\docx\{SKILL.md, LICENSE.txt, scripts/office/validate.py, scripts/office/*.py}

Commands run (只读，无外部写入):
  - ls / find 只读枚举 .pi、.agents、.claude、AppData 宿主包
  - node --version / npm --version / pnpm --version / bun --version
  - 只读读取上述类型定义、文档与 skill 文件

Verification results:
  - 宿主版本/类型/事件/加载位置：已逐字段核对（§1）
  - before_agent_start.prompt、tool_call/tool_result、agent_end 等事件：已在 dist 类型中确认存在
  - Skill/SourceInfo 无稳定 ID：已确认（§1.3）
  - pilot docx 的 validate.py（XSD 校验器，退出码 0/1）：已读源码确认（§4.1）

Known failures or unverified assumptions:
  - 鉴权/审批/sandbox 宿主 API：不存在（仅 tool_call 可 block，审批语义未验证），不阻塞 Phase 1 fixture
  - 持久化/secret-scan/redaction：宿主无，自研 seam 未实测
  - pi.exec 与 agent bash 的权限/沙箱等价性：未核对
  - npm test / npm run typecheck：冻结命令，尚未运行（Phase 1 首次执行验证）
  - validate.py / unpack.py 的 Python 依赖（lxml/xsd）本机是否已装：未验证
  - skill_id 内容级 move 对账（source_hash 相等但路径不同）：未决，MVP 按新实例处理

Downstream work now unblocked:
  - Phase 1（Registry + 静态 FTS/BM25 discovery 的 project-local fixture 实现）可启动
  - Workstream A：按 §2.2/§3 建立 src/core/contracts 与 src/core/registry，落地完整 SHA-256 的 ID/revision/hash/manifest
  - Phase 1：创建 package.json（typescript@5.9.3 + npm scripts），首次运行 npm install / npm test / npm run typecheck 并回写 §12
  - Phase 3 前（已由 ADR-0010 替换）：不得复制 docx；改为冻结 pagination pilot 的来源哈希、原创评测案例与 deterministic verifier
  - Phase 4 前：实测 tool_call 阻断是否可作鉴权 gate、pi.exec 沙箱语义
```
