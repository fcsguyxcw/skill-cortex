/**
 * Human-explicit smoke cases with hand-assigned gold labels.
 *
 * Labels are authored to exercise the ADR-0007 baseline classes. They are NOT
 * produced by running the retriever or by any agent's runtime selection, so
 * they carry no self-verification bias (ADR-0005).
 */

export type LabelType = "single" | "multi" | "no-skill";
export type Language = "en" | "zh" | "mixed";

export interface EvalCase {
  id: string;
  query: string;
  labelType: LabelType;
  goldSkillIds: string[];
  language: Language;
  note: string;
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: "single_en_pdf",
    query: "merge two PDF files",
    labelType: "single",
    goldSkillIds: ["pdf"],
    language: "en",
    note: "直接单技能：merge/pdf 明确命中 pdf",
  },
  {
    id: "single_en_fuzzy_name",
    query: "chart drawing",
    labelType: "single",
    goldSkillIds: ["chart-visualization"],
    language: "en",
    note: "模糊名称：以近名词 chart 命中 chart-visualization，非完整名称",
  },
  {
    id: "multi_complementary",
    query: "analyze the data and generate a chart",
    labelType: "multi",
    goldSkillIds: ["data-analysis", "chart-visualization"],
    language: "en",
    note: "互补多技能：数据分析 + 图表生成",
  },
  {
    id: "no_skill_out_of_domain",
    query: "book a flight to tokyo",
    labelType: "no-skill",
    goldSkillIds: [],
    language: "en",
    note: "域外任务，不应召回任何技能",
  },
  {
    id: "no_skill_greeting",
    query: "hello, how are you today",
    labelType: "no-skill",
    goldSkillIds: [],
    language: "en",
    note: "问候，不应召回任何技能",
  },
  {
    id: "no_skill_shared_content_word",
    query: "create a report for the team",
    labelType: "no-skill",
    goldSkillIds: [],
    language: "en",
    note: "query 与 docx/xlsx 的 description 共享通用内容词 create，但单个描述词低于 lexical guard，不应召回",
  },
  {
    id: "zh_alias",
    query: "帮我画图",
    labelType: "single",
    goldSkillIds: ["chart-visualization"],
    language: "zh",
    note: "中文 query 经 synthetic 作者显式 alias「画图」命中英文 description 的技能；不证明真实 Pi adapter 已解析 installed SKILL.md 的 aliases",
  },
  {
    id: "hard_confuser_xlsx",
    query: "recalculate the formulas in my Excel workbook",
    labelType: "single",
    goldSkillIds: ["xlsx"],
    language: "en",
    note: "hard confuser：xlsx 与 data-analysis 均含 Excel，recalculate/formulas 区分",
  },
  {
    id: "single_en_code_review",
    query: "review my code for security bugs",
    labelType: "single",
    goldSkillIds: ["code-review"],
    language: "en",
    note: "直接单技能：review/code/security 命中 code-review",
  },
];
