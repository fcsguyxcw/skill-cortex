import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ENGLISH_STOPWORDS, tokenize } from "./tokenize.ts";

describe("tokenize", () => {
  it("lowercases latin words and drops punctuation", () => {
    assert.deepEqual(tokenize("Hello, World!"), ["hello", "world"]);
    assert.deepEqual(tokenize("PDF"), ["pdf"]);
  });

  it("NFKC-normalizes full-width characters", () => {
    assert.deepEqual(tokenize("ＰＤＦ"), ["pdf"]);
  });

  it("splits hyphenated identifiers into word tokens", () => {
    assert.deepEqual(tokenize("frontend-design"), ["frontend", "design"]);
  });

  it("emits overlapping CJK bigrams", () => {
    assert.deepEqual(tokenize("可视化"), ["可视", "视化"]);
  });

  it("emits a single CJK character as-is", () => {
    assert.deepEqual(tokenize("图"), ["图"]);
  });

  it("handles mixed latin + CJK runs", () => {
    assert.deepEqual(tokenize("图表chart"), ["图表", "chart"]);
    assert.deepEqual(tokenize("PDF 处理"), ["pdf", "处理"]);
  });

  it("returns empty for empty or punctuation-only input", () => {
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize("   !!! "), []);
  });

  it("drops explicit English stopwords", () => {
    assert.deepEqual(tokenize("how are you"), []);
    assert.deepEqual(tokenize("read and write"), ["read", "write"]);
    assert.deepEqual(
      tokenize("the a an to of in on for with or is be my your"),
      [],
    );
  });

  it("keeps CJK tokens (never stopwords)", () => {
    assert.deepEqual(tokenize("画图"), ["画图"]);
  });

  it("exposes the required minimal stopword set", () => {
    const required = [
      "a", "an", "the", "and", "or", "to", "of", "in", "on",
      "for", "with", "is", "are", "be", "my", "you", "your", "how",
    ];
    for (const word of required) {
      assert.ok(ENGLISH_STOPWORDS.has(word), `missing stopword: ${word}`);
    }
  });

  it("is deterministic", () => {
    const text = "可视化 chart PDF 处理";
    assert.deepEqual(tokenize(text), tokenize(text));
  });
});
