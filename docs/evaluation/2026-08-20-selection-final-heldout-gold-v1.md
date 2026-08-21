# Selection Final-Heldout Gold Set v1 — 冻结版

日期：2026-08-20  
状态：**Gold、阈值与运行配置已冻结；final-heldout 已于 2026-08-20 首次揭示，现为 revealed regression set**

本文件不是 Selection 模型、retriever 或正式 benchmark run 的输出。候选 cases / Gold 由开发辅助模型
协助拟定，最终 Gold 已由用户依据冻结 catalog 的真实 Skill description 完成人工复核确认。
本集合创建于 dev paired evaluation 之后，并在首次 final-heldout evaluation 前完成冻结。
首次揭示结果见 `docs/reports/2026-08-20-selection-final-heldout-v1-report.json`；不得根据该结果
反向修改 query、Gold、阈值或运行配置，后续只能作为 revealed regression set 使用。

## Catalog binding

- 宿主加载器：`@earendil-works/pi-coding-agent@0.84.1` 的 `DefaultResourceLoader`；
- 工作目录：本项目根目录；`disableModelInvocation=true` 的 Skill 排除；
- loader 发现 Skill：146 个；模型可见并由 project `buildSkillRecord` 摄入：132 个；
- catalog hash：`sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7`；
- 机器可读 manifest：`2026-08-20-selection-catalog-manifest.json`，包含 132 条
  `skillId / name / skillRevision / descriptionHash`，不保存 description 或 source path；
- manifest entries hash：`sha256:b8a1d83ef9c089434788d6ce633454fb5698f3452fc7009966613958ed6e8e16`；
- 可重建 evaluation catalog snapshot：`2026-08-20-selection-catalog-snapshot.json`，包含 132 条
  `skillId / name / skillRevision / description`，不保存 source path 或 Skill 正文；
- snapshot entries hash：`sha256:e895d606e1a4b104987246a81fde19d5d93648232910795c0dc408556af5c4a1`；
- 机器 cases：`src/evaluation/selection/final-heldout-cases.ts`；
- Gold Set hash：`sha256:15a19f154ee904cb624cb3e680c67de173695a11391f2a853795f692a5df4843`；
- threshold config hash：`sha256:df11ad053b95508b265ec48966525b0bfb20933b74f84cd7565644ece0d0fb0d`；
- EvaluationRunConfig hash：`sha256:30dbdaa057ba98c2fdbb622108e0d16a1fce1c8ba5ba8af53360768550e3ab7b`。

任一 Skill 增删、revision、name 或 description 改变，或任何运行配置 hash 漂移，都必须在首次 provider
调用前 fail closed；不得静默沿用本次冻结身份。

## 评审配额

| 类型 | ACCEPT | 英文 | 中文 | hard-confuser 标记 |
|---|---:|---:|---:|---:|
| single | 15 | 8 | 7 | 13 |
| multi | 5 | 2 | 3 | 4 |
| no-skill | 10 | 5 | 5 | 4 |
| **合计** | **30** | **15** | **15** | **21** |

注：六条 REJECT（S01、S09、T01、M01、M02、M08）不计入上述 ACCEPT 配额；若按全部候选计算，语言总数为英文 18、中文 18。
`H` 表示 hard-confuser；它只表示需要重点人工复核，不表示自动改变 Gold。

## ACCEPT：single（15）

| ID | 语言 | H | Query | Gold Skill | 主要混淆项 | 唯一性风险 |
|---|---|---|---|---|---|---|
| S02 | en | H | Rotate the scanned invoice PDF 90 degrees counter-clockwise, add an INTERNAL watermark, and return the new PDF. | `pdf` | `mineru`, `docx` | 低：PDF 变换/水印是 `pdf` 专项，不是 extraction。 |
| S03 | en | H | Repair the broken named ranges in budget.xlsm while preserving formulas and cell formatting, then return the workbook. | `xlsx` | `data-analysis` | 低：明确 workbook repair 与 workbook 交付。 |
| S04 | en | H | Audit the HMAC verification in our payment webhook for replay, timing, and signature-bypass risks; do not modify code. | `security-auditor` | `code-review`, `clawdefender` | 中低：专项漏洞审计，不是一般 review 或输入 sanitizer。 |
| S05 | en | H | Write a structured peer review of the uploaded paper, focusing on experiment controls, reproducibility, and reviewer questions. | `academic-paper-review` | `research`, `research-paper-writer` | 中：单篇论文评审边界清楚，仍需核对泛化描述。 |
| S06 | en | H | Stress-test this trading strategy backtest for overfitting, slippage assumptions, and parameter robustness; do not tune it. | `backtest-expert` | `data-analysis`, `research`, `Code` | 低：description 专门覆盖回测稳健性。 |
| S07 | en | H | Create a Vercel preview deployment for this Next.js app and return the claimable URL. | `vercel-deploy` | `frontend-design`, `Code` | 低：明确 deployment action。 |
| S08 | en |  | Turn this 90-second product script into a natural voiceover and export an audio file. | `tts` | `podcast-generation`, `audio-transcriber` | 低：voiceover/TTS，不是转录或播客双主持。 |
| T02 | zh | H | 在这份 `.docx` 合同中批量替换公司名称，保留修订记录和批注，输出新的 Word 文件。 | `docx` | `pdf`；`documents`（不在 Pi catalog） | 低：Word tracked changes/comments 明确。 |
| T03 | zh | H | 请把这组月度风速数据做成一个极坐标面积图图片，不做统计解释。 | `chart-visualization` | `data-analysis` | 中：明确只产图，不做统计分析。 |
| T04 | zh | H | 为多区域通知系统比较事件驱动和队列驱动方案，并记录最终取舍的 ADR。 | `architecture-designer` | `domain-modeling`, `codebase-design`, `research` | 中：架构方案与 ADR 清楚，但有设计近邻。 |
| T05 | zh | H | 围绕“可解释推荐”检索并综合 20 篇论文，给出检索式、纳排标准和跨论文主题。 | `systematic-literature-review` | `research`, `academic-paper-review`, `research-paper-writer` | 中低：多论文系统综述，不是单篇 review 或写论文。 |
| T06 | zh | H | 用 AMiner 查询一位学者的论文、机构、专利和引用关系，整理成结构化结果。 | `aminer-data-search` | `research`, `github-repo-search` | 低：显式 AMiner provider。 |
| T07 | zh |  | 根据我附上的这一周训练、饮食和睡眠记录，做一次健身周复盘并给出下周计划。 | `fitness-coach` | `Memory`, `data-analysis` | 低：输入已明确附带，不依赖历史 Memory；专项 fitness workflow。 |
| T08 | zh | H | 查找北京大学附近适合步行到达的咖啡店，按距离和评分排序并规划路线。 | `amap-lbs-skill` | `autoglm-browser-agent`, `research` | 中低：POI/路径规划是 amap 专项。 |
| T09 | en | H | Make the Feishu document visible only to project members and report current collaborator permissions. | `feishu-perm` | `feishu-doc`, `feishu-send-file` | 低：权限管理专项。 |

## ACCEPT：multi（5）

| ID | 语言 | H | Query | Gold Skill | 主要混淆项 | 唯一性风险 |
|---|---|---|---|---|---|---|
| M03 | en | H | From the TSV of service latencies, compute p95 latency per service and render a bar-chart image; return the chart plus a short findings note. | `data-analysis` + `chart-visualization` | `xlsx` | 低：`data-analysis` 声明 percentile/结构化计算但不生成图；`chart-visualization` 生成图但不承担 TSV 统计计算。 |
| M05 | en | H | Create a ubiquitous-language glossary and bounded-context map for a multi-tenant billing domain, then design service ownership and failure isolation and record those architectural trade-offs in an ADR. | `architecture-designer` + `domain-modeling` | `codebase-design`, `research` | 中低：domain glossary/context map 与 distributed-system architecture/ADR 是两个明确交付物。 |
| M04 | zh | H | 查阅某开源库的官方迁移指南，核对仓库当前调用点，整理带链接的 API 变更说明并写入仓库 Markdown。 | `research` + `code-documentation` | `github-deep-research`, `Code` | 中低：`research` 明确负责一手资料核验；`code-documentation` 明确负责代码库分析与仓库文档；`Code` 只声明代码实现工作流，query 不要求实现或修改代码。 |
| M06 | zh | H | 从宣传视频抽取一帧作为参考，生成一张保持其配色和构图节奏的活动海报。 | `video-frames` + `image-generation` | `video-generation`, `imagegen-frontend-web`, `FFmpeg Video Editor` | 中：frame extraction 与 image generation 互补。 |
| M07 | zh |  | 根据这段 30 秒中文产品文案交付两个独立文件：一份可单独使用的 WAV 旁白，以及一段表达相同内容的无声竖屏宣传视频。 | `tts` + `video-generation` | `podcast-generation`, `image-generation` | 低：独立 WAV 需要 TTS；独立无声视频需要 video generation，任一 Skill 都不能单独完成两个交付物。 |

## ACCEPT：no-skill（10）

| ID | 语言 | H | Query | Gold | 主要混淆项 | 唯一性风险 |
|---|---|---|---|---|---|---|
| N01 | en |  | What is 17 squared? | `[]` | `data-analysis` | 低：基础算术。 |
| N02 | zh |  | 3.6 公斤等于多少克？ | `[]` | `data-analysis` | 低：单位换算。 |
| N03 | en |  | In two sentences, why do seasons change on Earth? | `[]` | `research` | 低：常识解释，不要求外部资料。 |
| N04 | zh |  | 从 14、9、21、6 中找出最小值。 | `[]` | `data-analysis` | 低：简单比较。 |
| N05 | en | H | What does “PDF” stand for? | `[]` | `pdf`, `mineru` | 中：只问缩写含义，不进行 PDF 操作。 |
| N06 | zh | H | “API”这三个字母通常代表什么？ | `[]` | `research`, `code-documentation` | 中：常识定义，不要求检索或文档产物。 |
| N07 | en |  | Is 0.125 equal to 1/8? | `[]` | `data-analysis` | 低：基础数值判断。 |
| N08 | zh |  | 请列出星期一到星期日的英文名称。 | `[]` | `ielts`, `research` | 低：基础词汇，不是备考或研究任务。 |
| N09 | en | H | In one sentence, what is a spreadsheet? | `[]` | `xlsx`, `data-analysis` | 中：概念解释，不触碰文件或分析。 |
| N10 | zh | H | 日常说法里，“网页”和“网站”有什么区别？ | `[]` | `frontend-design`, `ui-ux-pro-max`, `web-design-guidelines` | 中：术语常识，不要求设计、代码或审查。 |

## 未纳入及原因（REJECT）

| ID | 语言 | Query | 原拟 Gold | 冲突 Skill | Reject 原因 |
|---|---|---|---|---|---|
| S01 | en | Transcribe the attached 12-minute WAV interview verbatim and return a plain-text transcript; no summary. | `audio-transcriber` | `openai-whisper`, `video-to-subtitle-summary` | `audio-transcriber` 与 `openai-whisper` 都是 speech-to-text，无法形成唯一 exact-set Gold。 |
| S09 | en | Fetch the transcript of this YouTube lecture and list the timestamps where the speaker defines each term. | `youtube-watcher` | `video-to-subtitle-summary` | 两者真实 description 都覆盖 YouTube transcript/subtitle extraction；后者虽偏摘要工作流，但仍能提供完成 timestamp 分析所需的字幕，无法形成唯一 exact-set Gold。 |
| T01 | zh | 从 MP4 里提取 00:12、01:30 和最后一帧，分别输出 PNG。 | `video-frames` | `FFmpeg Video Editor` | `FFmpeg Video Editor` 正文明示 `Extract Screenshot/Frame` 并给出按时间戳截图命令，与专用 `video-frames` 都是充分能力；“更具体”不能建立唯一 Gold。 |
| M01 | en | Convert every table in the attached invoice PDF into a formatted XLSX workbook, one worksheet per table. | `pdf` + `xlsx` | `mineru` + `xlsx` | `pdf` 与 `mineru` 的真实 description 都明确覆盖 PDF 表格抽取，存在两套同样充分的组合，无法形成唯一 exact-set Gold。 |
| M02 | zh | 把访谈录音转成文字，再改写成两位主持人的播客脚本，包含片头和片尾。 | `audio-transcriber` + `podcast-generation` | `openai-whisper`, `tts`, `video-to-subtitle-summary` | transcription 子任务存在等价 Skill；不能把其中一个事后指定为唯一 Gold。 |
| M08 | zh | 为隐私产品做一个生产级 landing page，并生成与视觉系统一致的原创 hero 插图。 | `frontend-design` + `image-generation` | `design-taste-frontend`, `image-to-code`, `imagegen-frontend-web`, `ui-ux-pro-max` | 当前 catalog 有多组职责重叠的 frontend/image 专项，Gold 不唯一；不强行标注。 |

## 冻结前检查

人工确认必须逐条回答：

1. query 是否像真实请求，而不是照抄 Skill description；
2. Gold 是否为完成任务所需的最小充分集合；
3. 主要混淆项是否确实可见且职责相邻；
4. No-Skill 是否不需要当前 catalog 中任何 Skill；
5. catalog hash 是否仍为本文顶部值。

30 条 ACCEPT 已序列化为机器可读 cases，并通过 `computeGoldSetHash(catalogHash, cases)` 冻结。
首次 final-heldout evaluation 运行后，v1 的 case、query、
Gold、配额与阈值均不可因结果好坏而修改；如需修改，必须建立 v2，并保留 v1 cases、Gold、协议与原始报告。
当前文件不构成 host integration、模型评测或 benchmark 结果。

首次 v1 final-heldout evaluation 的任何 case-level 或 aggregate 结果一旦被开发者查看，v1 即视为已揭示测试集。
此后不得根据 v1 的 retrieval miss、Selection error、分数或其他结果修改 retriever、模型提示、routing logic、
Top-K、alias、fallback 或其他被测系统行为后，再将 v1 的重跑结果作为独立 held-out 证据。若系统因 v1 结果
发生针对性修改，后续独立最终评测必须使用此前未运行、未用于调参的新 held-out 版本；v1 重跑只能标注为
revealed-set regression，不得替代新的独立 held-out。

## 报告口径

本集合是 hard-confuser-heavy 的 held-out challenge set，不代表真实用户任务分布。当前 30 条 ACCEPT 中，
no-skill 为 10/30（33.33%），hard-confuser 为 21/30（70.00%）。正式报告必须同时列出：

- single exact-set；
- multi exact-set；
- no-skill accuracy；
- hard-confuser exact-set；
- 中文 / 英文分栏；
- overall exact-set（仅作附带指标）。

不得将本集合的 overall accuracy 表述为“真实任务准确率”。
