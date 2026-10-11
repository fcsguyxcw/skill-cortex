import { createHash } from "node:crypto";

export type ActivationMemoryLanguage = "zh" | "en";
export type ActivationMemoryEvalPartition = "calibration" | "heldout";
export type ActivationMemoryLabel = "single" | "multi" | "no_skill";

export interface ActivationMemoryTargetSkill {
  readonly key: string;
  readonly name: string;
  readonly skillId: string;
  readonly skillRevision: string;
  readonly earlyExperienceLanguage: ActivationMemoryLanguage;
}

export interface ActivationMemoryExperienceCase {
  readonly id: string;
  readonly targetSkillId: string;
  readonly targetSkillRevision: string;
  readonly ordinal: number;
  readonly language: ActivationMemoryLanguage;
  readonly query: string;
  readonly provenance: "evaluation_fixture";
  readonly expectedAttribution: "positive";
}

export interface ActivationMemoryEvalCase {
  readonly id: string;
  readonly partition: ActivationMemoryEvalPartition;
  readonly language: ActivationMemoryLanguage;
  readonly labelType: ActivationMemoryLabel;
  readonly query: string;
  readonly goldSkillIds: readonly string[];
  readonly hardConfuser: boolean;
}

export type ActivationMemoryNegativeControlKind =
  | "shuffled_profile"
  | "unverified_success"
  | "stale_revision"
  | "deleted_evidence"
  | "cross_scope"
  | "near_miss_contamination";

export interface ActivationMemoryNegativeControlCase {
  readonly id: string;
  readonly kind: ActivationMemoryNegativeControlKind;
  readonly targetSkillId: string;
  readonly expectedOutcome: "no_active_overlay" | "fallback_baseline" | "no_cross_task_transfer";
}

export const ACTIVATION_MEMORY_CATALOG_HASH =
  "sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7";

export const ACTIVATION_MEMORY_TARGET_SKILLS: readonly ActivationMemoryTargetSkill[] = Object.freeze([
  target("architecture", "architecture-designer", "skill:03165140889cff61f45938f8b8af2a38980514158712b650f541a1220edb0081", "rev:3cd15b9327f119e63cd055e76aeecd2a115b37ef309194808fb690a7b6844cb0", "zh"),
  target("systematicReview", "systematic-literature-review", "skill:bec8e35a8e60b62db96e41a97f5ba935202b9c889add41060d989ee126aac730", "rev:b3623c87c190d153abf724f9f605e92ba81ca12f7dcd5a4087e5d2c37a9e5645", "en"),
  target("security", "security-auditor", "skill:669a5a164b1141e9d42f7cf0974122b71ec705616bb9fe6a5dcd34956162130d", "rev:df9d3172f803bb33205c063343e5a1870d9f9e539d7cd98941ba84f9aaf7036e", "zh"),
  target("chart", "chart-visualization", "skill:87048bb1689f395a322b3ed4912eb8d3ee3bc7bfb91df2730573f91bb21256a1", "rev:7d76b7489efe2041eddd92f0d63688b4f63ff4149bda131194dc301188a7c93e", "en"),
  target("codeDocumentation", "code-documentation", "skill:e8da2ec737ed6579d59d7ebbc552b452d5f1a6e25cf470b5205751d607e39ec8", "rev:dab12680db31319159827bab3578835147f331f3cf23628da4c9f763edc10b9e", "zh"),
  target("research", "research", "skill:0b0d687f5de892f5968ff0880190b74fcda0c8cb7d1868c5e7907e5ea20b0f71", "rev:e519f038cca0eb2019ce9fc3ef0bd5044e3973f17f20778f36c38a91ae99c699", "en"),
  target("videoFrames", "video-frames", "skill:f8e0587f44d60bc94b14b9f557f2b578dff79f6b736385cf034ffe1be03c3fc6", "rev:73e1792ab8d20721060ec1c9418fafb1fc6552c3b624c6bdd1dd61e4a7b3710d", "zh"),
  target("imageGeneration", "image-generation", "skill:c564b209ae13dda734cd4fd971762dd8840278c5c7309fa540c6bce4b65e5562", "rev:99905bf6bdb5ffea2bda7c999b08f90eb814e89e027f92d3bf43bc51b9dbf95f", "en"),
]);

const EXPERIENCE_QUERIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  architecture: Object.freeze([
    "为跨地区告警平台比较事件总线和消息队列架构，并记录取舍。",
    "设计多租户计费系统的服务边界并写一份 ADR。",
    "评审实时协作后端的扩展性和故障隔离方案。",
    "规划文件处理平台架构，比较同步和异步工作流。",
    "Design the service architecture for a regional notification platform and document the trade-offs.",
    "Review the boundaries of a multi-tenant billing system and record an ADR.",
    "Compare event-driven and request-response designs for a collaboration backend.",
    "Create an architecture decision record for scaling a document-processing pipeline.",
  ]),
  systematicReview: Object.freeze([
    "Synthesize the evidence across papers on robust graph neural networks using explicit inclusion criteria.",
    "Run a systematic literature review of privacy-preserving recommendation research.",
    "Compare methods and findings across studies of retrieval-augmented generation evaluation.",
    "Build a reproducible search and screening protocol for literature on agent memory.",
    "系统检索并综合联邦学习公平性的多篇论文，写明纳排标准。",
    "围绕代码智能体评测做系统性文献综述，并总结跨论文主题。",
    "比较多篇关于长上下文检索的研究方法和结论。",
    "制定可复现的检索式，筛选并综合工具学习相关论文。",
  ]),
  security: Object.freeze([
    "审计支付回调的签名校验，重点检查重放和绕过风险，不要改代码。",
    "检查登录中间件是否会泄露密钥或接受伪造令牌，只报告风险。",
    "复核文件上传接口的路径穿越和恶意内容处理漏洞。",
    "评估跨域认证流程中的请求验证和会话固定风险。",
    "Audit the password-reset flow for token leakage and account-takeover paths without changing code.",
    "Review webhook authentication for replay and signature-bypass vulnerabilities.",
    "Assess the upload endpoint for traversal, injection, and unsafe file handling.",
    "Inspect the session middleware for fixation and cross-origin security weaknesses.",
  ]),
  chart: Object.freeze([
    "Render the monthly retention values as a heatmap image without statistical interpretation.",
    "Create a radar-chart image from these product scores.",
    "Turn the regional sales series into a publication-ready line chart.",
    "Visualize the category distribution as a polar-area chart and return the image.",
    "把季度留存率绘制成热力图图片，不做统计分析。",
    "将这组产品评分做成雷达图。",
    "把各地区销量序列绘制成适合报告使用的折线图。",
    "将类别占比制作成极坐标面积图并输出图片。",
  ]),
  codeDocumentation: Object.freeze([
    "为这个 SDK 生成 API 参考文档和升级说明。",
    "整理仓库里的配置选项，并写成开发者文档。",
    "根据当前实现补齐模块说明、示例和错误处理章节。",
    "把公共接口变化整理成仓库内的迁移指南。",
    "Generate API reference documentation and an upgrade guide for this SDK.",
    "Document the repository configuration options for developers.",
    "Add module overview, usage examples, and error-handling notes from the current implementation.",
    "Turn the public interface changes into a repository migration guide.",
  ]),
  research: Object.freeze([
    "Verify the current behavior of this API using only official sources and write a cited Markdown note.",
    "Investigate the latest browser policy from primary documentation and capture the findings with links.",
    "Check whether the vendor still supports this authentication flow using authoritative sources.",
    "Research the current specification requirement and record source-backed conclusions in the repository.",
    "只查一手资料，核验这个 API 的当前行为并写一份带来源的 Markdown 结论。",
    "查阅官方文档确认浏览器策略是否变化，并附上出处。",
    "核对供应商是否仍支持这套认证流程，只使用权威来源。",
    "调查当前规范要求，把有来源的结论记录到仓库中。",
  ]),
  videoFrames: Object.freeze([
    "从演示视频的第 12 秒和第 45 秒各提取一张 PNG。",
    "截取 MP4 的第一帧、中央帧和最后一帧。",
    "从上传的视频里提取指定时间码的静态画面。",
    "把视频 00:30 到 00:35 的短片段单独导出。",
    "Extract PNG frames at 00:08 and 01:20 from the attached video.",
    "Return the first, middle, and final still frames from this MP4.",
    "Capture a reference image at the specified video timestamp.",
    "Export the five-second clip between 02:10 and 02:15.",
  ]),
  imageGeneration: Object.freeze([
    "Generate an original watercolor illustration of a quiet railway station at dawn.",
    "Create a square campaign poster with a paper-cut visual style.",
    "Produce three concept images for a friendly household robot.",
    "Use the attached image as a palette reference and generate a new festival illustration.",
    "生成一张清晨安静火车站的原创水彩插画。",
    "制作一张剪纸风格的方形活动海报。",
    "为亲和型家用机器人生成三张概念图。",
    "参考附件的配色，生成一张新的节日插画。",
  ]),
});

export const ACTIVATION_MEMORY_EXPERIENCE_CASES: readonly ActivationMemoryExperienceCase[] = Object.freeze(
  ACTIVATION_MEMORY_TARGET_SKILLS.flatMap((skill) => {
    const queries = EXPERIENCE_QUERIES[skill.key];
    if (!queries || queries.length !== 8) throw new Error(`Expected eight experience queries for ${skill.key}`);
    return queries.map((query, index) => experienceCase(skill, index + 1, query));
  }),
);

const ID = Object.freeze(Object.fromEntries(ACTIVATION_MEMORY_TARGET_SKILLS.map((skill) => [skill.key, skill.skillId])) as Record<string, string>);

export const ACTIVATION_MEMORY_CALIBRATION_CASES: readonly ActivationMemoryEvalCase[] = Object.freeze([
  evalCase("AMC01", "calibration", "zh", "为跨境订单平台评估分区、消息传递与故障恢复方案，并记录架构决定。", [ID.architecture], true),
  evalCase("AMC02", "calibration", "en", "Review the architecture of a telemetry ingestion service and record the scaling decision.", [ID.architecture], true),
  evalCase("AMC03", "calibration", "zh", "系统检索多篇关于大模型事实一致性的论文，说明检索式、筛选流程和综合主题。", [ID.systematicReview], true),
  evalCase("AMC04", "calibration", "en", "Conduct a systematic review across studies of test-time compute, including screening criteria and evidence synthesis.", [ID.systematicReview], true),
  evalCase("AMC05", "calibration", "zh", "检查 OAuth state 参数处理是否存在登录劫持风险，只提交安全报告。", [ID.security], true),
  evalCase("AMC06", "calibration", "en", "Audit the invite-token implementation for privilege escalation and token disclosure; do not patch it.", [ID.security], true),
  evalCase("AMC07", "calibration", "zh", "把渠道转化率画成漏斗图图片，不要做业务分析。", [ID.chart], true),
  evalCase("AMC08", "calibration", "en", "Render the latency percentiles as a box-plot image and provide no statistical interpretation.", [ID.chart], true),
  evalCase("AMC09", "calibration", "zh", "根据现有源码为插件接口补写参考文档、调用示例和迁移说明。", [ID.codeDocumentation], true),
  evalCase("AMC10", "calibration", "en", "Document the command-line interface from the current source, including examples and exit codes.", [ID.codeDocumentation], true),
  evalCase("AMC11", "calibration", "zh", "核验该云服务当前的区域限制，只引用官方资料并给出带链接的 Markdown 结论。", [ID.research], true),
  evalCase("AMC12", "calibration", "en", "Verify the current deprecation policy from primary vendor sources and write a cited repository note.", [ID.research], true),
  evalCase("AMC13", "calibration", "zh", "从课程录像的 00:15、03:40 和结尾各导出一张静态图。", [ID.videoFrames], true),
  evalCase("AMC14", "calibration", "en", "Extract a six-second clip beginning at 01:12 from the uploaded video.", [ID.videoFrames], true),
  evalCase("AMC15", "calibration", "zh", "生成一张复古科幻风格的原创书籍封面插画。", [ID.imageGeneration], true),
  evalCase("AMC16", "calibration", "en", "Create an original isometric illustration of a solar-powered neighborhood.", [ID.imageGeneration], true),
  evalCase("AMC17", "calibration", "zh", "查阅官方升级文档核验行为变化，并把调用点影响整理成仓库迁移文档。", [ID.research, ID.codeDocumentation], true),
  evalCase("AMC18", "calibration", "en", "Extract a reference frame from the product video, then generate a new poster inspired by its palette.", [ID.videoFrames, ID.imageGeneration], true),
  evalCase("AMC19", "calibration", "zh", "系统综述城市热岛研究，并把各研究的效应量绘制成森林图。", [ID.systematicReview, ID.chart], true),
  evalCase("AMC20", "calibration", "en", "Audit the public API for authorization flaws, then document the affected endpoints and safe usage constraints.", [ID.security, ID.codeDocumentation], true),
  evalCase("AMC21", "calibration", "zh", "ADR 在软件工程里通常指什么？", [], true),
  evalCase("AMC22", "calibration", "en", "What is the difference between a chart and a diagram?", [], true),
  evalCase("AMC23", "calibration", "zh", "一小时的视频每秒 30 帧，一共有多少帧？", [], true),
  evalCase("AMC24", "calibration", "en", "In one sentence, what is a literature review?", [], true),
]);

export const ACTIVATION_MEMORY_HELDOUT_CASES: readonly ActivationMemoryEvalCase[] = Object.freeze([
  evalCase("AMH01", "heldout", "zh", "为全球库存同步系统选择一致性与事件传播方案，并形成架构决策记录。", [ID.architecture], true),
  evalCase("AMH02", "heldout", "en", "Assess the service topology for a high-volume audit pipeline and write down the architectural trade-off.", [ID.architecture], true),
  evalCase("AMH03", "heldout", "zh", "对多篇神经符号推理论文开展系统综述，公开数据库、检索式和纳排流程。", [ID.systematicReview], true),
  evalCase("AMH04", "heldout", "en", "Systematically review research on synthetic data quality with a reproducible search and screening process.", [ID.systematicReview], true),
  evalCase("AMH05", "heldout", "zh", "审查密码重置令牌的生成与校验是否可被接管账户，不要修改实现。", [ID.security], true),
  evalCase("AMH06", "heldout", "en", "Inspect the SSO callback for session fixation and signature confusion, reporting risks only.", [ID.security], true),
  evalCase("AMH07", "heldout", "zh", "把不同模型的准确率和延迟绘制成气泡图，返回图片即可。", [ID.chart], true),
  evalCase("AMH08", "heldout", "en", "Produce a Sankey chart from these transition counts without analyzing the underlying business process.", [ID.chart], true),
  evalCase("AMH09", "heldout", "zh", "从仓库实现生成事件协议文档，包含字段说明、示例和兼容性注意事项。", [ID.codeDocumentation], true),
  evalCase("AMH10", "heldout", "en", "Write developer documentation for the extension hooks based on the checked-in implementation.", [ID.codeDocumentation], true),
  evalCase("AMH11", "heldout", "zh", "只用标准组织和厂商的一手资料确认这个协议的最新要求，并记录引用。", [ID.research], true),
  evalCase("AMH12", "heldout", "en", "Investigate the present API quota semantics in official documentation and capture a source-linked conclusion.", [ID.research], true),
  evalCase("AMH13", "heldout", "zh", "截取上传视频在 02:05 的画面，并导出为 PNG。", [ID.videoFrames], true),
  evalCase("AMH14", "heldout", "en", "Return still images from the first frame and the frame at 90 percent of the video duration.", [ID.videoFrames], true),
  evalCase("AMH15", "heldout", "zh", "创作一张以深海实验室为主题的原创等距插画。", [ID.imageGeneration], true),
  evalCase("AMH16", "heldout", "en", "Generate a new editorial illustration showing a city adapting to extreme heat.", [ID.imageGeneration], true),
  evalCase("AMH17", "heldout", "zh", "从官方发布说明确认废弃接口，再为仓库编写带来源的升级文档。", [ID.research, ID.codeDocumentation], true),
  evalCase("AMH18", "heldout", "en", "Take a still from the supplied clip as visual reference and create an original event banner from it.", [ID.videoFrames, ID.imageGeneration], true),
  evalCase("AMH19", "heldout", "zh", "系统综合多篇电池寿命研究，并把研究结果制作成分组点图。", [ID.systematicReview, ID.chart], true),
  evalCase("AMH20", "heldout", "en", "Review the authentication library for security weaknesses and document the exposed public interfaces and mitigations.", [ID.security, ID.codeDocumentation], true),
  evalCase("AMH21", "heldout", "zh", "‘系统架构’这个短语是什么意思？", [], true),
  evalCase("AMH22", "heldout", "en", "How many seconds are there in a five-minute video?", [], true),
  evalCase("AMH23", "heldout", "zh", "红色和蓝色混合通常会得到什么颜色？", [], false),
  evalCase("AMH24", "heldout", "en", "What does the word research mean in everyday English?", [], true),
]);

export const ACTIVATION_MEMORY_NEGATIVE_CONTROLS: readonly ActivationMemoryNegativeControlCase[] = Object.freeze([
  control("AMN01", "shuffled_profile", ID.architecture, "no_cross_task_transfer"),
  control("AMN02", "unverified_success", ID.security, "no_active_overlay"),
  control("AMN03", "stale_revision", ID.chart, "fallback_baseline"),
  control("AMN04", "deleted_evidence", ID.codeDocumentation, "fallback_baseline"),
  control("AMN05", "cross_scope", ID.research, "fallback_baseline"),
  control("AMN06", "near_miss_contamination", ID.imageGeneration, "no_cross_task_transfer"),
]);

export function computeActivationMemoryFixtureHash(): string {
  const payload = {
    catalogHash: ACTIVATION_MEMORY_CATALOG_HASH,
    targets: [...ACTIVATION_MEMORY_TARGET_SKILLS].sort(byId),
    experience: [...ACTIVATION_MEMORY_EXPERIENCE_CASES].sort(byId),
    calibration: [...ACTIVATION_MEMORY_CALIBRATION_CASES].sort(byId),
    heldout: [...ACTIVATION_MEMORY_HELDOUT_CASES].sort(byId),
    negativeControls: [...ACTIVATION_MEMORY_NEGATIVE_CONTROLS].sort(byId),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}`;
}

// Human-confirmed catalog-bound development fixture identity (2026-08-20).
export const FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH =
  "sha256:5f2bd1da0372601cba3cc45ee5285c2243f4024ffc4950abbd098f46a8570a30";

function target(key: string, name: string, skillId: string, skillRevision: string, earlyExperienceLanguage: ActivationMemoryLanguage): ActivationMemoryTargetSkill {
  return Object.freeze({ key, name, skillId, skillRevision, earlyExperienceLanguage });
}

function experienceCase(skill: ActivationMemoryTargetSkill, ordinal: number, query: string): ActivationMemoryExperienceCase {
  const language = ordinal <= 4 ? skill.earlyExperienceLanguage : skill.earlyExperienceLanguage === "zh" ? "en" : "zh";
  return Object.freeze({
    id: `AME-${skill.key}-${String(ordinal).padStart(2, "0")}`,
    targetSkillId: skill.skillId,
    targetSkillRevision: skill.skillRevision,
    ordinal,
    language,
    query,
    provenance: "evaluation_fixture",
    expectedAttribution: "positive",
  });
}

function evalCase(id: string, partition: ActivationMemoryEvalPartition, language: ActivationMemoryLanguage, query: string, goldSkillIds: readonly string[], hardConfuser: boolean): ActivationMemoryEvalCase {
  const labelType: ActivationMemoryLabel = goldSkillIds.length === 0 ? "no_skill" : goldSkillIds.length === 1 ? "single" : "multi";
  return Object.freeze({ id, partition, language, labelType, query, goldSkillIds: Object.freeze([...goldSkillIds]), hardConfuser });
}

function control(id: string, kind: ActivationMemoryNegativeControlKind, targetSkillId: string, expectedOutcome: ActivationMemoryNegativeControlCase["expectedOutcome"]): ActivationMemoryNegativeControlCase {
  return Object.freeze({ id, kind, targetSkillId, expectedOutcome });
}

function byId(left: { readonly id?: string; readonly skillId?: string }, right: { readonly id?: string; readonly skillId?: string }): number {
  return (left.id ?? left.skillId ?? "").localeCompare(right.id ?? right.skillId ?? "");
}
