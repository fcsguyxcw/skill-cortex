/**
 * Phase 6 第二批 —— shadow rerank（纯函数，软重排；不做硬负过滤，不做 active）。
 *
 * plan §11 任务 3/4 + 数据合同 §4.3：
 * - learned cue（learnedAliases / positiveExamples）命中 query ⇒ soft boost 分数 +
 *   追加 `{ kind: "learned_cue", cueId }` evidence（只作用于 profile 绑定的父 skill）；
 * - nearMissExamples 命中 ⇒ 仅 soft 降权（down-rank），**绝不硬过滤、绝不移除**；
 * - 关闭 overlay（无 profile 或全部 boost=0）⇒ 输出与静态 BM25 discovery **完全一致**
 *   （元素对象不变、分数/evidence 不变，可复现）；
 * - 排序与静态一致：score 降序 + skillId 升序稳定 tie-break；候选集有界不变（不扩展全量）。
 *
 * 边界：不写 store、不调 LLM、不修改静态 discovery 索引、不做 active promotion。
 */
import type { ActivationProfile, SkillCandidate } from "../core/contracts/index.ts";
import { tokenize } from "../discovery/tokenize.ts";

export interface RerankOptions {
  /** learned alias 命中的分数加成（默认 0 = 不启用）。 */
  aliasBoost?: number;
  /** positive example 特征命中的分数加成（默认 0）。 */
  positiveBoost?: number;
  /** near-miss 特征命中的降权（正数 ⇒ 扣分；默认 0 = 不启用）。 */
  nearMissPenalty?: number;
}

export interface LearnedOverlayMatch {
  aliasCueIds: readonly string[];
  positiveCueIds: readonly string[];
  nearMissCueIds: readonly string[];
}

export const DEFAULT_RERANK_OPTIONS: Required<RerankOptions> = {
  aliasBoost: 0,
  positiveBoost: 0,
  nearMissPenalty: 0,
};

function termsOverlap(queryTerms: ReadonlySet<string>, text: string): boolean {
  return tokenize(text).some((term) => queryTerms.has(term));
}

function featuresOverlap(
  queryTerms: ReadonlySet<string>,
  features: readonly string[],
): boolean {
  for (const feature of features) {
    if (termsOverlap(queryTerms, feature)) return true;
  }
  return false;
}

/** 计算 profile（其父 skill）对 query 的 learned overlay 命中（导出供评估/测试）。 */
export function matchLearnedOverlay(
  query: string,
  profile: ActivationProfile,
): LearnedOverlayMatch {
  const queryTerms = new Set(tokenize(query));
  return {
    aliasCueIds: profile.learnedAliases
      .filter((alias) => termsOverlap(queryTerms, alias.text))
      .map((alias) => alias.cueId),
    positiveCueIds: profile.positiveExamples
      .filter((example) => featuresOverlap(queryTerms, example.features))
      .map((example) => example.cueId),
    nearMissCueIds: profile.nearMissExamples
      .filter((example) => featuresOverlap(queryTerms, example.features))
      .map((example) => example.cueId),
  };
}

/**
 * 软重排：静态候选 + draft ActivationProfile → 重排候选。
 * - 关闭 overlay ⇒ 返回静态候选浅拷贝（元素对象不变，deepEqual 静态结果）；
 * - overlay 启用 ⇒ 只对 profile.parentSkillId 的候选加分/追加 learned_cue evidence；
 *   near-miss 只扣分（降权），候选保留；
 * - 返回新候选对象（不改静态输入），排序 score 降序 + skillId 升序。
 */
export function rerankWithOverlay(
  staticCandidates: readonly SkillCandidate[],
  profile: ActivationProfile | undefined,
  query: string,
  options: RerankOptions = {},
): SkillCandidate[] {
  const opts = { ...DEFAULT_RERANK_OPTIONS, ...options };
  const overlayEnabled =
    profile !== undefined &&
    (opts.aliasBoost > 0 || opts.positiveBoost > 0 || opts.nearMissPenalty > 0);

  // 关闭 overlay：与静态 discovery 完全一致（可复现）。
  if (!overlayEnabled) return [...staticCandidates];

  const queryTerms = new Set(tokenize(query));
  const rescored: Array<{
    candidate: SkillCandidate;
    score: number;
    learnedCueIds: readonly string[];
  }> = [];

  for (const candidate of staticCandidates) {
    let score = candidate.retrievalScore;
    const learnedCueIds: string[] = [];
    if (profile !== undefined && candidate.skillId === profile.parentSkillId) {
      const match = matchLearnedOverlay(query, profile);
      score += opts.aliasBoost * match.aliasCueIds.length;
      score += opts.positiveBoost * match.positiveCueIds.length;
      score -= opts.nearMissPenalty * match.nearMissCueIds.length;
      // alias/positive 命中追加为 learned_cue evidence；nearMiss 只降权，不附加命中证据。
      learnedCueIds.push(...match.aliasCueIds, ...match.positiveCueIds);
    }
    rescored.push({ candidate, score, learnedCueIds });
  }

  // 稳定排序：score 降序 + skillId 升序（与 BM25 排序一致，确定性）。
  rescored.sort(
    (left, right) =>
      right.score - left.score ||
      (left.candidate.skillId < right.candidate.skillId
        ? -1
        : left.candidate.skillId > right.candidate.skillId
          ? 1
          : 0),
  );

  return rescored.map(({ candidate, score, learnedCueIds }) => {
    const existing = new Set(candidate.evidence.map((evidence) => {
      return evidence.kind === "learned_cue" ? evidence.cueId : "";
    }));
    const extra = learnedCueIds.filter((cueId) => !existing.has(cueId));
    return {
      ...candidate,
      retrievalScore: score,
      evidence: [
        ...candidate.evidence,
        ...extra.map((cueId) => ({ kind: "learned_cue" as const, cueId })),
      ],
    };
  });
}
