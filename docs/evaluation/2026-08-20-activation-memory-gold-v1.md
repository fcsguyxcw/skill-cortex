# Activation Memory development Gold v1

冻结日期：2026-08-20  
状态：**人工确认并冻结；尚未运行 held-out 或 model**

## 1. 绑定与边界

- Catalog hash：`sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7`
- Frozen fixture hash：`sha256:5f2bd1da0372601cba3cc45ee5285c2243f4024ffc4950abbd098f46a8570a30`
- 机器可读来源：`src/evaluation/activation-memory/cases.ts`
- Gold 由任务意图和冻结 catalog 人工拟定；不得依据 BM25、QE、Activation overlay 或模型输出反向改标。
- 本数据与 Selection final-heldout、Query Expansion calibration/dev 均无 query 精确重叠。
- 用户于 2026-08-20 明确确认该 Gold；冻结后不得依据 calibration、held-out、模型或检索输出反向改标。
- Held-out 仍保持 untouched；本轮授权只覆盖 calibration ablation，不覆盖 held-out retrieval/model。

## 2. 数据分区

| 分区 | 数量 | 中文/英文 | single/multi/no-skill | 用途 |
| --- | ---: | ---: | ---: | --- |
| Experience | 64 | 32/32 | 每个目标 Skill 8 条正向经验 | 构造 0/1/2/4/8 条嵌套 learning curve |
| Calibration | 24 | 12/12 | 16/4/4 | 调规则、阈值和 promotion policy |
| Held-out | 24 | 12/12 | 16/4/4 | 协议冻结后一次性评估 |
| Negative controls | 6 | N/A | N/A | shuffled、unverified、stale、deleted、cross-scope、near-miss |

8 个目标 Skill：`architecture-designer`、`systematic-literature-review`、`security-auditor`、`chart-visualization`、`code-documentation`、`research`、`video-frames`、`image-generation`。每个目标绑定快照中的 `skillId + skillRevision`。

Experience 不是生产成功记录，而是 `evaluation_fixture`。每条只表达一个预期可归因的正向使用；在生成 active profile 前仍须通过既有 induction、shadow 和 promotion gate。

## 3. Calibration Gold

| ID | 语言 | Query | Gold |
| --- | --- | --- | --- |
| AMC01 | zh | 为跨境订单平台评估分区、消息传递与故障恢复方案，并记录架构决定。 | architecture-designer |
| AMC02 | en | Review the architecture of a telemetry ingestion service and record the scaling decision. | architecture-designer |
| AMC03 | zh | 系统检索多篇关于大模型事实一致性的论文，说明检索式、筛选流程和综合主题。 | systematic-literature-review |
| AMC04 | en | Conduct a systematic review across studies of test-time compute, including screening criteria and evidence synthesis. | systematic-literature-review |
| AMC05 | zh | 检查 OAuth state 参数处理是否存在登录劫持风险，只提交安全报告。 | security-auditor |
| AMC06 | en | Audit the invite-token implementation for privilege escalation and token disclosure; do not patch it. | security-auditor |
| AMC07 | zh | 把渠道转化率画成漏斗图图片，不要做业务分析。 | chart-visualization |
| AMC08 | en | Render the latency percentiles as a box-plot image and provide no statistical interpretation. | chart-visualization |
| AMC09 | zh | 根据现有源码为插件接口补写参考文档、调用示例和迁移说明。 | code-documentation |
| AMC10 | en | Document the command-line interface from the current source, including examples and exit codes. | code-documentation |
| AMC11 | zh | 核验该云服务当前的区域限制，只引用官方资料并给出带链接的 Markdown 结论。 | research |
| AMC12 | en | Verify the current deprecation policy from primary vendor sources and write a cited repository note. | research |
| AMC13 | zh | 从课程录像的 00:15、03:40 和结尾各导出一张静态图。 | video-frames |
| AMC14 | en | Extract a six-second clip beginning at 01:12 from the uploaded video. | video-frames |
| AMC15 | zh | 生成一张复古科幻风格的原创书籍封面插画。 | image-generation |
| AMC16 | en | Create an original isometric illustration of a solar-powered neighborhood. | image-generation |
| AMC17 | zh | 查阅官方升级文档核验行为变化，并把调用点影响整理成仓库迁移文档。 | research + code-documentation |
| AMC18 | en | Extract a reference frame from the product video, then generate a new poster inspired by its palette. | video-frames + image-generation |
| AMC19 | zh | 系统综述城市热岛研究，并把各研究的效应量绘制成森林图。 | systematic-literature-review + chart-visualization |
| AMC20 | en | Audit the public API for authorization flaws, then document the affected endpoints and safe usage constraints. | security-auditor + code-documentation |
| AMC21 | zh | ADR 在软件工程里通常指什么？ | No-Skill |
| AMC22 | en | What is the difference between a chart and a diagram? | No-Skill |
| AMC23 | zh | 一小时的视频每秒 30 帧，一共有多少帧？ | No-Skill |
| AMC24 | en | In one sentence, what is a literature review? | No-Skill |

## 4. Held-out Gold

| ID | 语言 | Query | Gold |
| --- | --- | --- | --- |
| AMH01 | zh | 为全球库存同步系统选择一致性与事件传播方案，并形成架构决策记录。 | architecture-designer |
| AMH02 | en | Assess the service topology for a high-volume audit pipeline and write down the architectural trade-off. | architecture-designer |
| AMH03 | zh | 对多篇神经符号推理论文开展系统综述，公开数据库、检索式和纳排流程。 | systematic-literature-review |
| AMH04 | en | Systematically review research on synthetic data quality with a reproducible search and screening process. | systematic-literature-review |
| AMH05 | zh | 审查密码重置令牌的生成与校验是否可被接管账户，不要修改实现。 | security-auditor |
| AMH06 | en | Inspect the SSO callback for session fixation and signature confusion, reporting risks only. | security-auditor |
| AMH07 | zh | 把不同模型的准确率和延迟绘制成气泡图，返回图片即可。 | chart-visualization |
| AMH08 | en | Produce a Sankey chart from these transition counts without analyzing the underlying business process. | chart-visualization |
| AMH09 | zh | 从仓库实现生成事件协议文档，包含字段说明、示例和兼容性注意事项。 | code-documentation |
| AMH10 | en | Write developer documentation for the extension hooks based on the checked-in implementation. | code-documentation |
| AMH11 | zh | 只用标准组织和厂商的一手资料确认这个协议的最新要求，并记录引用。 | research |
| AMH12 | en | Investigate the present API quota semantics in official documentation and capture a source-linked conclusion. | research |
| AMH13 | zh | 截取上传视频在 02:05 的画面，并导出为 PNG。 | video-frames |
| AMH14 | en | Return still images from the first frame and the frame at 90 percent of the video duration. | video-frames |
| AMH15 | zh | 创作一张以深海实验室为主题的原创等距插画。 | image-generation |
| AMH16 | en | Generate a new editorial illustration showing a city adapting to extreme heat. | image-generation |
| AMH17 | zh | 从官方发布说明确认废弃接口，再为仓库编写带来源的升级文档。 | research + code-documentation |
| AMH18 | en | Take a still from the supplied clip as visual reference and create an original event banner from it. | video-frames + image-generation |
| AMH19 | zh | 系统综合多篇电池寿命研究，并把研究结果制作成分组点图。 | systematic-literature-review + chart-visualization |
| AMH20 | en | Review the authentication library for security weaknesses and document the exposed public interfaces and mitigations. | security-auditor + code-documentation |
| AMH21 | zh | “系统架构”这个短语是什么意思？ | No-Skill |
| AMH22 | en | How many seconds are there in a five-minute video? | No-Skill |
| AMH23 | zh | 红色和蓝色混合通常会得到什么颜色？ | No-Skill |
| AMH24 | en | What does the word research mean in everyday English? | No-Skill |

## 5. 人工冻结记录

已确认：

1. Gold exact set 相对于当前 catalog 唯一成立；
2. multi-skill 的两个子任务确实不可由单一 Skill 完整覆盖；
3. No-Skill 不因出现 `architecture`、`chart`、`video`、`literature review`、`research` 等表面词而改标；
4. Experience 正向归因不与目标 Skill 的真实 description 冲突；
5. fixture hash 同时绑定 catalog、targets、experience、calibration、held-out 与 negative controls。

Calibration config hash：`sha256:770e80357df5a2f5e11334844a9c2748ef5fca899fa28300b38bf3ca674748c1`。
固定参数为 Top-K `5`、memory boost `5`、near-miss penalty `1`、exposure `0/1/2/4/8`。
