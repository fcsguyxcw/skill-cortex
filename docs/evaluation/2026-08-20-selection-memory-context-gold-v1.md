# Selection Memory-as-Context Gold Set v1

日期：2026-08-20  
状态：**FROZEN — 用户已确认；未运行 retriever 或模型**

## 1. Evidence boundary

- 本数据只用于 ADR-0013 的 evaluation-only 实验。
- Gold 由任务意图与冻结 catalog 人工拟定，不来自 BM25、Query Expansion、Memory 或模型输出。
- 没有修改或复用 Selection final-heldout、Activation Memory held-out、Query Expansion evaluation query。
- Layer A 的冻结 5-candidate bundle 保证包含 Gold Skill，但 Gold label、Gold metadata 和答案标记绝不暴露给模型；Layer B 只在冻结的 19-Skill 实验 catalog 内运行 BM25+QE Top-5，不补 Gold。
- Layer A 与 Layer B 的指标分别报告和解释，不合并成一个 accuracy。
- 完整 132-Skill catalog 存在职责重叠的替代 Skill；本实验不声称 Gold 对完整 runtime catalog 唯一，也不声称 Layer B 是完整 runtime E2E。
- held-out 已随 Gold v1 冻结；在 calibration 过门前不得调用模型运行 held-out。

## 2. Snapshot bindings

| Artifact | Frozen binding |
| --- | --- |
| Catalog | `sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7` |
| Controlled experiment catalog (19 Skill candidate union) | `sha256:17307bc426e4ea973412cc706c25bf31b2fd4156a186a8fac077e6b0b6e06b8e` |
| Controlled evidence | `sha256:c8a4c79c457f078331644faf8e04d8415edd710219dd8f889229d9ee7c005ba1` |
| Calibration cases/Gold/candidate order | `sha256:24bcd9b94030b249e2a3bdfb15e7a481510878dd81ccbdaefdaab13f55d439bf` |
| Held-out cases/Gold/candidate order | `sha256:b93564482ce4c5bdfc3f30e6b56489ace33628fb0ae9dabc491d4836d80d19ac` |
| Combined case set | `sha256:0e039538c41504b335586e3005831d22449d786479f1e9086abdac78eda55bdf` |
| Final freeze identity | `sha256:a974be7239f486eeb71f4f47d021c16731ba5da1fe1bc19877a68e1ccba2787f` |

上述 freeze identity 绑定父 catalog、19-Skill 实验 catalog、evidence、calibration、held-out、combined
case set 与 protocol version。后续修改任何 query、Gold、candidate order、hard-confuser、evidence、
catalog membership 或绑定 revision 都会使 v1 失效，必须生成新版本和新 hash，不得原地重解释。

Controlled evidence 共 48 条。每个目标 Skill 固定为 2 条 positive、1 条 near-miss、2 条 boundary
和 1 条 environment。`near-miss + boundary = avoidWhen`，所以 `structured_memory` arm（S2）每卡正好
有 3 条 `avoidWhen`。environment 是独立的适用前提，渲染到 `environmentRequirements`，不是 negative
evidence，也不占 `avoidWhen=3` 的预算。

## 3. Target legend

| Short | Skill | Role in this experiment |
| --- | --- | --- |
| A | `architecture-designer` | 系统级架构、边界与技术取舍 |
| L | `systematic-literature-review` | 多论文、可复现筛选与证据综合 |
| S | `security-auditor` | 现有实现的专项安全审计 |
| C | `chart-visualization` | 指定图表图片，不负责统计分析 |
| D | `code-documentation` | 从代码形成开发者文档 |
| R | `research` | 用一手资料核验当前外部事实 |
| V | `video-frames` | 从视频提取帧或短片段 |
| I | `image-generation` | 生成新的视觉内容 |

### 3.1 Frozen catalog contracts

以下 description 逐字来自绑定的父 catalog snapshot；判定边界同时对照了同 revision 的只读 Skill
package。实验 outcome universe 是所有 candidate bundle 的 19-Skill 并集，不是完整 132-Skill catalog。

| Short | Frozen description | Use / avoid boundary used for Gold |
| --- | --- | --- |
| A | Use when designing new system architecture, reviewing existing designs, or making architectural decisions. Invoke for system design, architecture review, design patterns, ADRs, scalability planning. | 用于系统级设计、架构复核和 ADR；考虑安全不等于检查现有代码中的可利用缺陷。 |
| L | Use this skill when the user wants a systematic literature review, survey, or synthesis across multiple academic papers on a topic. Also covers annotated bibliographies and cross-paper comparisons. Searches arXiv and outputs reports in APA, IEEE, or BibTeX format. Not for single-paper tasks — use academic-paper-review for reviewing one paper. | 用于多篇学术论文的检索、筛选和跨论文比较；不用于单篇评审、普通事实问答或一般网页调查。 |
| S | Use when reviewing code for security vulnerabilities, implementing authentication flows, auditing OWASP Top 10, configuring CORS/CSP headers, handling secrets, input validation, SQL injection prevention, XSS protection, or any security-related code review. | 用于安全相关实现或代码风险检查；纯概念解释且没有实现/配置对象时为 No-Skill。 |
| C | This skill should be used when the user wants to visualize data. It intelligently selects the most suitable chart type from 26 available options, extracts parameters based on detailed specifications, and generates a chart image using a JavaScript script. | 用于把已有数据变成图形图片；不承担外部事实搜集、统计推断或纯概念解释。 |
| D | Use this skill when the user requests to generate, create, or improve documentation for code, APIs, libraries, repositories, or software projects. Supports README generation, API reference documentation, inline code comments, architecture documentation, changelog generation, and developer guides. Trigger on requests like "document this code", "create a README", "generate API docs", "write developer guide", or when analyzing codebases for documentation purposes. | 用于面向代码/仓库的文档产物；不替代外部当前事实核验，也不负责实现功能。 |
| R | Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent. | 用于一手来源核验并形成 Markdown findings；不替代代码专属文档，也不替代带筛选协议的学术多论文综述。 |
| V | Extract frames or short clips from videos using ffmpeg. | 只用于真实视频帧/短片段操作；不用于帧率算术、视频概念或内容总结。 |
| I | Use this skill when the user requests to generate, create, imagine, or visualize images including characters, scenes, products, or any visual content. Supports structured prompts and reference images for guided generation. | 用于生成新的视觉内容；不用于视觉概念问答，也不替代视频取帧或数据图表。 |

### 3.2 Exact-set annotation rule

Gold 是**相对于冻结 19-Skill 实验 catalog 的最小充分专用 Skill exact set**：

- 一个专用 Skill 已完整覆盖任务时，不因为通用 `Code`、通用 FFmpeg 编辑或宽泛 research 能力存在就加 Gold；
- multi-skill 只在每项承担另一项合同不覆盖的独立动作或产物时成立；
- `research` 自带仓库 Markdown 输出，因此“带来源的 Markdown”本身不足以额外标 D；只有需要基于仓库代码形成 API/迁移/开发者文档时才加 D；
- A 的安全考虑不等于 S 的现有代码风险检查；只有 query 同时要求架构决策和代码级风险检查时标 A+S；
- No-Skill 允许出现相关术语，但不得要求执行合同中的 artifact/action。

Calibration multi exact-set 已逐条检查；SMC17 已明确加入“现有消息路由代码”对象，使 S 不能被 A 的
一般安全考虑覆盖。新 held-out 的 6 个 multi 组合与 calibration 全部不同，详见 §5 标注理由。

## 4. Calibration draft — 30 cases

配额：single/multi/no-skill=`12/6/12`；zh/en=`15/15`；hard-confuser=`22`。

| ID | Lang | Type | Query | Gold | Hard | 标注理由 |
| --- | --- | --- | --- | --- | --- | --- |
| SMC01 | zh | single | 请为机场行李追踪平台选择跨区域消息传播、故障域和恢复策略，并形成架构取舍记录。 | A | Y | 系统拓扑与取舍记录 |
| SMC02 | en | single | Choose a resilient topology for a fleet-telemetry control plane and capture why its service boundaries were selected. | A | Y | 服务边界与架构理由 |
| SMC03 | zh | single | 围绕低资源语音识别的群体偏差，跨多个论文数据库制定筛选流程并综合研究证据。 | L | Y | 多库筛选与跨论文综合 |
| SMC04 | en | single | Collect papers on compiler-generated tests through a reproducible database search, apply eligibility rules, and report themes recurring across the included papers. | L | Y | 用操作描述多论文筛选与综合，不直送 Skill 标签 |
| SMC05 | zh | single | 我们准备上线一个 GraphQL 管理接口，想确认不同租户是否可能看到彼此的数据，并整理上线前需要处理的风险。 | S | Y | 上线前实现风险检查，不靠安全术语直送 |
| SMC06 | en | single | Before shipping signed download links, determine whether a reused link or mismatched key could expose another user's file; list launch risks without changing code. | S | Y | 具体攻击后果，不出现 audit/vulnerability |
| SMC07 | zh | single | 把不同传感器的漂移分布排成多条重叠曲线并导出 PNG，只交付图形，不解释数据。 | C | Y | 描述视觉产物，不直接说图表类型 |
| SMC08 | en | single | Turn the supplied dependency counts into a circular node-and-ribbon graphic; return only the image. | C | Y | 描述视觉编码与图片产物 |
| SMC09 | zh | single | 新同事看不懂事件订阅接口。请根据仓库代码整理一页参数、回调示例和兼容性约束，供接入者使用。 | D | Y | 开发者产物意图，不直接说 documentation |
| SMC10 | en | single | Clients may no longer need the legacy header. Check the standards body's current pages and give a linked answer we can rely on. | R | Y | 当前外部事实与来源要求 |
| SMC11 | zh | single | 从上传的赛事录像中导出 00:47 与 04:12 两个时间点的静态画面，并分别保存为 PNG。 | V | N | 明确帧提取操作 |
| SMC12 | en | single | Generate an original linocut-style illustration of an orbital greenhouse at night. | I | N | 原创图片生成 |
| SMC13 | zh | multi | 查阅支付平台官方版本说明确认新签名字段的现行语义，再结合仓库调用代码写一份带引用的开发者迁移页。 | R+D | Y | R 只核验外部事实；D 才形成面向代码的迁移产物，单项不足 |
| SMC14 | en | multi | Search and screen papers on autonomous debugging, code each included paper's publication-bias value, and turn those values into a funnel-shaped image. | L+C | Y | L 不生成指定图形；C 不执行论文筛选与跨文献归纳，单项不足 |
| SMC15 | zh | multi | 截取宣传片 01:05 的人物剪影作为构图参考，并生成一张全新的爵士音乐节海报。 | V+I | Y | V 只提供参考帧；I 不负责从视频取帧，单项不足 |
| SMC16 | en | multi | Before shipping the client SDK, find whether its token storage could expose credentials or cross account boundaries, then create an integration page listing methods and safe constraints. | S+D | Y | S 产出风险发现；D 产出开发者接口说明，单项不足 |
| SMC17 | zh | multi | 为机密任务调度平台设计新的隔离架构和信任边界；同时检查现有消息路由代码是否可能把任务发到错误租户。交付 ADR 与代码风险清单。 | A+S | Y | A 负责新架构与 ADR；S 检查现有路由代码风险，单项不足 |
| SMC18 | en | multi | The official standard may have changed its reporting requirement. Resolve the current rule, then use a predefined search and eligibility process to compare papers that applied it. | R+L | Y | R 核验当前规则；L 执行多论文筛选比较，单项不足 |
| SMC19 | zh | no-skill | 为什么 OAuth 通常让客户端交换授权码，而不是把用户密码交给每个客户端？ | — | Y | 安全概念解释，无实现审计 |
| SMC20 | zh | no-skill | 什么时候折线形式比饼状形式更适合表达随时间发生的变化？ | — | Y | 可视化概念判断，无图形产物 |
| SMC21 | zh | no-skill | 一段两分钟的视频等于多少秒？ | — | Y | 简单时间换算 |
| SMC22 | zh | no-skill | 系统性文献综述和随便阅读几篇相关论文，核心区别在哪里？ | — | Y | 方法概念解释，无检索与综合任务 |
| SMC23 | zh | no-skill | 紫色的互补色通常是什么颜色？ | — | Y | 常识问答、无图片产物 |
| SMC24 | zh | no-skill | 软件项目里的 README 和 CHANGELOG 通常分别解决什么问题？ | — | Y | 文档概念比较，无仓库产物 |
| SMC25 | en | no-skill | Expand the abbreviation OAuth. | — | N | 简单缩写展开 |
| SMC26 | en | no-skill | What is a bar chart? | — | N | 基础定义 |
| SMC27 | en | no-skill | How many milliseconds are in three seconds? | — | N | 简单单位换算 |
| SMC28 | en | no-skill | What does peer review mean? | — | N | 基础术语解释 |
| SMC29 | en | no-skill | What is an illustration? | — | N | 基础定义、无生成请求 |
| SMC30 | en | no-skill | What is a source citation? | — | N | 基础定义、无检索要求 |

## 5. Independent held-out draft — 30 cases

配额：single/multi/no-skill=`12/6/12`；zh/en=`15/15`；hard-confuser=`21`。本节不是按 SMC
逐条改写：case 类型已交错，非空 Gold 不按相同下标复用，multi-skill 组合不与 calibration 重合。

| ID | Lang | Type | Query | Gold | Hard | 标注理由 |
| --- | --- | --- | --- | --- | --- | --- |
| SMH01 | en | single | Create three original paper-collage icons showing a seed, a rain gauge, and a greenhouse, all in one consistent visual style. | I | Y | 原创成套图像，不是图表或前端实现 |
| SMH02 | zh | no-skill | 公钥和私钥在数字签名中通常分别起什么作用？ | — | Y | 安全概念解释，无代码审计或配置动作 |
| SMH03 | en | multi | Get the agency's current published values for five named coastal stations, then place those unchanged values in a radial dot graphic with source links. | R+C | Y | R 核验当前官方数值；C 生成指定图形，单项不足 |
| SMH04 | zh | single | 邀请链接功能准备开放给外部合作方。请确认旧链接或别人的链接能不能被重复使用，先给上线风险，不要改代码。 | S | Y | 以可观察攻击路径表达实现安全检查 |
| SMH05 | en | no-skill | Why can a truncated vertical axis make two close values look much farther apart? | — | Y | 可视化原理解释，无图形产物 |
| SMH06 | en | single | A vendor says browsers no longer accept the legacy cookie attribute. Resolve this from current standards and vendor pages and cite the answer. | R | Y | 当前外部事实与一手来源核验 |
| SMH07 | zh | multi | 支付平台刚更新了签名规则。先从官方页面确认现行字段，再对照 webhook 校验代码找出可能接受伪造请求的地方，给出处和风险清单。 | S+R | Y | R 核验现行规则；S 检查实现是否接受伪造请求，单项不足 |
| SMH08 | zh | no-skill | API 的向后兼容和版本号通常分别解决什么问题？ | — | Y | API 概念解释，无仓库文档产物 |
| SMH09 | zh | single | 从上传的滑雪录像开头起每隔 15 秒取一张静态画面，共导出 6 张缩略图。 | V | Y | 对实际视频执行批量取帧 |
| SMH10 | en | no-skill | How does frame rate differ from playback speed? | — | Y | 视频概念解释，无媒体操作 |
| SMH11 | en | single | A rescue-dispatch platform must keep operating through regional outages; choose component boundaries and failover paths, then record the trade-off decision. | A | Y | 组件边界、故障恢复与架构取舍 |
| SMH12 | en | multi | Search and screen papers on unsafe deserialization with explicit eligibility rules, derive recurring attack conditions, then check the repository parser against those conditions. | L+S | Y | L 形成跨论文攻击条件；S 对照检查仓库实现，单项不足 |
| SMH13 | zh | no-skill | 为什么分辨率更高的图片文件不一定更大？ | — | Y | 图像概念解释，无生成请求 |
| SMH14 | zh | single | 把给定的六组能源占比表现为宽度不同的平行带状图形并导出 PNG，不补充数据分析。 | C | Y | 给定数值的专门图形产物，不做分析 |
| SMH15 | en | no-skill | Why do standards documents include version numbers? | — | N | 标准文档概念解释，不要求外部核验 |
| SMH16 | en | single | A new maintainer needs one concise page based on the current repository that explains configuration keys, usage examples, and common errors. | D | Y | 基于当前仓库生成维护者文档 |
| SMH17 | zh | multi | 给定已经算好的六组基准数值，生成一张对比图片，并把它加入仓库的开发者性能页，说明坐标含义和复现命令。 | C+D | Y | C 生成图片；D 形成仓库开发者页面，单项不足 |
| SMH18 | zh | no-skill | 最小权限原则为什么能降低账号被滥用后的影响范围？ | — | Y | 安全原则解释，无实现审计 |
| SMH19 | zh | single | 围绕神经网络稀疏化，预先定义论文检索式和纳排规则，记录排除项，并归纳入选研究之间的共同结论。 | L | Y | 可复现的多论文筛选与综合 |
| SMH20 | en | no-skill | When is a table easier to read than a graphic? | — | N | 表格与图形的概念性比较，无产物 |
| SMH21 | en | single | Before enabling passwordless recovery, determine whether the fallback token can be reused or claimed by the wrong account; return risks only. | S | Y | 对具体认证实现做攻击路径检查 |
| SMH22 | en | multi | The cloud queue service may have changed its official delivery and size limits. Resolve the current limits, then choose a topology around them and record the decision. | A+R | Y | R 核验当前官方限制；A 据此设计拓扑和 ADR，单项不足 |
| SMH23 | zh | no-skill | README 里的安装说明和 API 参考通常有什么区别？ | — | N | 文档概念解释，无仓库产物 |
| SMH24 | zh | single | 创作一张横版藏书票：雨夜灯塔、迁徙的鲸群和极简双色木刻风格。 | I | N | 明确原创图像生成 |
| SMH25 | en | no-skill | If a 24 fps clip lasts ten seconds, how many frames does it contain? | — | N | 简单算术，无视频操作 |
| SMH26 | en | single | Library branches must keep lending books while offline and reconcile later; decide the service and data boundaries and record the consistency trade-offs. | A | N | 服务与数据边界及一致性取舍 |
| SMH27 | zh | multi | 先决定插件事件总线的新模块边界和扩展点并形成 ADR，再根据当前 hook 签名写一份面向插件作者的接入参考。 | A+D | Y | A 负责架构与 ADR；D 负责基于代码的接入参考，单项不足 |
| SMH28 | zh | no-skill | 暖色和冷色通常会给人什么不同的视觉感受？ | — | N | 视觉概念解释，无图像生成 |
| SMH29 | zh | single | 检索并筛选多篇关于边缘设备模型压缩的论文，保留完整筛选记录，再比较各研究的评测设置和结论。 | L | N | 多论文检索、筛选记录与跨研究比较 |
| SMH30 | en | no-skill | What does least privilege mean when granting a user access? | — | N | 安全概念解释，无实现审计 |

## 6. Freeze review and confirmation

Catalog-level assistant audit（2026-08-20）：

- 30/30 held-out Gold 在冻结 5-candidate bundle 内通过最小充分性检查；
- 6/6 multi-skill 均有两个独立动作或产物，单项不足；
- 12/12 No-Skill 均无目标 Skill 合同要求的 artifact/action；
- 30/30 candidate bundle 包含 Gold，且候选均属于冻结的 19-Skill 实验 catalog；
- calibration→held-out 最大 token Jaccard=`0.3333`、最大 evaluation containment=`0.4737`、违规=`0`；
- 同下标 case type 重合=`11/30`，同下标非空 Gold 重合=`0`，multi pair 重合=`0/6`。

审计同时发现并关闭了一个设计歧义：Gold 不能对完整 132-Skill catalog 宣称唯一，因为存在同职责替代
Skill。Layer B 已收紧到 19-Skill 受控 catalog；完整 catalog 评测留待 alternative-Gold/等价类协议。

冻结时逐条确认：

1. Gold exact set 是否相对于 19-Skill 实验 catalog 唯一成立；
2. multi-skill 的两个能力是否都不可由另一项覆盖；
3. No-Skill 是否只是概念、常识或简单换算，没有 artifact/action 要求；
4. candidate bundle 是否包含合理 confuser，且没有遗漏 Gold；
5. query 是否自然，不直接复述 Skill description；
6. held-out case 类型是否交错，且没有以某条 SMC 为模板改写；
7. 同下标非空 Gold exact-set 重合是否为 0；
8. calibration/held-out multi-skill pair 重合是否为 0；
9. 同下标 case type 重合是否保持在机会水平附近，而不是逐项镜像。

上述 9 项全部确认。冻结确认记录：

- confirmedBy：用户（当前 Codex task）；
- confirmedAt：`2026-08-20T22:19:13+08:00`；
- freezeIdentity：`sha256:a974be7239f486eeb71f4f47d021c16731ba5da1fe1bc19877a68e1ccba2787f`；
- runner/model/retriever/held-out：未运行。

下一步只能实现并验证 runner/component，然后冻结 calibration run config。只有 calibration 通过协议门槛，
才允许一次性运行 held-out。
