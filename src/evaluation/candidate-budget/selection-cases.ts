import { SELECTION_MEMORY_SKILL_IDS as ID } from "../selection-memory/evidence-cases.ts";

export interface CandidateBudgetSelectionCase {
  readonly id: string;
  readonly slice: "single" | "multi" | "no_skill" | "hard_confuser";
  readonly query: string;
  readonly goldSkillIds: readonly string[];
  readonly candidateSkillIds: readonly string[];
}

export const CANDIDATE_BUDGET_SELECTION_CASES: readonly CandidateBudgetSelectionCase[] = Object.freeze([
  c("CBH01", "single", "Create an original square illustration of a glass observatory floating above a desert at night.", [ID.imageGeneration], [ID.imageGeneration, ID.chart, ID.imageToCode, ID.code, ID.research]),
  c("CBH02", "single", "从这段本地会议录像的 00:40、01:20 和 02:00 各导出一张 PNG 画面。", [ID.videoFrames], [ID.videoFrames, ID.ffmpegEditor, ID.youtubeWatcher, ID.imageGeneration, ID.code]),
  c("CBH03", "single", "Audit the existing password reset implementation for account takeover paths and return findings only.", [ID.security], [ID.security, ID.clawdefender, ID.code, ID.codebaseDesign, ID.research]),
  c("CBH04", "multi", "Check the provider's current webhook signature rules from official sources, then audit this repository's verifier against them.", [ID.research, ID.security], [ID.research, ID.security, ID.codeDocumentation, ID.githubDeepResearch, ID.code]),
  c("CBH05", "multi", "Decide service boundaries and consistency trade-offs for an offline-first clinic system, then write the repository ADR and integration reference.", [ID.architecture, ID.codeDocumentation], [ID.architecture, ID.codeDocumentation, ID.domainModeling, ID.codebaseDesign, ID.code]),
  c("CBH06", "multi", "系统检索并筛选关于模型水印鲁棒性的论文，保留纳排记录，再检查仓库实现是否覆盖论文中的攻击条件。", [ID.systematicReview, ID.security], [ID.systematicReview, ID.security, ID.academicPaperReview, ID.research, ID.clawdefender]),
  c("CBH07", "no_skill", "What does eventual consistency mean in one paragraph?", [], [ID.architecture, ID.domainModeling, ID.codebaseDesign, ID.research, ID.codeDocumentation]),
  c("CBH08", "no_skill", "为什么 60 秒等于一分钟？", [], [ID.dataAnalysis, ID.research, ID.code, ID.chart, ID.codeDocumentation]),
  c("CBH09", "no_skill", "What is the difference between a pixel and a vector shape?", [], [ID.imageGeneration, ID.imageToCode, ID.chart, ID.research, ID.code]),
  c("CBH10", "hard_confuser", "Explain what SQL injection is; do not inspect or change any code.", [], [ID.security, ID.clawdefender, ID.code, ID.research, ID.codeDocumentation]),
  c("CBH11", "hard_confuser", "When would someone choose a line chart instead of a bar chart? Do not create an artifact.", [], [ID.chart, ID.dataAnalysis, ID.imageGeneration, ID.research, ID.codeDocumentation]),
  c("CBH12", "hard_confuser", "What is a systematic review, and how is it different from an ordinary narrative review?", [], [ID.systematicReview, ID.academicPaperReview, ID.research, ID.researchPaperWriter, ID.githubDeepResearch]),
]);

function c(
  id: string,
  slice: CandidateBudgetSelectionCase["slice"],
  query: string,
  goldSkillIds: readonly string[],
  candidateSkillIds: readonly string[],
): CandidateBudgetSelectionCase {
  return Object.freeze({ id, slice, query, goldSkillIds: Object.freeze([...goldSkillIds]), candidateSkillIds: Object.freeze([...candidateSkillIds]) });
}
