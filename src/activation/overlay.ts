/**
 * Phase 6 host —— active discovery overlay seam（纯函数）。
 *
 * 把多个 active ActivationProfile 的 learned overlay 软重排到静态 BM25 候选上，
 * 供真实 discovery 路径（adapters/pi/core.ts）在 `index.search` 后调用。与
 * rerankWithOverlay（单 profile，evaluate.ts 用）互补：
 *
 * - 只对 `status === "active"` 且 `parentSkillId === candidate.skillId` 且
 *   `parentSkillRevision === candidate.skillRevision` 的候选生效（revision 匹配硬约束）；
 * - nearMiss 只降权，绝不硬过滤/移除候选；
 * - 关闭（无 active profile / 无 boost）⇒ 返回静态候选的浅拷贝（元素对象不变），
 *   与 rerankWithOverlay 的 overlay-off 语义一致（无损回静态可复现）；
 * - 排序 score 降序 + skillId 升序稳定 tie-break；候选集有界不变（不扩展全量）。
 *
 * 边界：不写 store、不调 LLM、不修改静态 discovery 索引。
 */
import type { ActivationProfile, SkillCandidate } from "../core/contracts/index.ts";
import {
  DEFAULT_RERANK_OPTIONS,
  matchLearnedOverlay,
  type RerankOptions,
} from "./rerank.ts";

/** 只包含 active profile 的派生检索结构；不持久化、不包含任务 query。 */
export interface ActiveProfileOverlaySnapshot {
  readonly activeBySkill: ReadonlyMap<string, ActivationProfile>;
}

/**
 * 只对实际影响 rerank 的 active 内容生成稳定 fingerprint。
 * evidenceIds、environmentCues 与时间戳不参与 rerank，因此不触发派生结构重建。
 */
export function fingerprintActiveProfiles(profiles: readonly ActivationProfile[]): string {
  return JSON.stringify(
    profiles
      .filter((profile) => profile.status === "active")
      .map((profile) => ({
        profileId: profile.profileId,
        parentSkillId: profile.parentSkillId,
        parentSkillRevision: profile.parentSkillRevision,
        learnedAliases: profile.learnedAliases.map(({ cueId, text }) => ({ cueId, text })),
        positiveExamples: profile.positiveExamples.map(({ cueId, features }) => ({ cueId, features })),
        nearMissExamples: profile.nearMissExamples.map(({ cueId, features }) => ({ cueId, features })),
      })),
  );
}

export function buildActiveProfileOverlaySnapshot(
  profiles: readonly ActivationProfile[],
): ActiveProfileOverlaySnapshot {
  const activeBySkill = new Map<string, ActivationProfile>();
  for (const profile of profiles) {
    if (profile.status !== "active") continue;
    activeBySkill.set(profile.parentSkillId, profile);
  }
  return { activeBySkill };
}

/**
 * 对静态候选应用 active profiles 的 learned overlay（多 profile，每父 Skill 一条）。
 * 只有 revision 匹配的 active profile 才影响 discovery；其余候选保持静态分数。
 */
export function applyActiveProfiles(
  staticCandidates: readonly SkillCandidate[],
  profiles: readonly ActivationProfile[],
  query: string,
  options: RerankOptions = {},
): SkillCandidate[] {
  return applyActiveProfileSnapshot(
    staticCandidates,
    buildActiveProfileOverlaySnapshot(profiles),
    query,
    options,
  );
}

/** 对已派生的 active profile snapshot 应用 rerank；供 query 路径复用缓存。 */
export function applyActiveProfileSnapshot(
  staticCandidates: readonly SkillCandidate[],
  snapshot: ActiveProfileOverlaySnapshot,
  query: string,
  options: RerankOptions = {},
): SkillCandidate[] {
  const opts = { ...DEFAULT_RERANK_OPTIONS, ...options };
  const activeBySkill = snapshot.activeBySkill;
  const overlayEnabled =
    activeBySkill.size > 0 &&
    (opts.aliasBoost > 0 || opts.positiveBoost > 0 || opts.nearMissPenalty > 0);

  // 关闭 overlay：与静态 discovery 完全一致（可复现，无损回静态）。
  if (!overlayEnabled) return [...staticCandidates];

  const rescored: Array<{
    candidate: SkillCandidate;
    score: number;
    learnedCueIds: readonly string[];
  }> = [];

  for (const candidate of staticCandidates) {
    const profile = activeBySkill.get(candidate.skillId);
    // revision 匹配硬约束：profile 的父 revision ≠ 候选 revision ⇒ 不生效（stale profile
    // 不得影响当次 discovery）。
    if (profile === undefined || profile.parentSkillRevision !== candidate.skillRevision) {
      rescored.push({ candidate, score: candidate.retrievalScore, learnedCueIds: [] });
      continue;
    }
    const match = matchLearnedOverlay(query, profile);
    const score =
      candidate.retrievalScore +
      opts.aliasBoost * match.aliasCueIds.length +
      opts.positiveBoost * match.positiveCueIds.length -
      opts.nearMissPenalty * match.nearMissCueIds.length;
    // alias/positive 命中追加 learned_cue evidence；nearMiss 只降权，不附加命中证据。
    rescored.push({
      candidate,
      score,
      learnedCueIds: [...match.aliasCueIds, ...match.positiveCueIds],
    });
  }

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
    const existing = new Set(
      candidate.evidence.map((evidence) => (evidence.kind === "learned_cue" ? evidence.cueId : "")),
    );
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
