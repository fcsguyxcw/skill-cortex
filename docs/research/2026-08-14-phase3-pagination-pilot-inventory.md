# Phase 3：supabase-postgres-best-practices 试点来源只读核验清单

状态：Phase 3 试点来源核验（只读）— 2026-08-14
作者：Phase 3 来源核验 Agent
范围：只读核验已安装 Skill 的来源、版本、许可、依赖 fingerprint 输入与可编译/LLM hole 边界；不改动原 Skill、不复制其正文或示例、不 git commit。
对齐：ADR-0010（Phase 3 使用只读 SQL pagination 检测 pilot）；验收基准：路径与哈希完整、许可结论可追溯、边界满足只读/确定性/可回放、原 Skill 明确保持只读。

---

## 0. 结论摘要（TL;DR）

1. **身份与版本**：本地安装 `supabase-postgres-best-practices` 为 Agent Skills Open Standard（agentskills.io）格式；`SKILL.md` frontmatter 声明 `name`、`license: MIT`、`author: supabase`、`version: "1.1.0"`、`date: January 2026`。
2. **来源**：upstream 为 GitHub `supabase/agent-skills`（默认分支 `main`，创建 2026-01-16，`pushed_at` 2026-08-12）。README 明示遵循 Agent Skills Open Standard；supabase.com/blog 2026-01-21 发布公告可佐证来源组织。
3. **许可（可追溯）**：本地**无** `LICENSE`/`LICENSE.txt` 文件（已核查）；本地唯一许可声明是 `SKILL.md` frontmatter 的 `license: MIT`。upstream 仓库根 `LICENSE` 为 MIT（Copyright (c) 2026 Supabase），`CONTRIBUTING.md` 声明贡献按 MIT 许可；upstream SKILL.md frontmatter 同为 `license: MIT`。结论：**本地安装许可 = MIT（由 frontmatter 声明 + upstream 仓库 LICENSE 佐证）**；本地未捆绑许可文件副本，属于安装器打包取舍，不改变许可结论。
4. **pilot 范围（ADR-0010）**：只使用 `references\data-pagination.md` 条款；procedure 只做 **OFFSET pagination 静态检测**，输入 bounded SQL 字符串，输出结构化 findings 或显式 abstain；**禁止**执行 SQL、连接数据库、**改写查询**、修改原 Skill、把 procedure 当独立 Skill。advice、查询改写、性能论断、数据库特定语义与其余全部规则为 `llm_holes` 或 scope 外。
5. **依赖 fingerprint（最小化）**：只包含影响本 detector 的输入——本地 `SKILL.md`（父绑定）、`references\data-pagination.md`、detector schema/version、permission policy（含 ADR-0010 的 declared version / license identifier，作为 SKILL.md 绑定的组成部分）。**其余 30 个 reference 与 upstream main 变化不进入 fingerprint、不触发失效**（纯确定性 artifact 不因无关变化失效）。
6. **缺失引用状态**：本地 `SKILL.md` 引用的 `references\schema-partial-indexes.md` 与 `references\_sections.md` 本地不存在（upstream 有 `_sections.md`；`schema-partial-indexes.md` upstream main 亦无）。它们与本 detector 无关，**仅记录为慢路径风险**（慢路径读 SKILL.md 会引用缺失文件），**不是本 detector 的 runtime guard / fingerprint 输入**。
7. **原 Skill 只读，无需 fixture 副本**：本轮仅只读读取 + 计算哈希；ADR-0010 明确"不需要复制 Skill 正文或示例"，原 Skill 保持只读，不建立 project-local 副本。

---

## 1. 本地安装路径与全量 SHA-256（审计附录）

安装根：`C:\Users\a1324\.agents\skills\supabase-postgres-best-practices\`（35 个文件；4 个根文件 + 31 个 `references\*.md`）。

> 本附录为审计用途的完整快照。**仅 §3 列出的少量哈希进入依赖 fingerprint**；其余文件哈希仅供审计与差异追踪，不得作为 fingerprint 输入（见 §3.2）。

### 1.1 根文件

| 文件（相对安装根） | 字节 | SHA-256 |
|---|---|---|
| `SKILL.md` | 2577 | `8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830` |
| `README.md` | 3175 | `210d26cc0466a1bfb9ab95e57d7fe8a80644ef3fd860769bcb4ec9989a7d7a8f` |
| `AGENTS.md` | 2200 | `a6454b8bb3f791dba8aa620787a1be0a1ade537adac3f7a1f4d4ce58662971fa` |
| `CLAUDE.md` | 2200 | `a6454b8bb3f791dba8aa620787a1be0a1ade537adac3f7a1f4d4ce58662971fa` |

> 注：`AGENTS.md` 与 `CLAUDE.md` 字节数与哈希完全相同（本地安装为同一内容的双份导航文件）。

### 1.2 references（31 个规则文件）

| 文件（`references\` 下） | SHA-256 |
|---|---|
| `advanced-full-text-search.md` | `40c2606bbb4c4dce31308f201b24cc7f58c7df05b1d9c6856fe2b888d3b7cf28` |
| `advanced-jsonb-indexing.md` | `24cacf6a8bc35901dd566d24502ce8e57f810a5c196b897e61d52726e521d106` |
| `conn-idle-timeout.md` | `630588902c00fcec59a5988cc5d042f76dcf2c923a535abfd8c47dca205eaed5` |
| `conn-limits.md` | `11b2a67a7c7679cbbc5d807bbb17e69c98484a581d0c8b929c03408f412b81b2` |
| `conn-pooling.md` | `88cf086bf98ba865d2e9d0579974e1366b14157619d6a93e7da77be91084e4a5` |
| `conn-prepared-statements.md` | `174e9332fe3dda5c99b2b00159fb1915ae36c00bab3a7882c14e73e4344e946e` |
| `data-batch-inserts.md` | `531933b82d6a622d0fae29e0ea80be6fe5d78655adf2804c271ea84a1930de37` |
| `data-n-plus-one.md` | `21a44905e5b16a42741892ec34bb1bfef124d049b140a76934a9acd0f46f5fc2` |
| `data-pagination.md` | `73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa` |
| `data-upsert.md` | `2612af83b20a2701dde30ef1f8d7efd26b7e9eef84717226b8f038a2d2150ff7` |
| `lock-advisory.md` | `c88d259dbf81c3771438f59a165f7eab8acd09999dd370bdf807521c73f35aab` |
| `lock-deadlock-prevention.md` | `09aee46f51d7178c8e55fe056cd5a94a64ba2c122fe418e6900cd99f297b2347` |
| `lock-short-transactions.md` | `5aa7f61095916986d39644b446cdbcd2bacca7ef698a3bb50b3f82dd60207602` |
| `lock-skip-locked.md` | `6c45077f430f29cd9cd8f448c94d578e827e7bd023fcdaf717a756acb116fa4b` |
| `monitor-explain-analyze.md` | `4cb67ffbf8e57f2e5b380b0beb4242528b513723ce314a2c2ffcf083bd4203d7` |
| `monitor-pg-stat-statements.md` | `89dca99d4e894fcbdcac136be7ad9fbc03d1342904f065c1b198dc9cf495f098` |
| `monitor-vacuum-analyze.md` | `2892272011710eb49b3f185ec12f15ce9ce4c365792c672f6e2a9c90da426a1a` |
| `query-composite-indexes.md` | `73e42424e671f0266e74fdb220db3196790f69fb43e2b19c7b9483eb4971b554` |
| `query-covering-indexes.md` | `daf2a7f0477fb7357b62b5fb5b185b1995a77a186347e45cb780e25e7a7589b6` |
| `query-index-types.md` | `472a74f22c2df203bd0154999b3a5a0187cca2ab3d9a3978e305bb7c32f1a282` |
| `query-missing-indexes.md` | `91ad8b0ff4365704b4830a7f077c6f140f7140fd5d3ce5cd0b92b160cf9e25f1` |
| `query-partial-indexes.md` | `6448982bc8558c6555284958edc331b29239c6a0130e6b4501dd6d4da607a6dd` |
| `schema-constraints.md` | `90e8efda3e9e81095e642911ad4aae2809d160f29414338fa997253238f510f8` |
| `schema-data-types.md` | `e01b58c14c7f3f65d8ead580b9a4fcf70b83baaab0f9a5f83c569c9fd113e8c8` |
| `schema-foreign-key-indexes.md` | `7587713d12a65a212365459b3d39e4717d8a79e4073b10bd62f1054d8192c0dd` |
| `schema-lowercase-identifiers.md` | `4bc80f70865f2390872591f326c8a6be6456a0aeb5a7e5a2475d7cd9d43059ab` |
| `schema-partitioning.md` | `541e13fbeaf4bb1485c9059d4c9417dbdb766cf16f4237cd63a04ada7ec45b90` |
| `schema-primary-keys.md` | `3c8beabef82066f9a0838b926da0885117fd2d9a263aaf84cb5ca9e5f0d400e9` |
| `security-privileges.md` | `095909274a4fb43df785d7144cf674eeb40284d2d45628f14af4108737b93663` |
| `security-rls-basics.md` | `e04dd1a3a382aafdaaa73fe9f7976352acdde6e90c2a2470d281b94d4f44b096` |
| `security-rls-performance.md` | `ee62c6e34468df8673d625291c1fcd7fb87041f122325eba224fc492cfe01bb3` |

### 1.3 不存在文件（已核查，非本地安装内容）

| 相对安装根 | 状态 | 影响 |
|---|---|---|
| `LICENSE` / `LICENSE.txt` | 不存在 | 本地无捆绑许可文件；许可结论依赖 frontmatter + upstream（见 §2） |
| `references\_sections.md` | 不存在 | 被 `SKILL.md` 第 47 行引用；**慢路径风险**（与本 detector 无关） |
| `references\_template.md` | 不存在 | 仅 README 提到的贡献者模板，运行时无关 |
| `references\_contributing.md` | 不存在 | 仅 README 提到的贡献指南，运行时无关 |
| `references\schema-partial-indexes.md` | 不存在 | 被本地 `SKILL.md` 第 46 行引用；upstream main 亦无此文件（1.1.1 改引 `query-partial-indexes.md`）；**慢路径风险**（与本 detector 无关） |

---

## 2. 来源 / 版本 / 许可证据链

### 2.1 本地证据（只读读取）

| 项 | 值 | 证据位置 |
|---|---|---|
| name | `supabase-postgres-best-practices` | `SKILL.md` frontmatter |
| description | 短版（"Postgres performance optimization and best practices from Supabase. …"） | `SKILL.md` frontmatter |
| license 声明 | `MIT` | `SKILL.md` frontmatter `license:` 字段 |
| author / organization | `supabase` / `Supabase` | `SKILL.md` frontmatter `metadata` |
| version | `1.1.0` | `SKILL.md` frontmatter `metadata.version` |
| date | January 2026 | `SKILL.md` frontmatter `metadata.date` |
| 格式标准 | Agent Skills Open Standard（agentskills.io） | `README.md` 首段 |

### 2.2 upstream 证据（网络核验，2026-08-14）

| 项 | 值 | 证据 |
|---|---|---|
| 仓库 | `https://github.com/supabase/agent-skills` | GitHub API + 网页（含 skills 目录与 CONTRIBUTING） |
| 默认分支 | `main`；创建 2026-01-16；`pushed_at` 2026-08-12 | GitHub API `repos/supabase/agent-skills` |
| 仓库 LICENSE | MIT License，Copyright (c) 2026 Supabase | `raw.githubusercontent.com/supabase/agent-skills/main/LICENSE`（全文核验） |
| 贡献许可 | 贡献按 MIT | `CONTRIBUTING.md`（声明 "your contributions will be licensed under the MIT License"） |
| upstream SKILL.md | `license: MIT`、`metadata.version: "1.1.1"`、长版 description | raw 抓取 upstream main SKILL.md 全文 |
| 发布公告 | supabase.com/blog 2026-01-21 "Introducing: Postgres Best Practices" | 网络检索（来源组织佐证） |
| 其他安装途径 | `npx skills add supabase/agent-skills`（supabase.com/docs/guides/ai-tools/ai-skills） | 网络检索（说明本机为 skills CLI 安装形态之一，非独有结论） |

### 2.3 许可结论（可追溯）

- 本地无捆绑 LICENSE 文件，但存在两层可追溯声明：① 本地 `SKILL.md` frontmatter `license: MIT`；② upstream 仓库根 MIT LICENSE（2026 Supabase）+ CONTRIBUTING 贡献 MIT。
- 结论：**MIT**。本项目不复制原文（§5），detector 只做静态检测并输出结构化 finding；若未来 artifact 含原文片段须保留 MIT 声明（MVP 不出现）。
- 边界：local frontmatter 与 upstream LICENSE 指向一致（MIT），无冲突证据。

---

## 3. 依赖 fingerprint（最小化，仅影响本 detector 的输入）

按 ADR-0010 父绑定定义与数据合同 §4.5，本 detector 的 `dependencyFingerprint` **只包含**：

| 输入 | 说明 | 取值（2026-08-14 快照） |
|---|---|---|
| `sourceHash`（父 SKILL.md） | 父 Skill 清单绑定；SKILL.md 的 declared version 与 license identifier 是同一绑定的组成部分（version `1.1.0`、license `MIT`） | `8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830` |
| selected rule hash | `references\data-pagination.md`（本 detector 唯一条款来源；upstream 同名文件 2026-08-14 逐字节一致） | `73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa` |
| detector schema / version | detector 的输入/输出 schema（bounded SQL 输入、finding/abstain 结构化输出）与编译版本 | 由编译器任务冻结（本轮未接管实现） |
| permission policy | 本项目授权政策版本标识（`permissionPolicyHash`） | 由 policy/授权 Agent 提供（本轮未接管） |

### 3.1 明确不进入 fingerprint（防无关失效）

- **其余 30 个 `references\*.md`**：与本 detector 无依赖；其变化不触发本 procedure 失效（ADR-0008/数据合同："纯确定性 procedure 不得因为无关模型变更而失效"，同理适用于无关规则文件）。
- **upstream main 变化**：upstream `supabase/agent-skills` 的演进不直接进入 fingerprint；仅当它改变**上述四项输入之一**（如本地 SKILL.md 或 data-pagination.md 随重装更新）时才经本地哈希变化间接触发失效。
- **本地缺失引用（`schema-partial-indexes.md`、`_sections.md`）**：与本 detector 无关；**不构成 runtime guard，不进入 fingerprint**，仅记录为慢路径风险（§6.2）。
- `AGENTS.md`/`CLAUDE.md`/`README.md` 与其他文件：审计附录用途，不进入 fingerprint。

### 3.2 完整哈希清单的用途

§1 全量哈希是**审计快照**（可追溯性、差异追踪、验收核对），**不是 fingerprint**。fingerprint 仅 §3 四项。

---

## 4. 可编译边界（ADR-0010 procedure boundary）

### 4.1 可编译（唯一）

**OFFSET pagination 静态检测**：

- 输入：bounded SQL 字符串（由 evaluation fixture 提供，项目自有输入）。
- 处理：确定性、内存内（in-memory）静态检查，判定查询是否使用 OFFSET 分页（如 `LIMIT … OFFSET …` 子句）。
- 输出：结构化 findings（如 `{ queryId, usesOffset: boolean }` 及必要稳定字段）或**显式 abstain**。
- 可回放：同输入必同输出；无数据库、无网络、无外部副作用。
- 不包含：查询改写、性能论断、建议文本生成。

### 4.2 必须保留为 LLM hole 或 scope 外（不伪装成确定性步骤）

| 项 | 原因 |
|---|---|
| 查询改写（rewriting）、"更好的分页写法"建议生成 | ADR-0010 forbidden（rewriting a query）；改写给不出确定性验证 |
| 性能论断（cursor 更快等） | 静态检测不能证明运行时性能（ADR-0010 Consequences） |
| 数据库特定语义（索引、执行计划、RLS、连接池等） | 依赖运行时/领域知识 |
| 用户任务意图、表/列与业务模型映射 | 语义判断 |
| 其余全部规则条款（conn-*/schema-*/security-*/lock-*/monitor-*/advanced-* 及 data-* 其他文件） | 超出 pilot 范围 |
| 本地缺失文件（`schema-partial-indexes.md`、`_sections.md`）的**内容** | 本地无内容；慢路径引用缺失文件时只能由 LLM 按缺失状态处理（慢路径风险） |

### 4.3 结构性边界（数据合同 §4.5 对齐）

- `coveredSteps` 只覆盖 §4.1；每个 step 映射父条款（`data-pagination.md` 的 OFFSET 条款与 `SKILL.md` How to Use）。
- `forbiddenAutomationSteps`：SQL 执行、数据库连接、查询改写、原 Skill 修改、运维动作（见 §5）；不得出现在 artifact 可执行路径。
- `runtimeGuards`：输入 SQL 在 bounded 语法子集之外（unsupported syntax）、分类不确定、source/dependency mismatch → 停止快路径，回退父 Skill 慢路径或合法 abstain。**缺失文件引用不是本 detector 的 guard**。
- `llmHoles`：§4.2 各项；每 hole 有受限输入（结构化摘要，非自由文本注入）与结构化输出 schema。
- 权限集合为父 Skill 允许集合子集：本 Skill 无声明权限；artifact 不新增任何权限（内存内分析）。

---

## 5. 禁止动作（pilot 不越界）

1. 不得修改、移动、删除、重命名 `C:\Users\a1324\.agents\skills\supabase-postgres-best-practices\` 下任何文件（原 Skill 保持只读）。
2. **不需要** project-local fixture 副本（ADR-0010：不复制 Skill 正文或示例；不建立 docx 式 fixture）。
3. 不得执行 SQL、不得连接数据库、不得改写查询、不得生成"改写建议"文本。
4. 不得假设缺失文件（`schema-partial-indexes.md`、`_sections.md`）存在或从 upstream 静默补齐。
5. 不得把 detector 当作独立可发现 Skill；不得 git commit；不得修改本仓库其他文件。
6. 不生成任意自修改代码；artifact 为受限 detector（输入 schema + 确定性判定 + 结构化输出）。

## 6. 失效条件

### 6.1 触发失效（fingerprint 变化）

- 本地 `SKILL.md` 哈希变化（或 declared version / license 声明变化）。
- 本地 `references\data-pagination.md` 哈希变化。
- detector schema/version 变化（编译器发布新版本）。
- permission policy 版本变化（若影响输入白名单/授权判定）。
- 任一 runtime guard 匹配（输入超出 bounded 子集 / 分类不确定 / source 或 dependency mismatch）。

### 6.2 不触发失效（防无关失效）

- 其余 30 个 reference 文件变化。
- upstream `supabase/agent-skills` main 演进（除非改变 §6.1 四项输入之一）。
- 本地缺失引用（`schema-partial-indexes.md`、`_sections.md`）状态——仅**慢路径风险**：慢路径读 SKILL.md 引用缺失文件时回退 LLM 按缺失处理；不影响 detector 本身。

## 7. 未验证项（明确未验证，不表述为事实）

1. 本地 `1.1.0` 对应 upstream 哪个 commit/tag（upstream 有 v0.1.x tags；未逐 tag 抓取对比）——未验证。
2. 31 个规则文件中除 `data-pagination.md` 与 `SKILL.md` 外的其余 30 个规则文件，未逐份与 upstream main 内容对比（仅目录存在性与名称核对；本地 `data-pagination.md` 与 upstream 逐字节一致已核验）——未验证（不影响 pilot：它们不进入 fingerprint）。
3. upstream `references\` 精确文件数（API 列表 42KB 截断，query/schema 系列计数未完全确证；不影响本地 inventory 完整性）——未验证。
4. 本机安装方式（skills CLI / 手动复制 / 其他）——仅据目录形态与 README 推断，未发现安装器记录——未验证。
5. `AGENTS.md` 与 `CLAUDE.md` 完全相同（同哈希）——已核验事实，但该行为是否 upstream 如此（upstream 为 npm 构建产物）未对比——未验证。
6. upstream `_sections.md` 内容（本地缺失；upstream 存在）未抓取（超出本 pilot 只读核验范围）——未验证。
7. detector 实现（输入 schema、finding 结构、abstain 规则、语法子集）**未实现**，本 inventory 只冻结来源与边界；具体 schema/version 由编译器任务随后冻结并纳入 fingerprint——未验证。

---

## 附：核验动作清单（本次执行）

- 只读：`find`/`ls`/`sha256sum`/`grep`/`read` 本地安装根全部 35 文件；无任何写入。
- 网络（只读）：GitHub raw 抓取 upstream `LICENSE`、`SKILL.md`（main）、`references/data-pagination.md`；GitHub API 抓取 `contents/skills/.../references`、`repos/supabase/agent-skills`、`tags`。
- 检索（只读）：supabase/agent-skills 仓库、supabase.com 发布公告、agentskills.io 标准说明。
- 写文件：仅本 inventory（`docs/research/2026-08-14-phase3-pagination-pilot-inventory.md`）。
