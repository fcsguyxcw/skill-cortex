import type { SelectionEvalCase } from "./paired.ts";

export const EXPECTED_CATALOG_HASH =
  "sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7";
export const FROZEN_GOLD_SET_HASH =
  "sha256:45af7f527178dd47903845984b64916a827e1cb6be747cec90cd87d614708966";

export interface FrozenSelectionDevCase extends SelectionEvalCase {
  readonly labelType: "single" | "multi" | "no_skill";
  readonly language: "zh" | "en";
}

const SKILL_IDS = Object.freeze({
  diagnosingBugs: "skill:2693c89e1de701aaad7cef99edaf14720ab58056b01d84b62bfc56c7d1d056d3",
  codeReview: "skill:8111be861f909a00f2b377c8e90aa1593b8c5d642a529b3013d815083455069b",
  securityAuditor: "skill:669a5a164b1141e9d42f7cf0974122b71ec705616bb9fe6a5dcd34956162130d",
  architectureDesigner: "skill:03165140889cff61f45938f8b8af2a38980514158712b650f541a1220edb0081",
  pdf: "skill:a2fa83ab3477cd0caa895e6716cf5b5f6f0b35e7e3b64410b34898b823e79e36",
  docx: "skill:5e74252c038faac5c3dd480de4980b90d786918b0b2c28685eb830209f553e04",
  xlsx: "skill:b3859d361ba00ec5cb02ec0ef18e8356bbe4e5a8a6236b10b9ea13e9b5357af1",
  dataAnalysis: "skill:f7ee3af6ab0ce0c5040bb9871fd4b4df370f4256d30f0c465992d3ae9ada0873",
  academicPaperReview: "skill:681f792463fbcfbd0706f0ad9547329a308a0e741123efb5592b1e72e6197e5b",
  research: "skill:0b0d687f5de892f5968ff0880190b74fcda0c8cb7d1868c5e7907e5ea20b0f71",
  youtubeWatcher: "skill:9e1c09c8d8cdf48d0ef490d25c50e69cfbbbc83e84d4fd02d749dd7f2a400f2b",
});

export const DEV_SELECTION_CASES: readonly FrozenSelectionDevCase[] = Object.freeze([
  devCase("D01", "测试套件偶发超时，请先定位根因并给出证据，这轮不要改代码。", [SKILL_IDS.diagnosingBugs], "single", "zh"),
  devCase("D02", "Review this branch against the issue specification and repository standards.", [SKILL_IDS.codeReview], "single", "en"),
  devCase("D03", "Can you go through our authentication middleware and check whether there are any security holes around cross-origin requests, request validation, or exposed secrets? Don't change anything yet—just report the risks.", [SKILL_IDS.securityAuditor], "single", "en"),
  devCase("D04", "为一个可横向扩展的事件处理平台设计架构，并记录关键 ADR。", [SKILL_IDS.architectureDesigner], "single", "zh"),
  devCase("D05", "对 contract-scan.pdf 做 OCR，并提取其中所有表格。", [SKILL_IDS.pdf], "single", "zh"),
  devCase("D06", "Turn these meeting notes into a polished Word report with headings, a table of contents, and page numbers.", [SKILL_IDS.docx], "single", "en"),
  devCase("D07", "修复 sales.xlsx 中失效的公式，保持现有单元格格式，并输出修复后的工作簿。", [SKILL_IDS.xlsx], "single", "zh"),
  devCase("D08", "Analyze retention.csv, calculate cohort retention, and return only a Markdown findings summary—do not create a spreadsheet.", [SKILL_IDS.dataAnalysis], "single", "en"),
  devCase("D09", "Critique the methodology, contribution, and threats to validity of this arXiv paper.", [SKILL_IDS.academicPaperReview], "single", "en"),
  devCase("D10", "核验某 API 当前的官方行为，只使用一手资料，并给出带来源的 Markdown 结论。", [SKILL_IDS.research], "single", "zh"),
  devCase("D11", "Summarize this YouTube interview, then verify the speaker's three product claims against primary sources.", [SKILL_IDS.youtubeWatcher, SKILL_IDS.research], "multi", "en"),
  devCase("D12", "Extract the quarterly revenue tables from the attached annual-report PDF, calculate year-over-year growth, and return a Markdown analysis.", [SKILL_IDS.pdf, SKILL_IDS.dataAnalysis], "multi", "en"),
  devCase("D13", "17 摄氏度等于多少华氏度？", [], "no_skill", "zh"),
  devCase("D14", "Explain the TCP three-way handshake in two short paragraphs.", [], "no_skill", "en"),
]);

function devCase(
  id: string,
  query: string,
  goldSkillIds: readonly string[],
  labelType: FrozenSelectionDevCase["labelType"],
  language: FrozenSelectionDevCase["language"],
): FrozenSelectionDevCase {
  return Object.freeze({
    id,
    query,
    goldSkillIds: Object.freeze([...goldSkillIds]),
    labelType,
    language,
  });
}
