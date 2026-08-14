/**
 * Deterministic, reproducible tokenization for local BM25 discovery.
 *
 * - Latin/digit words: NFKC-normalized and lowercased, each maximal run of
 *   `[\p{L}\p{N}]` is emitted as one token; English stopwords are dropped.
 * - CJK ideographs: a maximal run of CJK characters is emitted as overlapping
 *   bigrams; a single CJK character is emitted as-is (never a stopword).
 *
 * This is pure and side-effect-free. Cross-language recall (e.g. Chinese query
 * over an English description) is intentionally NOT solved here: it relies on
 * author-declared aliases (see ADR-0007), not on tokenizer magic.
 */

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0x20000, 0x2ffff], // CJK Unified Ideographs Extension B+ (supplementary plane)
];

function isCjk(codePoint: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * Minimal, explicit, deterministic English stopword set. Applied only to latin
 * tokens; no category hard gates and no LLM are involved. Kept deliberately
 * small to avoid over-filtering content words.
 */
export const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "be",
  "my",
  "you",
  "your",
  "how",
]);

export function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];

  let latin = "";
  let cjk: string[] = [];

  const flushLatin = (): void => {
    if (latin.length > 0 && !ENGLISH_STOPWORDS.has(latin)) {
      tokens.push(latin);
    }
    latin = "";
  };

  const flushCjk = (): void => {
    if (cjk.length === 0) return;
    if (cjk.length === 1) {
      tokens.push(cjk[0]!);
    } else {
      for (let i = 0; i < cjk.length - 1; i += 1) {
        tokens.push(cjk[i]! + cjk[i + 1]!);
      }
    }
    cjk = [];
  };

  for (const ch of normalized) {
    const codePoint = ch.codePointAt(0)!;
    if (isCjk(codePoint)) {
      flushLatin();
      cjk.push(ch);
    } else if (WORD_CHAR_RE.test(ch)) {
      flushCjk();
      latin += ch;
    } else {
      flushLatin();
      flushCjk();
    }
  }

  flushLatin();
  flushCjk();
  return tokens;
}
