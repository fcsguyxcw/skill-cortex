/**
 * Human-authored synthetic skill fixtures for Phase 1 smoke evaluation.
 *
 * These are NOT real user skills, NOT scraped from any agent's past choices,
 * and contain no secrets or user data. Gold labels in `cases.ts` are assigned
 * by hand here, independent of retrieval output (ADR-0005: no self-verification).
 */

import type { SkillRecord } from "../../core/contracts/index.ts";

function mk(
  skillId: string,
  name: string,
  description: string,
  aliases: string[],
  scope: SkillRecord["scope"] = "user",
): SkillRecord {
  return {
    schemaVersion: 1,
    skillId,
    skillRevision: `rev:${skillId}`,
    name,
    description,
    scope,
    sourceLocator: `fixture://${skillId}`,
    sourceHash:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    disableModelInvocation: false,
    declaredAliases: aliases,
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2026-08-14T00:00:00.000Z",
  };
}

export const SKILL_FIXTURES: SkillRecord[] = [
  mk(
    "pdf",
    "pdf",
    "Read, extract text and tables from PDF documents, merge and split PDF files.",
    ["PDF 处理", "pdf 文档"],
  ),
  mk(
    "docx",
    "docx",
    "Create, read and edit Word documents including tracked changes and comments.",
    ["word 文档"],
  ),
  mk(
    "xlsx",
    "xlsx",
    "Read and create Excel spreadsheets, recalculate formulas, and validate workbook structure.",
    ["excel 表格", "电子表格"],
  ),
  mk(
    "chart-visualization",
    "chart-visualization",
    "Generate charts and data visualizations from tabular data.",
    ["图表可视化", "画图", "数据可视化"],
  ),
  mk(
    "frontend-design",
    "frontend-design",
    "Build polished web interfaces with React, HTML and CSS.",
    ["网页设计", "前端设计"],
  ),
  mk(
    "data-analysis",
    "data-analysis",
    "Analyze CSV and Excel data, produce statistics and summaries.",
    ["数据分析", "统计分析"],
  ),
  mk(
    "image-generation",
    "image-generation",
    "Generate images from text prompts using a diffusion model.",
    ["文生图", "图片生成"],
  ),
  mk(
    "code-review",
    "code-review",
    "Review code changes for bugs, style and security issues.",
    ["代码审查", "代码评审"],
  ),
];
