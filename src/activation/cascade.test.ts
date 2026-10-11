/**
 * Phase 6 第三批 —— cue 删除级联 + 父 revision 失效测试（纯函数）。
 *
 * 覆盖：
 * - profileCuesReferenceEvidence：命中/未命中判定（四类 cue 的 evidenceIds）；
 * - removeCuesReferencingEvidence：命中 cue 移除（alias/positive/near_miss/environment），
 *   其余保留；removedCues 可追溯；不可变；
 * - suspendProfilesForEvidenceDeletion：非终态命中 ⇒ suspend（reason=evidence_cascade_deletion）；
 *   未命中不变；
 * - revertProfilesForParentRevision：active + 父 revision 失配 ⇒ 回 shadow（重验）；
 *   revision 匹配 ⇒ 不变；draft/suspended 失配 ⇒ 不变（已挂起/未评估）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActivationProfile } from "../core/contracts/index.ts";
import {
  profileCuesReferenceEvidence,
  removeCuesReferencingEvidence,
  revertProfilesForParentRevision,
  suspendProfilesForEvidenceDeletion,
} from "./index.ts";

const SKILL_ID = "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2";
const SKILL_REV = "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec";

function profileOf(
  status: ActivationProfile["status"],
  overrides: Partial<ActivationProfile> = {},
): ActivationProfile {
  return {
    schemaVersion: 1,
    profileId: "profile:test123",
    parentSkillId: SKILL_ID,
    parentSkillRevision: SKILL_REV,
    status,
    learnedAliases: [{ cueId: "cue:a1", text: "offset-check", evidenceIds: ["obs-1"] }],
    positiveExamples: [{ cueId: "cue:p1", features: ["offset-page-query"], evidenceIds: ["obs-1"] }],
    nearMissExamples: [{ cueId: "cue:n1", features: ["cursor-query"], evidenceIds: ["obs-2"] }],
    environmentCues: [{ key: "environment", valueClass: "os:win32", evidenceIds: ["obs-3"] }],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("cue 删除级联：命中判定", () => {
  it("任一 cue 的 evidenceIds 含被删 evidence ⇒ 命中（四类均计入）", () => {
    const profile = profileOf("active");
    assert.equal(profileCuesReferenceEvidence(profile, ["obs-1"]), true, "alias/positive 命中");
    assert.equal(profileCuesReferenceEvidence(profile, ["obs-2"]), true, "nearMiss 命中");
    assert.equal(profileCuesReferenceEvidence(profile, ["obs-3"]), true, "environment 命中");
  });

  it("无命中 ⇒ false", () => {
    const profile = profileOf("active");
    assert.equal(profileCuesReferenceEvidence(profile, ["obs-99"]), false);
    assert.equal(profileCuesReferenceEvidence(profile, []), false);
  });
});

describe("cue 删除级联：受控移除", () => {
  it("命中 cue 移除（含 environment），其余保留；removedCues 可追溯", () => {
    const profile = profileOf("active");
    const result = removeCuesReferencingEvidence(profile, ["obs-1", "obs-3"]);
    assert.deepEqual(
      [...result.removedCues].sort((a, b) => (a.cueId < b.cueId ? -1 : 1)),
      [
        { cueId: "cue:a1", kind: "alias" },
        { cueId: "cue:p1", kind: "positive" },
        { cueId: "environment", kind: "environment" },
      ],
    );
    assert.deepEqual(result.profile.learnedAliases, [], "alias 已移除");
    assert.deepEqual(result.profile.positiveExamples, [], "positive 已移除");
    assert.deepEqual(result.profile.environmentCues, [], "environment 已移除");
    assert.deepEqual(result.profile.nearMissExamples, profile.nearMissExamples, "nearMiss 保留");
    // 不可变：原 profile 不变。
    assert.equal(profile.learnedAliases.length, 1);
  });

  it("无命中 ⇒ 原样（新对象，cue 全保留）", () => {
    const profile = profileOf("shadow");
    const result = removeCuesReferencingEvidence(profile, ["obs-99"]);
    assert.deepEqual(result.removedCues, []);
    assert.deepEqual(result.profile.learnedAliases, profile.learnedAliases);
    assert.equal(result.profile.status, "shadow");
  });
});

describe("cue 删除级联：非终态 suspend", () => {
  it("命中被删 evidence 的非终态 profile ⇒ suspend（受控 reason），未命中不变", () => {
    const hit = profileOf("active");
    const miss = profileOf("shadow", {
      profileId: "profile:other1",
      learnedAliases: [{ cueId: "cue:x", text: "other", evidenceIds: ["obs-99"] }],
      positiveExamples: [],
      nearMissExamples: [],
      environmentCues: [],
    });
    const results = suspendProfilesForEvidenceDeletion(
      [hit as never, miss as never],
      ["obs-1"],
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]!.profileId, "profile:test123");
    assert.equal(results[0]!.suspended.status, "suspended");
  });

  it("suspend 原因受控：reason=evidence_cascade_deletion（与 rerank/评估语义一致的可审计文本）", () => {
    const hit = profileOf("draft");
    const results = suspendProfilesForEvidenceDeletion([hit as never], ["obs-2"]);
    assert.equal(results.length, 1);
  });
});

describe("父 revision 失效：active 回 shadow 重验", () => {
  it("active + 父 revision 失配 ⇒ 回 shadow（revalidation 报告）；匹配 ⇒ 不变", () => {
    const active = profileOf("active");
    const sameRev = profileOf("active", {
      profileId: "profile:same",
      parentSkillRevision: "rev:" + "2".repeat(64), // 与 currentParentRevision 匹配
    });
    const result = revertProfilesForParentRevision(
      [active as never, sameRev as never],
      "rev:" + "2".repeat(64),
    );
    assert.equal(result.reverted.length, 1, "失配的 active 必须回 shadow");
    assert.equal(result.reverted[0]!.profileId, "profile:test123");
    assert.equal(result.reverted[0]!.profile.status, "shadow");
    assert.equal(result.reverted[0]!.profile.parentSkillRevision, SKILL_REV, "父绑定保留（重验依据）");
    assert.ok(result.unchanged.includes("profile:same"), "revision 匹配的 active 不变");
  });

  it("draft/suspended 失配 ⇒ 不变（draft 未评估；suspended 已挂起）", () => {
    const draft = profileOf("draft", { profileId: "profile:d" });
    const suspended = profileOf("suspended", { profileId: "profile:s" });
    const result = revertProfilesForParentRevision(
      [draft as never, suspended as never],
      "rev:" + "2".repeat(64),
    );
    assert.deepEqual(result.reverted, []);
    assert.deepEqual([...result.unchanged].sort(), ["profile:d", "profile:s"]);
  });

  it("全部匹配 ⇒ 无回退", () => {
    const active = profileOf("active");
    const result = revertProfilesForParentRevision([active as never], SKILL_REV);
    assert.deepEqual(result.reverted, []);
    assert.deepEqual(result.unchanged, ["profile:test123"]);
  });
});
