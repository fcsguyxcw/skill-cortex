# Selection Gold Set — Dev v1

日期：2026-08-20  
状态：**已人工确认并冻结；仅作为 dev，不是 final benchmark**

本表是 Selection paired evaluation 的 14 条 dev 案例。Gold 由用户人工复核，不来自 retriever
或模型输出。第一轮复核要求处理 D03、D06、D10、D12；D12 替代案于用户指示继续后确认并冻结。

## Catalog snapshot

本轮 Gold 只相对于以下 catalog snapshot 成立：

- 宿主加载器：`@earendil-works/pi-coding-agent@0.84.1` 的 `DefaultResourceLoader`；
- 工作目录：本项目根目录；`disableModelInvocation=true` 的 Skill 排除；
- loader 发现 Skill：146 个；排除 `disableModelInvocation=true` 后模型可见 132 个；
- 快照时间：2026-08-20（Asia/Shanghai）；
- catalog hash：`sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7`；
- frozen Gold Set hash：`sha256:45af7f527178dd47903845984b64916a827e1cb6be747cec90cd87d614708966`。

实测 catalog 包含通用 `Code` 及多个 frontend/image 近邻 Skill，但不包含 `documents`。任何 Skill
增删、revision 或 description 改变都会产生新的 catalog hash，并使本 Gold Set 失效，必须重新人工复核。

### 预先标注规则

1. Gold 是完成任务所需的**最小充分 Skill 集合**；职责完全被更具体 Skill 覆盖的通用工作流 Skill 不重复加入。
2. 两个 Skill 都能独立完整完成同一任务时，它们是替代项，不得事后任选一个作为唯一 Gold；应改写或替换案例。
3. 普通 Markdown 文件交付不单独触发通用 `Code`；只有请求包含软件实现、修改、验证或测试时才考虑它。
4. Gold 只依据冻结 description 与人工判断；retriever 和模型输出不得反向修改标注。

### Gold Skill IDs

| Skill name | Frozen `skill_id` |
|---|---|
| `diagnosing-bugs` | `skill:2693c89e1de701aaad7cef99edaf14720ab58056b01d84b62bfc56c7d1d056d3` |
| `code-review` | `skill:8111be861f909a00f2b377c8e90aa1593b8c5d642a529b3013d815083455069b` |
| `security-auditor` | `skill:669a5a164b1141e9d42f7cf0974122b71ec705616bb9fe6a5dcd34956162130d` |
| `architecture-designer` | `skill:03165140889cff61f45938f8b8af2a38980514158712b650f541a1220edb0081` |
| `pdf` | `skill:a2fa83ab3477cd0caa895e6716cf5b5f6f0b35e7e3b64410b34898b823e79e36` |
| `docx` | `skill:5e74252c038faac5c3dd480de4980b90d786918b0b2c28685eb830209f553e04` |
| `xlsx` | `skill:b3859d361ba00ec5cb02ec0ef18e8356bbe4e5a8a6236b10b9ea13e9b5357af1` |
| `data-analysis` | `skill:f7ee3af6ab0ce0c5040bb9871fd4b4df370f4256d30f0c465992d3ae9ada0873` |
| `academic-paper-review` | `skill:681f792463fbcfbd0706f0ad9547329a308a0e741123efb5592b1e72e6197e5b` |
| `research` | `skill:0b0d687f5de892f5968ff0880190b74fcda0c8cb7d1868c5e7907e5ea20b0f71` |
| `youtube-watcher` | `skill:9e1c09c8d8cdf48d0ef490d25c50e69cfbbbc83e84d4fd02d749dd7f2a400f2b` |

| Case | Query | Draft gold Skill | 类型 | 语言 | 主要混淆项 | 标注理由 |
|---|---|---|---|---|---|---|
| D01 | 测试套件偶发超时，请先定位根因并给出证据，这轮不要改代码。 | `diagnosing-bugs` | single | zh | `code-review` | 目标是诊断已有故障，不是审查一组代码变更。 |
| D02 | Review this branch against the issue specification and repository standards. | `code-review` | single | en | `diagnosing-bugs`, `security-auditor` | 明确要求按 spec 与仓库规范审查分支。 |
| D03 | Can you go through our authentication middleware and check whether there are any security holes around cross-origin requests, request validation, or exposed secrets? Don't change anything yet—just report the risks. | `security-auditor` | single | en | `code-review` | 请求是专项安全审计；改写后不再机械枚举安全 Skill 关键词。 |
| D04 | 为一个可横向扩展的事件处理平台设计架构，并记录关键 ADR。 | `architecture-designer` | single | zh | `research` | 主要交付物是系统架构和决策，而不是资料调研。 |
| D05 | 对 contract-scan.pdf 做 OCR，并提取其中所有表格。 | `pdf` | single | zh | `docx`, `data-analysis` | 输入与主要操作均是 PDF/OCR。 |
| D06 | Turn these meeting notes into a polished Word report with headings, a table of contents, and page numbers. | `docx` | single | en | `pdf` | 冻结 catalog 不含 `documents`；`docx` description 明确覆盖 Word 报告、标题、目录和页码。 |
| D07 | 修复 sales.xlsx 中失效的公式，保持现有单元格格式，并输出修复后的工作簿。 | `xlsx` | single | zh | `data-analysis` | 主要输入输出均为 spreadsheet 文件。 |
| D08 | Analyze retention.csv, calculate cohort retention, and return only a Markdown findings summary—do not create a spreadsheet. | `data-analysis` | single | en | `xlsx` | 主要目标是分析，且明确不要 spreadsheet 成品。 |
| D09 | Critique the methodology, contribution, and threats to validity of this arXiv paper. | `academic-paper-review` | single | en | `research` | 对单篇论文进行结构化学术评审。 |
| D10 | 核验某 API 当前的官方行为，只使用一手资料，并给出带来源的 Markdown 结论。 | `research` | single | zh | `Code`, `academic-paper-review` | `research` 明确覆盖 API 一手资料与 Markdown 结论；没有软件实现任务，不加入通用 `Code`。 |
| D11 | Summarize this YouTube interview, then verify the speaker's three product claims against primary sources. | `youtube-watcher` + `research` | multi | en | 单独使用任一 Skill | 视频转录理解与外部事实核验是互补步骤。 |
| D12 | Extract the quarterly revenue tables from the attached annual-report PDF, calculate year-over-year growth, and return a Markdown analysis. | `pdf` + `data-analysis` | multi | en | 单独使用任一 Skill | `pdf` 负责表格提取，`data-analysis` 负责结构化计算与分析；替代了在实际 catalog 中存在多个等价 frontend/image Skill 的原案。 |
| D13 | 17 摄氏度等于多少华氏度？ | No-Skill | no-skill | zh | `data-analysis` | 简单换算不需要已安装 Skill。 |
| D14 | Explain the TCP three-way handshake in two short paragraphs. | No-Skill | no-skill | en | `research` | 常识性解释，不需要开展资料研究或生成专门产物。 |

## 冻结边界

本轮已按以下标准完成人工复核：

1. query 是否像真实用户表达，而不是复述 Skill description；
2. gold 是否完整且没有多选或漏选；
3. No-Skill 是否确实不需要当前 catalog 中任何 Skill；
4. 主要混淆项是否合理；
5. 是否需要删除、改写或新增案例。

本 dev 集可用于协议调试和失败分类；不得运行尚未建立的 final-heldout，也不得把本表数量或结果
包装成最终 benchmark。任何 query、Gold 或 catalog 改动都会产生新 hash，并要求重新人工复核。
