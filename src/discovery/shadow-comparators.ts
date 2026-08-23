import type {
  CandidateBudgetShadowObservation,
  CardProjectionShadowObservation,
  LightweightSkillCard,
  ShadowCandidateBudget,
  SkillCandidate,
} from "../core/contracts/index.ts";

export const SHADOW_CANDIDATE_BUDGETS = [1, 2, 3, 5] as const satisfies readonly ShadowCandidateBudget[];
export const SHADOW_DESCRIPTION_LIMITS = [120, 240, 480] as const;

export function observeCandidateBudgets(
  rankedCandidates: readonly SkillCandidate[],
): CandidateBudgetShadowObservation {
  return {
    variants: SHADOW_CANDIDATE_BUDGETS.map((budget) => ({
      budget,
      candidateSkillIds: rankedCandidates.slice(0, budget).map((candidate) => candidate.skillId),
    })),
  };
}

function truncateUtf16(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let truncated = value.slice(0, maxChars);
  const final = truncated.charCodeAt(truncated.length - 1);
  if (final >= 0xd800 && final <= 0xdbff) truncated = truncated.slice(0, -1);
  return truncated;
}

/** 只投影作者 description；不生成摘要、不写 hint、不覆盖 SkillCandidate。 */
export function projectLightweightCards(
  candidates: readonly SkillCandidate[],
  maxDescriptionChars: number,
): LightweightSkillCard[] {
  if (!Number.isInteger(maxDescriptionChars) || maxDescriptionChars < 1) {
    throw new Error("card_projection_limit_must_be_positive_integer");
  }
  return candidates.map((candidate) => ({
    skillId: candidate.skillId,
    skillRevision: candidate.skillRevision,
    name: candidate.name,
    displayDescription: truncateUtf16(candidate.description, maxDescriptionChars),
  }));
}

export function observeCardProjections(
  candidates: readonly SkillCandidate[],
): CardProjectionShadowObservation {
  return {
    baselineDescriptionChars: candidates.reduce((sum, candidate) => sum + candidate.description.length, 0),
    variants: SHADOW_DESCRIPTION_LIMITS.map((maxDescriptionChars) => {
      const cards = projectLightweightCards(candidates, maxDescriptionChars);
      return {
        maxDescriptionChars,
        totalDescriptionChars: cards.reduce((sum, card) => sum + card.displayDescription.length, 0),
        truncatedCandidateCount: candidates.filter((candidate) => candidate.description.length > maxDescriptionChars).length,
      };
    }),
  };
}
