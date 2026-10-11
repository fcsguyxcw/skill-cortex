import type { SkillCandidate, SkillRecord } from "../core/contracts/index.ts";
import { buildIndex, type Bm25Params, type DiscoveryIndex, type SearchOptions } from "./bm25.ts";

export interface QueryExpansionRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly addedTerms: readonly string[];
}

export interface QueryExpansionTrace {
  readonly originalQuery: string;
  readonly expandedQuery: string;
  readonly matchedRuleIds: readonly string[];
  readonly addedTerms: readonly string[];
}

export interface ExpandedDiscoveryIndex extends DiscoveryIndex {
  expand(query: string): QueryExpansionTrace;
  searchWithTrace(
    query: string,
    options?: SearchOptions,
  ): { readonly candidates: SkillCandidate[]; readonly expansion: QueryExpansionTrace };
}

/** Static, action-oriented Chinese-to-English retrieval baseline. */
export const DEFAULT_QUERY_EXPANSION_RULES: readonly QueryExpansionRule[] = Object.freeze([
  rule("zh_architecture", /(?:设计|比较|规划|评审).{0,12}(?:架构|系统方案)|架构.{0,10}(?:设计|决策|取舍|评审)|\badr\b/i, ["architecture", "system design", "architectural decision", "ADR"]),
  rule("zh_systematic_literature_review", /系统(?:性)?文献综述|文献综述|多篇论文|跨论文|纳排标准/, ["systematic literature review", "multiple papers", "cross-paper synthesis"]),
  rule("zh_chart_visualization", /(?:绘制|生成|制作|画).{0,12}(?:图表|柱状图|折线图|饼图|雷达图|极坐标图|可视化)|数据可视化/, ["chart visualization", "generate chart image", "visualize data"]),
  rule("zh_security_audit", /安全审计|安全漏洞|漏洞风险|认证安全|注入风险|密钥泄露/, ["security audit", "security vulnerabilities", "authentication secrets code review"]),
  rule("zh_route_planning", /路线规划|规划.{0,6}路线|附近.{0,8}(?:地点|门店|餐厅|咖啡|酒店)|步行.{0,8}(?:路线|到达)|\bpoi\b/i, ["map POI search", "nearby places", "walking route planning"]),
  rule("zh_video_frames", /(?:抽取|提取|截取|导出).{0,8}(?:视频帧|帧|画面)|从.{0,8}视频.{0,8}(?:抽帧|提取帧|截图)/, ["extract video frames", "video frame", "ffmpeg"]),
  rule("zh_image_generation", /(?:生成|创作|制作|绘制).{0,8}(?:图片|图像|插图|海报|配图)/, ["image generation", "generate image", "visual content"]),
  rule("zh_text_to_speech", /(?:生成|制作|导出|合成).{0,8}(?:配音|旁白|语音|音频)|文字转语音/, ["text to speech", "voiceover", "audio narration"]),
  rule("zh_video_generation", /(?:生成|制作|创建).{0,8}(?:视频|宣传片|短片)/, ["video generation", "generate video", "promotional video"]),
  rule("zh_code_documentation", /(?:编写|生成|整理|更新).{0,12}(?:api\s*文档|代码文档|开发者文档|变更说明|迁移说明|readme)/i, ["code documentation", "API documentation", "developer guide", "changelog"]),
  rule("zh_primary_source_research", /(?:查阅|核验|调研|检索).{0,20}(?:官方|一手资料|来源|文档)|只使用一手资料/, ["research primary sources", "official documentation", "gather API facts", "Markdown"]),
  rule("zh_data_analysis", /(?:分析|统计|计算).{0,15}(?:数据|均值|百分位|p95|趋势)|对.{0,8}数据.{0,8}(?:分析|统计)/i, ["data analysis", "statistics", "structured data", "aggregation"]),
  rule("zh_pdf_operation", /(?:处理|旋转|合并|拆分|加水印|提取).{0,10}pdf|pdf.{0,10}(?:处理|旋转|合并|拆分|加水印|提取)/i, ["PDF documents", "PDF operation", "extract PDF"]),
  rule("zh_spreadsheet_artifact", /(?:生成|创建|修复|编辑|导出).{0,10}(?:excel|xlsx|工作簿|电子表格)/i, ["XLSX spreadsheet workbook", "Excel formulas formatting"]),
]);

export function expandQuery(
  query: string,
  rules: readonly QueryExpansionRule[] = DEFAULT_QUERY_EXPANSION_RULES,
): QueryExpansionTrace {
  const addedTerms: string[] = [];
  const matchedRuleIds: string[] = [];
  const seenTerms = new Set<string>();
  for (const item of rules) {
    if (!item.pattern.test(query)) continue;
    matchedRuleIds.push(item.id);
    for (const term of item.addedTerms) {
      const key = term.normalize("NFKC").toLowerCase();
      if (seenTerms.has(key)) continue;
      seenTerms.add(key);
      addedTerms.push(term);
    }
  }
  return {
    originalQuery: query,
    expandedQuery: addedTerms.length === 0 ? query : `${query} ${addedTerms.join(" ")}`,
    matchedRuleIds,
    addedTerms,
  };
}

export function buildQueryExpansionIndex(
  records: readonly SkillRecord[],
  params?: Bm25Params,
  rules: readonly QueryExpansionRule[] = DEFAULT_QUERY_EXPANSION_RULES,
): ExpandedDiscoveryIndex {
  const baseline = buildIndex(records, params);
  const expand = (query: string): QueryExpansionTrace => expandQuery(query, rules);
  const searchWithTrace = (query: string, options?: SearchOptions) => {
    const expansion = expand(query);
    return { candidates: baseline.search(expansion.expandedQuery, options), expansion };
  };
  return {
    size: baseline.size,
    expand,
    search: (query, options) => searchWithTrace(query, options).candidates,
    searchWithTrace,
  };
}

function rule(id: string, pattern: RegExp, addedTerms: readonly string[]): QueryExpansionRule {
  return Object.freeze({ id, pattern, addedTerms: Object.freeze([...addedTerms]) });
}
