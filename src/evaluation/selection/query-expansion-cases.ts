export type QueryExpansionEvalPartition = "calibration" | "dev";
export type QueryExpansionEvalLabel = "single" | "multi" | "no_skill";

export interface QueryExpansionEvalCase {
  readonly id: string;
  readonly partition: QueryExpansionEvalPartition;
  readonly language: "zh" | "en";
  readonly labelType: QueryExpansionEvalLabel;
  readonly query: string;
  readonly goldSkillIds: readonly string[];
}

const IDS = Object.freeze({
  amap: "skill:cbf6cf5b0890e5ea7a68ed773112acfff0d18a2b62637e75e03c04d420916211",
  architecture: "skill:03165140889cff61f45938f8b8af2a38980514158712b650f541a1220edb0081",
  chart: "skill:87048bb1689f395a322b3ed4912eb8d3ee3bc7bfb91df2730573f91bb21256a1",
  codeDocumentation: "skill:e8da2ec737ed6579d59d7ebbc552b452d5f1a6e25cf470b5205751d607e39ec8",
  dataAnalysis: "skill:f7ee3af6ab0ce0c5040bb9871fd4b4df370f4256d30f0c465992d3ae9ada0873",
  domainModeling: "skill:949457902c5ffb8e9c84b5dcf90073cee62084607593a3da0ae037b63121608b",
  imageGeneration: "skill:c564b209ae13dda734cd4fd971762dd8840278c5c7309fa540c6bce4b65e5562",
  pdf: "skill:a2fa83ab3477cd0caa895e6716cf5b5f6f0b35e7e3b64410b34898b823e79e36",
  research: "skill:0b0d687f5de892f5968ff0880190b74fcda0c8cb7d1868c5e7907e5ea20b0f71",
  security: "skill:669a5a164b1141e9d42f7cf0974122b71ec705616bb9fe6a5dcd34956162130d",
  systematicReview: "skill:bec8e35a8e60b62db96e41a97f5ba935202b9c889add41060d989ee126aac730",
  tts: "skill:bb60775d931e951bc870511a40388a5daebf5d7ca88c7f5868521943ce982408",
  videoFrames: "skill:f8e0587f44d60bc94b14b9f557f2b578dff79f6b736385cf034ffe1be03c3fc6",
  xlsx: "skill:b3859d361ba00ec5cb02ec0ef18e8356bbe4e5a8a6236b10b9ea13e9b5357af1",
});

/** Development-only cases; not a formal benchmark or replacement held-out. */
export const QUERY_EXPANSION_EVAL_CASES: readonly QueryExpansionEvalCase[] = Object.freeze([
  evalCase("QEC01", "calibration", "zh", "single", "请比较单体和事件驱动方案，给出架构取舍并写一份 ADR。", [IDS.architecture]),
  evalCase("QEC02", "calibration", "en", "single", "Review the OAuth callback code for security vulnerabilities and authentication risks.", [IDS.security]),
  evalCase("QEC03", "calibration", "zh", "single", "请做一份关于图神经网络鲁棒性的系统性文献综述，综合多篇论文。", [IDS.systematicReview]),
  evalCase("QEC04", "calibration", "en", "single", "Render these quarterly values as a radar chart image.", [IDS.chart]),
  evalCase("QEC05", "calibration", "zh", "multi", "查阅官方迁移文档核验 API 行为，并整理一份代码文档和变更说明。", [IDS.research, IDS.codeDocumentation]),
  evalCase("QEC06", "calibration", "en", "multi", "Perform data analysis on the service measurements, compute statistics, and generate a line chart visualization.", [IDS.dataAnalysis, IDS.chart]),
  evalCase("QEC07", "calibration", "zh", "no_skill", "“架构”这个词通常是什么意思？", []),
  evalCase("QEC08", "calibration", "en", "no_skill", "What does the abbreviation API stand for?", []),
  evalCase("QEC09", "calibration", "zh", "single", "把这段说明文字合成为一段自然旁白音频。", [IDS.tts]),
  evalCase("QEC10", "calibration", "en", "single", "Extract a still video frame at the ten-second mark.", [IDS.videoFrames]),
  evalCase("QEC11", "calibration", "zh", "no_skill", "API 是哪几个英文单词的缩写？", []),
  evalCase("QEC12", "calibration", "en", "no_skill", "Is a chart the same thing as a table?", []),
  evalCase("QED01", "dev", "zh", "single", "将这组传感器数据绘制成一张雷达图图片。", [IDS.chart]),
  evalCase("QED02", "dev", "en", "single", "Design the architecture for a regional notification platform and document the ADR.", [IDS.architecture]),
  evalCase("QED03", "dev", "zh", "single", "查找学校附近适合午餐的餐厅，并规划一条步行路线。", [IDS.amap]),
  evalCase("QED04", "dev", "en", "single", "Conduct a systematic literature review across papers on robust recommendation systems.", [IDS.systematicReview]),
  evalCase("QED05", "dev", "zh", "multi", "从视频中提取一帧作为参考，再基于该画面生成一张活动海报图片。", [IDS.videoFrames, IDS.imageGeneration]),
  evalCase("QED06", "dev", "en", "multi", "Extract every table from the PDF and create a formatted XLSX workbook.", [IDS.pdf, IDS.xlsx]),
  evalCase("QED07", "dev", "zh", "single", "审计登录回调中的认证安全和密钥泄露风险，不要修改代码。", [IDS.security]),
  evalCase("QED08", "dev", "en", "single", "Generate API documentation and a migration guide for this library.", [IDS.codeDocumentation]),
  evalCase("QED09", "dev", "zh", "no_skill", "PDF 这三个字母代表什么？", []),
  evalCase("QED10", "dev", "en", "no_skill", "What is the difference between a website and a web page?", []),
  evalCase("QED11", "dev", "zh", "no_skill", "图表和表格有什么区别？", []),
  evalCase("QED12", "dev", "en", "no_skill", "What is two hundred divided by eight?", []),
]);

function evalCase(
  id: string,
  partition: QueryExpansionEvalPartition,
  language: "zh" | "en",
  labelType: QueryExpansionEvalLabel,
  query: string,
  goldSkillIds: readonly string[],
): QueryExpansionEvalCase {
  return Object.freeze({ id, partition, language, labelType, query, goldSkillIds: Object.freeze([...goldSkillIds]) });
}
