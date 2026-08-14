# Phase 0：Pi 宿主 API 只读核验清单

状态：Phase 0 交付物（Documentation Discovery）— 2026-08-14
作者：Phase 0 Pi 宿主 API 核验 Agent
范围：核验 `lifecycle`、`tool`、`prompt`、`storage`、`permission`、`authorization`、`sandbox` 能力；只读，不写任何宿主环境。

---

## 0. 结论摘要（TL;DR）

1. **安装版本**：`@earendil-works/pi-coding-agent@0.84.1`（npm 全局安装），主入口类型 `dist/index.d.ts`，扩展系统类型集中在 `dist/core/extensions/types.d.ts`。
2. **`before_agent_start` 能否取得当前用户任务**：**能取得原始任务文本**。`BeforeAgentStartEvent.prompt: string` 是“扩展后的原始用户 prompt 文本”，另有 `images`、`systemPrompt`（可替换）、`systemPromptOptions`（含已加载的 `skills`、`cwd`、`contextFiles` 等）。**不存在名为 `TaskContext` 的结构化任务对象**——宿主没有提供比 `prompt + systemPromptOptions` 更丰富的“任务上下文”类型。discovery 可把 `event.prompt` 当作任务文本，把 `event.systemPromptOptions.skills` 当作当前已发现 Skill 集合。
3. **project-local adapter 能否无外部写入加载**：**能**。扩展从 `<cwd>/.pi/extensions/*.ts`（及 `*/index.ts`）自动发现，经 jiti 直接加载 TypeScript（无需编译），不写入 `~/.pi/agent` 或任何全局目录。约束：project-local 扩展在**项目被信任后**才加载（见 §5.2）；此外还有 settings.json `extensions` 数组、CLI `-e`、`package.json` 的 `pi.extensions`，以及完全进程内、不落盘的 SDK `createAgentSession({ sessionManager: SessionManager.inMemory() })` 路径。
4. **工具观察（PracticeEvent 采集）有宿主 hook**：`tool_call`（执行前，可 block、可改参）、`tool_result`（执行后，可改结果）、`tool_execution_start/update/end`、`turn_start/turn_end`、`agent_end`（含 messages）、`context`（每次 LLM 调用前，可改 messages）。
5. **注入候选卡有宿主 hook**：`before_agent_start` 返回 `{ systemPrompt }`，或 `context` 返回 `{ messages }`，两者都是已核实接口。
6. **存储**：宿主**没有**通用 KV/事务/secret-scan/retention/delete API。唯一持久化原语是 `pi.appendEntry(customType, data)`（写入会话 JSONL 的 `CustomEntry`，不进 LLM 上下文）+ 只读 `ctx.sessionManager`。Practice Store 必须由 adapter 自行在 project-local 落盘实现。
7. **权限/授权**：宿主没有内置 permission policy 引擎，但 `tool_call` 事件可返回 `{ block: true, reason }` 作为统一授权闸门；`session_before_*` 可 cancel；`project_trust` 事件 + `ctx.isProjectTrusted()`；`ctx.ui.confirm/select` 用于交互审批。参考实现：`examples/extensions/permission-gate.ts`、`protected-paths.ts`、`confirm-destructive.ts`。
8. **Sandbox**：**宿主无内置 sandbox**（`docs/security.md` 明示），扩展与工具以用户权限运行。隔离只能靠 OS/容器/VM（官方示例 `examples/extensions/sandbox/` 用 `@anthropic-ai/sandbox-runtime` 替换 bash 工具）。
9. **`skill_id` 与 `source_hash`**：宿主 `Skill` 类型**不含稳定 `skill_id` 也不含 `source_hash`**；只有 `name/description/filePath/baseDir/sourceInfo(scope)/disableModelInvocation`。二者必须由 adapter 派生（与 ADR/合同一致，未假定宿主提供）。
10. **未验证项**：`ctx.model.complete` / `pi.complete` / `ctx.callLLM` 之类“应该存在的 LLM 便捷调用”**均不存在**，不得发明（见 §6）。

---

## 1. 安装版本与证据路径

| 项 | 值 | 证据 |
|---|---|---|
| 包名 | `@earendil-works/pi-coding-agent` | `package.json` `"name"` |
| 版本 | **0.84.1** | `package.json` `"version": "0.84.1"` |
| 类型入口 | `./dist/index.d.ts` | `package.json` `"types"` / `"exports"."."` |
| 主入口 | `./dist/index.js` | `package.json` `"main"` |
| 配置目录名 | `.pi`（`CONFIG_DIR_NAME`） | `package.json` `"piConfig.configDir"` + `dist/config.d.ts:68` |
| 安装根 | `C:\Users\a1324\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\` | 只读检查 |

关键源码/类型文件（本次核验逐份读取）：

| 文件 | 内容 | 用途 |
|---|---|---|
| `dist/index.d.ts` | 顶层全部 re-export | 权威“可用 import”清单 |
| `dist/core/extensions/types.d.ts` | `ExtensionAPI`、全部事件类型、`ToolDefinition`、`ExtensionContext` | lifecycle/tool 核心 |
| `dist/core/extensions/loader.d.ts` / `loader.js` | 扩展发现与加载逻辑 | project-local 加载证据 |
| `dist/core/skills.d.ts` | `Skill`、`loadSkills`、`formatSkillsForPrompt` | Skill 语义来源 |
| `dist/core/source-info.d.ts` | `SourceInfo`、`SourceScope` | scope 溯源 |
| `dist/core/system-prompt.d.ts` | `BuildSystemPromptOptions` | systemPromptOptions 字段 |
| `dist/core/session-manager.d.ts` | `SessionManager`、`ReadonlySessionManager`、`CustomEntry` | 存储只读面 |
| `dist/core/sdk.d.ts` | `createAgentSession`、`CreateAgentSessionOptions` | 程序化 adapter 路径 |
| `docs/extensions.md` | 扩展官方文档（120KB） | 事件/API 语义 |
| `docs/skills.md` | Skill 发现与校验 | Skill 位置/校验 |
| `docs/security.md` | Project Trust 与无 sandbox 声明 | 权限/隔离边界 |
| `examples/extensions/*`（permission-gate / confirm-destructive / protected-paths / sandbox） | 官方授权/沙箱样例 | authorization 参考实现 |
| `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts` | `AgentToolResult`、`AgentToolUpdateCallback` | 工具返回值精确形状 |

> 注：`AgentToolResult`、`AgentToolUpdateCallback`、`ToolExecutionMode` 定义在依赖包 `@earendil-works/pi-agent-core`，由 `pi-coding-agent` re-export。

---

## 2. Allowed APIs（有当前安装文件证据）

### 2.1 顶层可用 import（`dist/index.d.ts` 摘录）

| import | 类型/值 | 说明 |
|---|---|---|
| `ExtensionAPI` | type | 扩展工厂入参，`on/registerTool/...` 全集 |
| `ExtensionContext` / `ExtensionCommandContext` | type | 事件 handler 的 `ctx` |
| `defineTool` | function | 保留参数推断的工具定义助手 |
| `ToolDefinition` / `ToolInfo` / `RegisteredTool` | type | 工具定义与查询结果 |
| `Skill` / `SkillFrontmatter` | type | Skill 语义来源 |
| `loadSkills` / `loadSkillsFromDir` / `formatSkillsForPrompt` | function | 加载与格式化 Skill |
| `SourceInfo` / `SourceScope` | type | scope 溯源 |
| `createSyntheticSourceInfo` | function | 构造合成 SourceInfo（SDK 场景） |
| `createAgentSession` / `SessionManager` / `DefaultResourceLoader` | function/class | SDK 程序化路径 |
| `isToolCallEventType` / `isBashToolResult` / `isReadToolResult` … | function | 事件窄化 type guard |
| `withFileMutationQueue` | function | 与内置 edit/write 共享同文件队列 |
| `VERSION` / `getAgentDir()` / `getPackageDir()` / `CONFIG_DIR_NAME` | value/function | 版本与目录解析 |

### 2.2 Lifecycle 事件（`ExtensionAPI.on` 全集，`dist/core/extensions/types.d.ts:866` 起）

所有事件 handler 形如 `(event, ctx: ExtensionContext) => Promise<R | void> | R | void`；有 result 的事件标注返回类型。

| 事件名 | payload 类型（关键字段） | handler 可返回 | 本项目用途 |
|---|---|---|---|
| `project_trust` | `ProjectTrustEvent{ cwd }`（ctx 受限） | `ProjectTrustEventResult{ trusted: "yes"\|"no"\|"undecided"; remember? }` | 信任决策（仅 user/global/CLI 扩展参与） |
| `resources_discover` | `{ cwd; reason }` | `{ skillPaths?; promptPaths?; themePaths? }` | 追加 Skill 路径 |
| `session_start` | `{ reason: "startup"\|"reload"\|"new"\|"resume"\|"fork"; previousSessionFile? }` | — | 重建内存索引 |
| `session_info_changed` | `{ name? }` | — | — |
| `session_before_switch` | `{ reason; targetSessionFile? }` | `{ cancel? }` | 取消切会话 |
| `session_before_fork` | `{ entryId; position }` | `{ cancel?; skipConversationRestore? }` | 取消 fork |
| `session_before_compact` | `{ preparation; branchEntries; customInstructions?; reason; willRetry; signal }` | `{ cancel?; compaction? }` | 自定义/取消压缩 |
| `session_compact` | `{ compactionEntry; fromExtension; reason; willRetry }` | — | 压缩后 |
| `session_before_tree` | `{ preparation; signal }` | `{ cancel?; summary?; customInstructions?; replaceInstructions?; label? }` | 取消树导航 |
| `session_tree` | `{ newLeafId; oldLeafId; summaryEntry?; fromExtension? }` | — | — |
| `session_shutdown` | `{ reason; targetSessionFile? }` | — | 清理资源/落盘 |
| `context` | `ContextEvent{ messages: AgentMessage[] }` | `ContextEventResult{ messages? }` | **每次 LLM 调用前注入/改写候选卡** |
| `before_provider_request` | `{ payload }` | 替换 payload | 调试 |
| `before_provider_headers` | `{ headers }`（原地改） | — | 注入 header |
| `after_provider_response` | `{ status; headers }` | — | — |
| `before_agent_start` | `BeforeAgentStartEvent{ prompt; images?; systemPrompt; systemPromptOptions }` | `BeforeAgentStartEventResult{ message?; systemPrompt? }` | **主注入点（见 §4）** |
| `agent_start` | `{}` | — | 运行开始 |
| `agent_end` | `AgentEndEvent{ messages: AgentMessage[] }` | — | **运行级结果采集** |
| `agent_settled` | `{}` | — | 无自动续跑时 |
| `turn_start` | `{ turnIndex; timestamp }` | — | — |
| `turn_end` | `TurnEndEvent{ turnIndex; message; toolResults }` | — | **回合级结果采集** |
| `message_start` / `message_update` / `message_end` | `{ message }` / `{ message; assistantMessageEvent }` | `message_end` 可返回 `{ message? }` | 消息级 |
| `tool_execution_start` | `{ toolCallId; toolName; args }` | — | 工具开始 |
| `tool_execution_update` | `{ toolCallId; toolName; args; partialResult }` | — | 流式部分结果 |
| `tool_execution_end` | `{ toolCallId; toolName; result; isError }` | — | 工具结束 |
| `model_select` | `{ model; previousModel; source }` | — | — |
| `thinking_level_select` | `{ level; previousLevel }` | — | — |
| `tool_call` | `ToolCallEvent`（`toolName; toolCallId; input` 可改） | `ToolCallEventResult{ block?; reason?; terminate? }` | **授权闸门 + 观察** |
| `tool_result` | `ToolResultEvent`（`toolName; toolCallId; input; content; details; isError; usage?`） | `ToolResultEventResult{ content?; details?; isError?; usage? }` | **结果观察/改写（PracticeEvent）** |
| `user_bash` | `UserBashEvent{ command; excludeFromContext; cwd }` | `UserBashEventResult{ operations?; result? }` | `!`/`!!` 拦截 |
| `input` | `InputEvent{ text; images?; source; streamingBehavior? }` | `InputEventResult{ action: "continue"\|"transform"\|"handled" }` | 输入拦截/改写 |

**type guard**：`isToolCallEventType("bash"|"read"|"edit"|"write"|"grep"|"find"|"ls", event)` 及 `isBashToolResult/…`（`types.d.ts:731` 起）。

### 2.3 Tool API（`registerTool` / `defineTool`）

| 项 | 内容 | 证据 |
|---|---|---|
| `defineTool(tool): ToolDefinition & AnyToolDefinition` | 保留参数推断 | `types.d.ts:385` |
| `ToolDefinition<TParams, TDetails, TState>` 字段 | `name`、`label`、`description`、`promptSnippet?`、`promptGuidelines?`、`parameters`（TypeBox）、`constrainedSampling?`、`renderShell?`、`prepareArguments?`、`executionMode?`、`execute(...)`、`renderCall?`、`renderResult?` | `types.d.ts:343` |
| `execute` 签名 | `(toolCallId, params: Static<TParams>, signal: AbortSignal\|undefined, onUpdate: AgentToolUpdateCallback<TDetails>\|undefined, ctx: ExtensionContext) => Promise<AgentToolResult<TDetails>>` | `types.d.ts:362` |
| `AgentToolResult<TDetails>` | `{ content: (TextContent\|ImageContent)[]; details: TDetails; usage?; addedToolNames?; terminate? }`（错误应 throw，不含 `isError`） | `pi-agent-core/types.d.ts:316` |
| 流式 | `onUpdate?.({ content, details })` | `docs/extensions.md` registerTool 示例 |
| 运行时注册 | `pi.registerTool` 在加载期与运行期均可，立即生效 | `docs/extensions.md:1334` |
| 工具查询/开关 | `pi.getActiveTools(): string[]`、`pi.getAllTools(): ToolInfo[]`、`pi.setActiveTools(names)` | `types.d.ts:946-950` |
| 文件安全 | `withFileMutationQueue()` 与内置 edit/write 共享同文件队列 | `dist/index.d.ts` + `docs/extensions.md` |

### 2.4 Prompt / System Prompt

| 项 | 内容 | 证据 |
|---|---|---|
| `BeforeAgentStartEvent.prompt` | `string`，扩展后的原始用户 prompt | `types.d.ts:524` |
| `BeforeAgentStartEvent.systemPrompt` | `string`，链式系统提示（含更早 handler 的修改） | `types.d.ts:524` |
| `BeforeAgentStartEvent.systemPromptOptions` | `BuildSystemPromptOptions` | `types.d.ts:524` |
| `BuildSystemPromptOptions` 字段 | `customPrompt?; selectedTools?; toolSnippets?; promptGuidelines?; appendSystemPrompt?; cwd; contextFiles?; skills?` | `system-prompt.d.ts:5` |
| `BeforeAgentStartEventResult` | `{ message?; systemPrompt? }`（多扩展链式） | `types.d.ts:805` |
| `formatSkillsForPrompt(skills): string` | 按 Agent Skills 标准 XML；`disableModelInvocation=true` 排除 | `skills.d.ts:44` |
| `buildSystemPrompt(options): string` | 构建系统提示 | `system-prompt.d.ts:27` |
| `ctx.getSystemPrompt(): string` | 当前生效系统提示 | `types.d.ts:209`（ExtensionContext） |
| `ctx.getSystemPromptOptions()` | 仅 `ExtensionCommandContext`（命令 handler） | `types.d.ts:276` |

### 2.5 Skill（语义来源）

| 项 | 内容 | 证据 |
|---|---|---|
| `Skill` 字段 | `name; description; filePath; baseDir; sourceInfo: SourceInfo; disableModelInvocation` | `skills.d.ts:9` |
| `SourceInfo` 字段 | `path; source; scope: SourceScope; origin: SourceOrigin; baseDir?` | `source-info.d.ts:4` |
| `SourceScope` | `"user" \| "project" \| "temporary"` | `source-info.d.ts:2` |
| `SourceOrigin` | `"package" \| "top-level"` | `source-info.d.ts:3` |
| `loadSkills({cwd, agentDir, skillPaths, includeDefaults})` | 从全部配置位置加载 | `skills.d.ts` |
| `loadSkillsFromDir({dir, source})` | 从单目录加载（fixture 用） | `skills.d.ts:35` |
| `createSyntheticSourceInfo(path, opts)` | 构造合成 `SourceInfo` | `source-info.d.ts:12` |

> **明确缺失**：`Skill` 无 `skill_id`、无 `source_hash`、无 `scope` 顶层字段（scope 在 `sourceInfo.scope`）。与合同 §3 一致——二者必须由 adapter 派生。

### 2.6 Storage / 持久化

| 项 | 内容 | 证据 |
|---|---|---|
| `pi.appendEntry(customType, data?)` | 追加 `CustomEntry`（写会话 JSONL，**不进 LLM 上下文**） | `types.d.ts:936`、`session-manager.d.ts:73` |
| `pi.sendMessage(msg, opts?)` | 追加 `CustomMessageEntry`（进 LLM 上下文） | `types.d.ts:928` |
| `pi.setSessionName` / `getSessionName` / `setLabel` | 会话名/标签 | `types.d.ts` |
| `ctx.sessionManager` | `ReadonlySessionManager`（只读） | `types.d.ts:209` |
| `ReadonlySessionManager` 方法 | `getCwd/getSessionDir/getSessionId/getSessionFile/getLeafId/getLeafEntry/getEntry/getLabel/getBranch/buildContextEntries/getHeader/getEntries/getTree/getSessionName` | `session-manager.d.ts:149` |
| `SessionManager`（SDK 全量，含写） | `appendMessage/appendCustomEntry/appendCustomMessageEntry/appendCompaction/branch/...`；`SessionManager.inMemory()`（不落盘）、`create/continueRecent/list` | `session-manager.d.ts` |
| 会话文件 | JSONL，append-only 树，`CURRENT_SESSION_VERSION = 3` | `session-manager.d.ts:5` |

> **结论**：宿主无通用 KV/数据库/事务/secret-scan/retention/delete API。Practice Store 须由 adapter 在 project-local 自行持久化（Phase 2 用 project-local store abstraction/fixture，符合计划 §7 的 guard）。

### 2.7 Permission / Authorization

| 能力 | 机制 | 证据 |
|---|---|---|
| 工具级授权闸门 | `tool_call` 返回 `{ block: true, reason?, terminate? }` | `types.d.ts:778`；示例 `permission-gate.ts`、`protected-paths.ts` |
| 破坏性命令确认 | `tool_call` + `ctx.ui.confirm/select`（`!ctx.hasUI` 时默认 block） | `permission-gate.ts` |
| 会话动作取消 | `session_before_switch/fork/compact/tree` 返回 `{ cancel: true }` | `confirm-destructive.ts` |
| 项目信任 | `project_trust` 事件 + `ctx.isProjectTrusted()` | `types.d.ts:209`、`docs/security.md` |
| 交互审批 UI | `ctx.ui.select/confirm/input/notify` | `types.d.ts:50`（ExtensionUIContext） |
| bash 拦截 | `user_bash` 返回 `{ operations? / result? }` | `types.d.ts:615` |

> **注意**：宿主**没有**集中的 permission policy 引擎、无 per-path allow/deny 配置项、无自动 approval 流。授权策略须由 extension 自行实现；这正好满足本项目“独立 authorization gate 位于 procedure 之外”的要求——gate 即 `tool_call` 的 block 语义，快慢路径复用同一 hook。

### 2.8 Sandbox

| 项 | 结论 | 证据 |
|---|---|---|
| 内置 sandbox | **无**。扩展/工具以用户进程权限运行 | `docs/security.md`「No Built-in Sandbox」 |
| 隔离方式 | OS/容器/VM：整个 pi 进程入容器、Gondolin micro-VM、`@anthropic-ai/sandbox-runtime`（bubblewrap/sandbox-exec）替换 bash 工具 | `docs/security.md` + `examples/extensions/sandbox/index.ts` |
| 本项目的含义 | MVP 快路径只允许只读/幂等操作；真正授权与隔离不能靠宿主 sandbox | ADR-0008 |

### 2.9 SDK 程序化路径（project-local adapter 的替代/测试路径）

| 项 | 内容 | 证据 |
|---|---|---|
| `createAgentSession(options)` | 创建 `AgentSession` | `sdk.d.ts:105` |
| `CreateAgentSessionOptions` 字段 | `cwd?; agentDir?; modelRuntime?; model?; thinkingLevel?; scopedModels?; noTools?; tools?; excludeTools?; customTools?; resourceLoader?; sessionManager?; settingsManager?; sessionStartEvent?` | `sdk.d.ts:10` |
| `DefaultResourceLoader` | 构造入参 `{ cwd, agentDir, skillsOverride?, additionalExtensionPaths?, extensionFactories?, ... }` | `sdk.d.ts` + 示例 `06-extensions.ts`、`04-skills.ts` |
| `AgentSession` 关键方法 | `prompt(text, opts?)`、`subscribe(listener): unsubscribe`、`dispose()`、`getSystemPrompt()`、`setActiveTools()` | `agent-session.d.ts:192/276/283/294/311` |
| `SessionManager.inMemory()` | 纯内存、不落盘（fixture/测试用） | `session-manager.d.ts` |

---

## 3. 两个关键问题的结论

### 3.1 `before_agent_start` 能否取得当前用户任务 / TaskContext？

**能取得任务文本，但不存在名为 `TaskContext` 的对象。**

- `event.prompt` 是“扩展后的原始用户 prompt 文本”（`types.d.ts:524` 注释原文：`The raw user prompt text (after expansion)`）。这就是本项目 discovery 所需的**任务文本**。
- `event.systemPromptOptions.skills` 提供当前已发现的 `Skill[]`（`system-prompt.d.ts:5`，`skills?: Skill[]`）。
- 其余结构化事实：`event.images`、`event.systemPrompt`、`event.systemPromptOptions.cwd / contextFiles / selectedTools / ...`。
- **没有**更丰富的“TaskContext”类型（无 task id、无 intent、无实体抽取）。若未来需要任务级结构，只能从 `prompt` 字符串自行解析，或依赖 `ctx`（`cwd`、`sessionManager`、`model`）。

因此 ADR-0007 的“每次主 Agent 推理前由宿主自动检索候选”是可行的：在 `before_agent_start`（或更精细的 `context` 事件）里读取 `event.prompt`，检索后通过返回 `{ systemPrompt }`（或 `context` 返回 `{ messages }`）注入候选卡。这**不需要**篡改用户日常 Pi prompt 或写 `~/.pi`。

### 3.2 project-local adapter 能否无外部写入加载？

**能。** 加载机制（`loader.js:543` 起）：

1. project-local：`<cwd>/.pi/extensions/*.ts` 或 `*/index.ts`（`loader.js:557-559`）。
2. global：`<agentDir>/extensions/`（`~/.pi/agent/extensions`，本项目**不使用**）。
3. 显式路径：settings.json `extensions` 数组、CLI `-e/--extension`、`package.json` 的 `pi.extensions`（`loader.js` + `docs/extensions.md`）。
4. 加载器用 **jiti** 直接执行 `.ts`（无需编译步骤；`loader.d.ts` 头注释与 `docs/extensions.md:154` 均确认）。

结论与约束：

- 在本仓库 `D:\Users\a1324\Desktop\skill机制\.pi\extensions\` 放 TypeScript adapter 即会随 `pi` 启动自动加载，**不写 `C:\Users\a1324\.pi`、不写任何全局环境**。
- 约束 1：project-local 扩展属于“需要信任的资源”，**仅在项目被信任后加载**（`docs/security.md`「Project Trust」）。当前仓库无 `.pi` 目录，属 Phase 1 首次建立；首次运行时需用户信任一次（或 `defaultProjectTrust`/`-a`）。
- 约束 2：扩展以用户权限运行（无 sandbox）。
- 测试/回放路径：可用 `createAgentSession({ resourceLoader, sessionManager: SessionManager.inMemory() })` 完全进程内、不落盘地驱动 adapter（`06-extensions.ts`、`04-skills.ts`）。

---

## 4. 命令与结果（本次核验实际执行）

| 命令（Git Bash） | 结果 |
|---|---|
| `cat .../pi-coding-agent/package.json` | 版本 `0.84.1`、`types: dist/index.d.ts`、`piConfig.configDir: .pi` |
| `ls -la .../pi-coding-agent/{docs,examples,dist}` | docs 29 篇、examples/extensions 约 80 文件、examples/sdk 13 个 |
| `find .../dist/core/extensions -name '*.d.ts'` | 定位 `types.d.ts`、`loader.d.ts`、`runner.d.ts`、`wrapper.d.ts` |
| `read dist/index.d.ts` | 全部 re-export 清单 |
| `read dist/core/extensions/types.d.ts`（全量，1295 行） | 事件/工具/上下文类型全集 |
| `read dist/core/skills.d.ts`、`source-info.d.ts`、`system-prompt.d.ts`、`session-manager.d.ts`、`sdk.d.ts` | Skill/SourceInfo/BuildSystemPromptOptions/存储/SDK 形状 |
| `grep -n ... dist/core/extensions/loader.js` | 扩展发现位置与规则（`.pi/extensions`、jiti） |
| `read docs/security.md`、`docs/skills.md` | 无 sandbox 声明、Project Trust、Skill 位置/校验 |
| `read docs/extensions.md`（关键段：QuickStart/加载/事件/API/状态/工具） | 事件语义与 API 用法 |
| `read examples/extensions/{permission-gate,confirm-destructive,protected-paths,sandbox/index}.ts` | 授权/沙箱参考实现 |
| `read examples/sdk/{04-skills,06-extensions}.ts` | SDK 加载路径 |
| `cat C:\Users\a1324\.pi\agent\extensions\skill-router.ts`（只读） | 现有 `before_agent_start` + `systemPromptOptions.skills` + `defineTool` 用法佐证 |
| `grep -n ... pi-agent-core/dist/types.d.ts` + `read` | `AgentToolResult<T>` 精确字段 |

所有检查均为只读；未对 `C:\Users\a1324\.pi`、`.codex`、`.agents` 或任何全局环境写入、移动、删除或重命名。

---

## 5. Unavailable / Unverified APIs 与合法降级

| 能力 | 状态 | 证据/说明 | 合法降级 |
|---|---|---|---|
| 结构化 `TaskContext` 对象 | **Unavailable**（只有 `prompt: string` + `systemPromptOptions`） | `BeforeAgentStartEvent` 仅 4 字段 | 用 `event.prompt` 作文本；任务级结构自行解析或放弃 |
| 稳定 `skill_id` / `source_hash`（宿主提供） | **Unavailable** | `Skill` 无此字段（`skills.d.ts:9`） | adapter 自行派生（`skill_id = scope+path 指纹`，`source_hash` 由内容哈希计算） |
| Skill rename/move/卸载/依赖变更事件 | **Unavailable** | 无此类事件 | 每次 `before_agent_start`/`session_start` 重扫目录，按指纹 diff 判失效 |
| 通用 KV/事务/secret-scan/retention/delete API | **Unavailable** | 仅 `appendEntry` + 只读 `sessionManager` | Practice Store 用 project-local 文件/独立 store 抽象实现（Phase 2 fixture） |
| 内置 sandbox | **Unavailable** | `docs/security.md` 明示无 | OS/容器/VM；MVP 只允许只读/幂等操作 |
| 内置 permission policy 引擎 / 自动审批 | **Unavailable** | 无 policy 配置面 | `tool_call` 返回 `{ block }` 作统一授权 gate，复用快慢路径 |
| LLM 便捷调用 `ctx.callLLM` / `pi.complete` / `ctx.model.complete` | **Unavailable** | 三个名字在类型与文档中均无定义（`grep` 0 命中，见下） | 需 LLM 时用 `ModelRuntime` / `@earendil-works/pi-ai` 的 `Model.stream/streamSimple`（**本次未逐签名核验**，列为下条） |
| `ModelRuntime` / `ctx.model`（`Model<any>`）的精确调用签名 | **Unverified（本 pass 未展开）** | `ctx.model` 确为 `Model<any>`（`types.d.ts:209`），`ModelRuntime` 已导出（`index.d.ts`）；但其 `stream/complete` 具体方法未在本 pass 验证 | Phase 1 前如需 LLM verifier，再核验 `dist/core/model-runtime.d.ts` 与 `pi-ai` 类型；否则 verifier 用确定性规则/外部命令 |
| 宿主提供的事务/回滚 API | **Unavailable** | 无 | 回滚由 adapter 用不可变 append-only + 版本指针实现（合同 §6 状态机） |

**反模式核对（`rg`）**：`dist/core/extensions/types.d.ts` 与 `dist/index.d.ts` 中不存在 `callLLM`、`pi.complete`、`ctx.model.complete`、`registerLifecycleHook`、`getTaskContext` 等未验证名称。本清单不发明上述任何 API。

---

## 6. 限制与遗留

1. `AgentToolResult`/`AgentToolUpdateCallback`/`ToolExecutionMode` 定义在 `@earendil-works/pi-agent-core`（re-export），本 pass 已读其 `types.d.ts` 确认 `AgentToolResult` 字段，但未穷尽该包其余类型。
2. `ModelRuntime`/`ctx.model` 的 LLM 调用签名未展开核验（见 §5），MVP 第一阶段不依赖它（discovery 为纯本地 FTS，无 Router LLM）。
3. project-local 扩展的**首次信任交互**未实测（本 pass 只读，未启动真实 `pi` 进程），信任语义以 `docs/security.md` 文本为准。
4. `context` 事件“每次 LLM 调用前触发”的时序在并行工具模式下与 `tool_result` 的精确交错，以 `docs/extensions.md` 文本为准，未做运行观测。
5. 未验证项全部在 §5 显式隔离，不得被当作已完成能力进入 Phase 1。

---

## 7. 交接（按实施计划 §12 格式）

```text
Ownership:
  docs/research/2026-08-14-phase0-pi-api-inventory.md（本文件，唯一所有权）

Files changed:
  docs/research/2026-08-14-phase0-pi-api-inventory.md（新增）
  未改动任何其他仓库文件；未写入任何工作区外路径。

Docs/API sources followed:
  AGENTS.md、README.md、ADR-0006/0007/0008、
  docs/design/dual-memory-data-contracts.md、
  docs/plans/2026-08-14-dual-memory-implementation-plan.md（§3 全部）
  @earendil-works/pi-coding-agent@0.84.1 随包：
    dist/index.d.ts、dist/core/extensions/{types,loader}.d.ts(.js)、
    dist/core/{skills,source-info,system-prompt,session-manager,sdk}.d.ts、
    docs/{extensions,skills,security}.md、
    examples/extensions/{permission-gate,confirm-destructive,protected-paths,sandbox}、
    examples/sdk/{04-skills,06-extensions}.ts
  只读参考：C:\Users\a1324\.pi\agent\extensions\skill-router.ts（现有 pattern）

Commands run:
  cat / ls / find / grep / sed / read（对随包文件与只读用户扩展），详见 §4 表格。

Verification results:
  版本 0.84.1 确认；Allowed APIs 均有 dist/*.d.ts 或 docs 文件证据（含行号）；
  before_agent_start 可取得 prompt + systemPromptOptions.skills；
  project-local .pi/extensions 加载机制确认（jiti、无需编译、不写 ~/.pi）；
  tool_call/tool_result/context 等观察与注入 hook 确认；
  sandbox、permission 引擎、通用存储、skill_id、TaskContext 均为 Unavailable（已隔离）。

Known failures or unverified assumptions:
  ModelRuntime/ctx.model 的 LLM 调用签名未验证（Phase 1 不依赖）；
  project-local 首次信任交互未实测；
  context/tool_result 在并行工具下的精确时序未做运行观测。

Downstream work now unblocked:
  Phase 1（Registry + 静态 prompt 外 discovery）可据此在
  <repo>/.pi/extensions/ 建 adapter（或 SDK + inMemory 做 fixture）；
  skill_id/source_hash 派生、FTS/BM25 索引、候选卡注入点
  （before_agent_start 或 context）均已具备宿主证据。
```

---

### 附：证据速查（关键符号 → 文件:行）

| 符号 | 位置 |
|---|---|
| `ExtensionAPI` | `dist/core/extensions/types.d.ts:866` |
| `ExtensionContext` | `dist/core/extensions/types.d.ts:209` |
| `BeforeAgentStartEvent` / `BeforeAgentStartEventResult` | `types.d.ts:524` / `:805` |
| `ContextEvent` / `ContextEventResult` | `types.d.ts:499` / `:774` |
| `ToolDefinition` / `defineTool` | `types.d.ts:343` / `:385` |
| `ToolCallEvent` / `ToolCallEventResult` | `types.d.ts:648` / `:778` |
| `ToolResultEvent` / `ToolResultEventResult` | `types.d.ts:691` / `:795` |
| `InputEvent` / `InputEventResult` | `types.d.ts:627` / `:639` |
| `ExtensionEvent`（全集） | `types.d.ts:773` |
| `Skill` | `dist/core/skills.d.ts:9` |
| `SourceInfo` / `SourceScope` | `dist/core/source-info.d.ts:4` / `:2` |
| `BuildSystemPromptOptions` | `dist/core/system-prompt.d.ts:5` |
| `ReadonlySessionManager` | `dist/core/session-manager.d.ts:149` |
| `CreateAgentSessionOptions` / `createAgentSession` | `dist/core/sdk.d.ts:10` / `:105` |
| `AgentToolResult<T>` | `pi-agent-core/dist/types.d.ts:316` |
| 扩展发现位置 | `dist/core/extensions/loader.js:543-600` |
