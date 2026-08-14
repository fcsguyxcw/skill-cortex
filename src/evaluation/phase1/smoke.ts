/**
 * Phase 1 smoke evaluation harness.
 *
 * Builds a local BM25 index over the synthetic fixtures, runs the hand-labelled
 * cases, and reports Recall@K, set recall, no-skill accuracy, candidate
 * injection size (chars + estimated tokens), index build time, query p50/p95,
 * and routerLlmCalls. The output is a smoke signal only — it makes NO
 * statistical generalization claim (ADR-0005 / plan §4).
 *
 * Boundary note: the `zh_alias` case uses a synthetic author-declared alias
 * ("画图") hand-written into the fixture SkillRecord. It demonstrates only that
 * a Chinese query can match an explicitly declared alias; it does NOT prove that
 * the real Pi adapter has parsed aliases out of an installed SKILL.md frontmatter
 * — that is adapter-ingest behavior, outside this discovery module.
 */

import { buildIndex, formatCandidateCards } from "../../discovery/index.ts";
import type { SkillCandidate } from "../../core/contracts/index.ts";
import { SKILL_FIXTURES } from "./fixtures.ts";
import { EVAL_CASES, type EvalCase } from "./cases.ts";

export const TOP_K = 5;
/** Structural invariant: discovery is pure local BM25, zero LLM calls. */
export const ROUTER_LLM_CALLS = 0;

export interface CaseResult {
  caseId: string;
  labelType: EvalCase["labelType"];
  language: EvalCase["language"];
  goldSkillIds: string[];
  retrievedSkillIds: string[];
  injectionChars: number;
  estimatedTokens: number;
  queryLatencyMs: number;
}

export interface SmokeReport {
  catalogSize: number;
  topK: number;
  routerLlmCalls: number;
  recallAtK: number;
  setRecall: number;
  noSkillAccuracy: number;
  indexBuildMs: number;
  queryP50Ms: number;
  queryP95Ms: number;
  totalInjectionChars: number;
  totalEstimatedTokens: number;
  maxRetrievedCount: number;
  cases: CaseResult[];
}

/** Naive token estimate: ~4 chars/token for mostly-ASCII prompt text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index]!;
}

export function runSmoke(): SmokeReport {
  const indexBuildStart = performance.now();
  const index = buildIndex(SKILL_FIXTURES);
  const indexBuildMs = performance.now() - indexBuildStart;

  const results: CaseResult[] = [];
  for (const c of EVAL_CASES) {
    const queryStart = performance.now();
    const candidates: SkillCandidate[] = index.search(c.query, { limit: TOP_K });
    const queryLatencyMs = performance.now() - queryStart;

    const cardText = formatCandidateCards(candidates);
    results.push({
      caseId: c.id,
      labelType: c.labelType,
      language: c.language,
      goldSkillIds: [...c.goldSkillIds],
      retrievedSkillIds: candidates.map((x) => x.skillId),
      injectionChars: cardText.length,
      estimatedTokens: estimateTokens(cardText),
      queryLatencyMs,
    });
  }

  const hasSkill = results.filter((r) => r.labelType !== "no-skill");
  const noSkill = results.filter((r) => r.labelType === "no-skill");

  const recallHits = hasSkill.filter((r) =>
    r.goldSkillIds.every((g) => r.retrievedSkillIds.includes(g)),
  ).length;
  const recallAtK = hasSkill.length > 0 ? recallHits / hasSkill.length : 0;

  const setRecall =
    hasSkill.length > 0
      ? hasSkill.reduce((sum, r) => {
          if (r.goldSkillIds.length === 0) return sum;
          const hits = r.goldSkillIds.filter((g) =>
            r.retrievedSkillIds.includes(g),
          ).length;
          return sum + hits / r.goldSkillIds.length;
        }, 0) / hasSkill.length
      : 0;

  const noSkillHits = noSkill.filter((r) => r.retrievedSkillIds.length === 0)
    .length;
  const noSkillAccuracy =
    noSkill.length > 0 ? noSkillHits / noSkill.length : 0;

  const latencies = results.map((r) => r.queryLatencyMs).sort((a, b) => a - b);

  return {
    catalogSize: SKILL_FIXTURES.length,
    topK: TOP_K,
    routerLlmCalls: ROUTER_LLM_CALLS,
    recallAtK,
    setRecall,
    noSkillAccuracy,
    indexBuildMs,
    queryP50Ms: percentile(latencies, 0.5),
    queryP95Ms: percentile(latencies, 0.95),
    totalInjectionChars: results.reduce((s, r) => s + r.injectionChars, 0),
    totalEstimatedTokens: results.reduce((s, r) => s + r.estimatedTokens, 0),
    maxRetrievedCount: Math.max(0, ...results.map((r) => r.retrievedSkillIds.length)),
    cases: results,
  };
}
