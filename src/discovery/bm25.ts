/**
 * Pure local, deterministic BM25 discovery over `SkillRecord`.
 *
 * The index reads ONLY the author-declared `name`, full `description`, and
 * `declaredAliases` of each record (plus the identity/scope fields needed to
 * build a `SkillCandidate`). It never reads usage counts, procedures,
 * maturity, execution cost, effects, permissions, or calls any LLM.
 *
 * Ranking: score descending, then `skillId` ascending as a stable tie-break.
 * Results are bounded to at most `MAX_TOP_K` candidates; an empty or
 * no-match query returns an empty array and never falls back to the full
 * catalog.
 */

import type { SkillCandidate, SkillRecord } from "../core/contracts/index.ts";
import { tokenize } from "./tokenize.ts";

export const DEFAULT_TOP_K = 5;
export const MAX_TOP_K = 10;

export interface Bm25Params {
  /** Term-frequency saturation (k1). */
  k1: number;
  /** Length normalization (b). */
  b: number;
}

export const DEFAULT_BM25_PARAMS: Bm25Params = { k1: 1.2, b: 0.75 };

type MatchField = "name" | "description" | "alias";

interface IndexedDoc {
  record: SkillRecord;
  docLength: number;
  termCounts: Map<string, number>;
  termFields: Map<string, Set<MatchField>>;
}

export interface SearchOptions {
  /** Requested candidate budget; clamped to `[1, MAX_TOP_K]`. */
  limit?: number;
}

export interface DiscoveryIndex {
  /** Number of records indexed. */
  readonly size: number;
  /** Bounded Top-K search. Empty/no-match query returns `[]`. */
  search(query: string, options?: SearchOptions): SkillCandidate[];
}

const FIELD_ORDER: readonly MatchField[] = ["name", "description", "alias"];

export function buildIndex(
  records: readonly SkillRecord[],
  params: Bm25Params = DEFAULT_BM25_PARAMS,
): DiscoveryIndex {
  const docs: IndexedDoc[] = [];
  const docFrequency = new Map<string, number>();
  let totalLength = 0;

  for (const record of records) {
    const termCounts = new Map<string, number>();
    const termFields = new Map<string, Set<MatchField>>();
    let docLength = 0;

    const addField = (field: MatchField, text: string): void => {
      for (const term of tokenize(text)) {
        termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
        let fields = termFields.get(term);
        if (fields === undefined) {
          fields = new Set();
          termFields.set(term, fields);
        }
        fields.add(field);
        docLength += 1;
      }
    };

    addField("name", record.name);
    addField("description", record.description);
    for (const alias of record.declaredAliases) {
      addField("alias", alias);
    }

    docs.push({ record, docLength, termCounts, termFields });
    totalLength += docLength;

    for (const term of termCounts.keys()) {
      docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1);
    }
  }

  const docCount = docs.length;
  const avgDocLength = docCount > 0 ? totalLength / docCount : 0;

  function search(query: string, options: SearchOptions = {}): SkillCandidate[] {
    const limit = clampLimit(options.limit);
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0) return [];

    const scored: Array<{ score: number; doc: IndexedDoc }> = [];
    for (const doc of docs) {
      let score = 0;
      for (const term of queryTerms) {
        const df = docFrequency.get(term);
        const tf = doc.termCounts.get(term);
        if (df === undefined || tf === undefined) continue;
        const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
        const lengthRatio = avgDocLength > 0 ? doc.docLength / avgDocLength : 0;
        const denominator = tf + params.k1 * (1 - params.b + params.b * lengthRatio);
        score += idf * ((tf * (params.k1 + 1)) / denominator);
      }
      if (score > 0 && passesLexicalRelevanceGuard(doc, queryTerms)) {
        scored.push({ score, doc });
      }
    }

    scored.sort(
      (left, right) =>
        right.score - left.score ||
        (left.doc.record.skillId < right.doc.record.skillId
          ? -1
          : left.doc.record.skillId > right.doc.record.skillId
            ? 1
            : 0),
    );

    return scored
      .slice(0, limit)
      .map(({ score, doc }) => toCandidate(doc, score, queryTerms));
  }

  return { size: docCount, search };
}

/**
 * Lexical relevance guard.
 *
 * A candidate is recalled only when the query matches its author-declared
 * `name` or an alias, OR matches at least two distinct description terms. A
 * single common content word shared only with a description (e.g. "create")
 * is not enough to recall a skill.
 *
 * This is a lexical relevance guard ONLY: it reads author-declared
 * name/description/aliases and never reads maturity, usage, procedures, or
 * execution cost, and it calls no LLM.
 */
function passesLexicalRelevanceGuard(
  doc: IndexedDoc,
  queryTerms: readonly string[],
): boolean {
  let nameOrAliasHits = 0;
  let descriptionHits = 0;
  for (const term of queryTerms) {
    const fields = doc.termFields.get(term);
    if (fields === undefined) continue;
    if (fields.has("name") || fields.has("alias")) nameOrAliasHits += 1;
    if (fields.has("description")) descriptionHits += 1;
  }
  return nameOrAliasHits >= 1 || descriptionHits >= 2;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_TOP_K;
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(Math.floor(limit), MAX_TOP_K);
}

function toCandidate(
  doc: IndexedDoc,
  score: number,
  queryTerms: readonly string[],
): SkillCandidate {
  const matched = new Set<MatchField>();
  for (const term of queryTerms) {
    const fields = doc.termFields.get(term);
    if (fields !== undefined) {
      for (const field of fields) matched.add(field);
    }
  }

  const evidence = FIELD_ORDER.filter((field) => matched.has(field)).map(
    (field) => ({ kind: "declared_text" as const, field }),
  );

  return {
    skillId: doc.record.skillId,
    skillRevision: doc.record.skillRevision,
    name: doc.record.name,
    description: doc.record.description,
    scope: doc.record.scope,
    retrievalScore: score,
    evidence,
  };
}
