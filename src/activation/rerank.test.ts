/**
 * Phase 6 第二批 —— shadow rerank 测试（纯函数，软重排）。
 *
 * 覆盖：
 * - 关闭 overlay（无 profile / boost 全 0）⇒ 输出与静态 BM25 候选 deepEqual（可复现）；
 * - learned alias/positive 命中 ⇒ soft boost + 追加 learned_cue evidence（只作用于
 *   profile 父 skill）；
 * - near-miss 命中 ⇒ 仅降权（候选保留，绝不硬过滤）；
 * - 排序确定性（score 降序 + skillId 升序）；不改静态输入（不可变）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActivationProfile, SkillCandidate, SkillRecord } from "../core/contracts/index.ts";
import { buildIndex } from "../discovery/bm25.ts";
import { matchLearnedOverlay, rerankWithOverlay } from "./index.ts";

const GOLD_ID = "skill:" + "a".repeat(64);
const CONFUSER_ID = "skill:" + "b".repeat(64);
const OTHER_ID = "skill:" + "c".repeat(64);
const REV = "rev:" + "1".repeat(64);

function record(id: string, name: string, description: string, aliases: string[] = []): SkillRecord {
  return {
    schemaVersion: 1,
    skillId: id,
    skillRevision: REV,
    name,
    description,
    scope: "user",
    sourceLocator: "/fixture",
    sourceHash: "sha256:" + "2".repeat(64),
    disableModelInvocation: false,
    declaredAliases: aliases,
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2026-08-14T00:00:00.000Z",
  };
}

const RECORDS: readonly SkillRecord[] = [
  record(GOLD_ID, "offset-pagination-helper", "Detect offset pagination in SQL queries and return structured findings", ["sql-pagination"]),
  record(CONFUSER_ID, "cursor-pagination-tool", "Implement cursor pagination for SQL queries with keyset pagination support"),
  record(OTHER_ID, "pdf-document-reader", "Read and merge PDF documents"),
];

function profile(overrides: Partial<ActivationProfile> = {}): ActivationProfile {
  return {
    schemaVersion: 1,
    profileId: "profile:test",
    parentSkillId: GOLD_ID,
    parentSkillRevision: REV,
    status: "draft",
    learnedAliases: [{ cueId: "cue:alias-offset", text: "offset-check", evidenceIds: ["obs-1"] }],
    positiveExamples: [
      { cueId: "cue:pos-1", features: ["prompt-hash:x", "offset-page-query"], evidenceIds: ["obs-1"] },
    ],
    nearMissExamples: [
      { cueId: "cue:nm-cursor", features: ["cursor-pagination-query"], evidenceIds: ["obs-2"] },
    ],
    environmentCues: [],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

function staticCandidates(query: string, limit = 5): SkillCandidate[] {
  return buildIndex(RECORDS).search(query, { limit });
}

describe("shadow rerank：overlay 关闭可复现", () => {
  it("无 profile ⇒ 输出与静态候选 deepEqual（元素对象不变）", () => {
    const query = "check offset pagination sql";
    const staticList = staticCandidates(query);
    const reranked = rerankWithOverlay(staticList, undefined, query);
    assert.deepEqual(reranked, staticList);
    assert.equal(reranked.length, staticList.length);
  });

  it("profile 存在但 boost 全 0 ⇒ 输出与静态候选 deepEqual（关闭 overlay 语义）", () => {
    const query = "check offset pagination sql";
    const staticList = staticCandidates(query);
    const reranked = rerankWithOverlay(staticList, profile(), query, {
      aliasBoost: 0,
      positiveBoost: 0,
      nearMissPenalty: 0,
    });
    assert.deepEqual(reranked, staticList);
  });
});

describe("shadow rerank：learned soft boost", () => {
  it("alias 命中 ⇒ 父 skill 分数提升 + 追加 learned_cue evidence；非父 skill 不受影响", () => {
    const query = "check offset pagination";
    const staticList = staticCandidates(query);
    const staticGold = staticList.find((c) => c.skillId === GOLD_ID)!;
    const reranked = rerankWithOverlay(staticList, profile(), query, { aliasBoost: 5 });
    const learnedGold = reranked.find((c) => c.skillId === GOLD_ID)!;

    assert.ok(
      learnedGold.retrievalScore > staticGold.retrievalScore,
      `learned score ${learnedGold.retrievalScore} 必须高于 static ${staticGold.retrievalScore}`,
    );
    assert.ok(
      learnedGold.evidence.some((evidence) => evidence.kind === "learned_cue" && evidence.cueId === "cue:alias-offset"),
      "必须追加 learned_cue evidence",
    );
    // 非父 skill（confuser/other）无 learned 命中：分数不变、无 learned evidence。
    for (const id of [CONFUSER_ID, OTHER_ID]) {
      const before = staticList.find((c) => c.skillId === id);
      const after = reranked.find((c) => c.skillId === id);
      if (before !== undefined && after !== undefined) {
        assert.equal(after.retrievalScore, before.retrievalScore, `${id} 不受 overlay 影响`);
        assert.ok(!after.evidence.some((e) => e.kind === "learned_cue"), `${id} 不得有 learned evidence`);
      }
    }
  });

  it("positive 特征命中 ⇒ boost + learned_cue evidence", () => {
    const query = "offset page query"; // 命中 positiveExample 特征 "offset-page-query"
    const staticList = staticCandidates(query);
    const reranked = rerankWithOverlay(staticList, profile(), query, { positiveBoost: 3 });
    const learnedGold = reranked.find((c) => c.skillId === GOLD_ID)!;
    assert.ok(
      learnedGold.evidence.some((evidence) => evidence.kind === "learned_cue" && evidence.cueId === "cue:pos-1"),
    );
  });

  it("overlay 提升可把 gold 提到首位（软重排效果）", () => {
    // 用只命中 learned alias 的查询：静态下 gold 仅凭 description 召回（可能后排），
    // aliasBoost 后 gold 必须升至 Top-1。
    const query = "offset-check syntax";
    const staticList = staticCandidates(query);
    const reranked = rerankWithOverlay(staticList, profile(), query, { aliasBoost: 100 });
    assert.equal(reranked[0]!.skillId, GOLD_ID, "alias boost 必须把 gold 提到首位");
  });

  it("排序确定性：score 降序 + skillId 升序 tie-break", () => {
    const query = "check offset pagination sql";
    const staticList = staticCandidates(query);
    const first = rerankWithOverlay(staticList, profile(), query, { aliasBoost: 5 });
    const second = rerankWithOverlay(staticList, profile(), query, { aliasBoost: 5 });
    assert.deepEqual(second, first);
    for (let i = 1; i < first.length; i += 1) {
      const prev = first[i - 1]!;
      const cur = first[i]!;
      assert.ok(
        prev.retrievalScore > cur.retrievalScore ||
          (prev.retrievalScore === cur.retrievalScore && prev.skillId < cur.skillId),
        "必须 score 降序 + skillId 升序",
      );
    }
  });
});

describe("shadow rerank：near-miss 只降权不硬过滤", () => {
  it("near-miss 命中 ⇒ 分数下降但候选保留（绝不硬排除）", () => {
    const query = "cursor pagination query"; // 命中 nearMiss 特征 "cursor-pagination-query"
    const staticList = staticCandidates(query);
    const reranked = rerankWithOverlay(staticList, profile(), query, { nearMissPenalty: 10 });
    assert.equal(reranked.length, staticList.length, "候选集不变（不硬过滤）");
    const learnedGold = reranked.find((c) => c.skillId === GOLD_ID)!;
    const staticGold = staticList.find((c) => c.skillId === GOLD_ID)!;
    assert.ok(
      learnedGold.retrievalScore < staticGold.retrievalScore,
      "near-miss 命中必须降权",
    );
    // near-miss 不追加为命中 evidence。
    assert.ok(!learnedGold.evidence.some((e) => e.kind === "learned_cue" && e.cueId === "cue:nm-cursor"));
  });
});

describe("shadow rerank：matchLearnedOverlay", () => {
  it("query 命中 alias/positive/near-miss 的 cue 分别返回", () => {
    const hit = matchLearnedOverlay("offset-check offset page query cursor", profile());
    assert.deepEqual([...hit.aliasCueIds].sort(), ["cue:alias-offset"]);
    assert.deepEqual([...hit.positiveCueIds].sort(), ["cue:pos-1"]);
    assert.deepEqual([...hit.nearMissCueIds].sort(), ["cue:nm-cursor"]);
  });

  it("无命中 ⇒ 全空", () => {
    const hit = matchLearnedOverlay("pdf document reading", profile());
    assert.deepEqual(hit.aliasCueIds, []);
    assert.deepEqual(hit.positiveCueIds, []);
    assert.deepEqual(hit.nearMissCueIds, []);
  });
});
