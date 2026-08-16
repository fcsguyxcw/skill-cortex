/**
 * Phase 6 host —— 管线 + overlay seam 测试（project-local）。
 *
 * 覆盖：
 * - applyActiveProfiles：无 active profile / 关闭 boost ⇒ 无损回静态（deepEqual）；
 *   仅 revision 匹配的 active profile 生效（boost + learned_cue evidence）；revision
 *   失配 / 非 active ⇒ 忽略。
 * - evaluateProfileForPromotion：受控 evaluator（= evaluateOverlay 包装）。
 * - promoteProfileIfEligible：受控 report 判门 → shadow→active 落盘（store 内部重算
 *   verdict 兜底）；判门失败 ⇒ promotion_gate_failed 且不落盘。
 * - induceAndStoreShadow：真实 verified 事件 → draft → shadow 落盘；幂等（二次不重复 save）。
 * - revertProfilesForParentRevisionChanges：父 revision 漂移 → active 回 shadow。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type {
  ActivationProfile,
  PracticeEvent,
  SkillRecord,
} from "../core/contracts/index.ts";
import { buildIndex } from "../discovery/index.ts";
import {
  applyActiveProfiles,
  evaluateProfileForPromotion,
  induceAndStoreShadow,
  promoteProfileIfEligible,
  revertProfilesForParentRevisionChanges,
} from "./index.ts";
import { transitionProfileToShadow } from "./index.ts";
import { ActivationProfileStore } from "./index.ts";
import {
  FINAL_HELDOUT_CASES,
  FINAL_HELDOUT_GOLD_KEYSET_ID,
  FINAL_HELDOUT_OVERLAY_OPTIONS,
  FINAL_HELDOUT_PROFILE,
  FINAL_HELDOUT_RECORDS,
  FINAL_HELDOUT_SKILL_REV,
} from "./index.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SKILL_ID = "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2";
const SKILL_REV = "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec";
const SOURCE_HASH = "sha256:8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830";

let tempRoot = "";
let storeSeq = 0;

function makeStore(): ActivationProfileStore {
  storeSeq += 1;
  return new ActivationProfileStore({
    rootDir: path.join(tempRoot, `store-${storeSeq}`),
    projectRoot: tempRoot,
    now: () => new Date("2026-08-20T00:00:00.000Z"),
  });
}

function parentSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    schemaVersion: 1,
    skillId: SKILL_ID,
    skillRevision: SKILL_REV,
    name: "supabase-postgres-best-practices",
    description: "Postgres performance optimization and best practices from Supabase.",
    scope: "user",
    sourceLocator: "C:\\skills\\supabase-postgres-best-practices",
    sourceHash: SOURCE_HASH,
    disableModelInvocation: false,
    declaredAliases: ["postgres-best-practices", "supabase-pg"],
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function verifiedEvent(id: string, overrides: Partial<PracticeEvent> = {}): PracticeEvent {
  return {
    schemaVersion: 1,
    eventId: id,
    occurredAt: "2026-08-15T00:00:00.000Z",
    tenantScope: "project:abc123",
    provenance: "real",
    parentSkillId: SKILL_ID,
    parentSkillRevision: SKILL_REV,
    sourceHash: SOURCE_HASH,
    candidateSkillIds: [SKILL_ID],
    selectedSkillIds: [SKILL_ID],
    executionMode: "skill_md",
    redactedTaskFeatures: ["prompt-hash:aaa", "candidate-count:3", "selected-count:1", "pagination-check"],
    stepSummaries: [
      { stepId: "s1", actor: "tool", operationClass: "tool:load_skill", outcome: "ok" },
      { stepId: "s2", actor: "procedure", operationClass: "detect-offset-pagination", outcome: "ok" },
    ],
    authorizationResults: [],
    guardResults: [{ predicateId: "g1", phase: "runtime", result: "pass" }],
    verifierResults: [{ verifierId: "phase3-pagination-structured-finding", result: "pass" }],
    attribution: "verified_skill_effect",
    sensitivity: "none",
    retentionClass: "project_manual",
    ...overrides,
  };
}

before(() => {
  tempRoot = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-activation-host-"));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("applyActiveProfiles：active discovery overlay", () => {
  const index = buildIndex(FINAL_HELDOUT_RECORDS);
  const query = "detect keyset";

  it("无 active profile ⇒ 无损回静态（deepEqual）", () => {
    const staticCandidates = index.search(query, { limit: 5 });
    assert.deepEqual(
      applyActiveProfiles(staticCandidates, [], query, FINAL_HELDOUT_OVERLAY_OPTIONS),
      staticCandidates,
    );
  });

  it("仅 revision 匹配的 active profile 生效：gold 加 learned_cue evidence + boost", () => {
    const staticCandidates = index.search(query, { limit: 5 });
    const active: ActivationProfile = { ...FINAL_HELDOUT_PROFILE, status: "active" };
    const overlayed = applyActiveProfiles(
      staticCandidates,
      [active],
      query,
      FINAL_HELDOUT_OVERLAY_OPTIONS,
    );
    const gold = overlayed.find((c) => c.skillId === FINAL_HELDOUT_GOLD_KEYSET_ID)!;
    const staticGold = staticCandidates.find((c) => c.skillId === FINAL_HELDOUT_GOLD_KEYSET_ID)!;
    assert.ok(gold, "gold 必须在候选内");
    assert.ok(gold.retrievalScore > staticGold.retrievalScore, "active overlay 必须提升 gold 分数");
    assert.ok(
      gold.evidence.some((e) => e.kind === "learned_cue" && e.cueId === "cue:fh-alias-en"),
      "gold 必须追加 learned_cue evidence",
    );
    // 排序仍 score 降序。
    for (let i = 1; i < overlayed.length; i += 1) {
      assert.ok(overlayed[i - 1]!.retrievalScore >= overlayed[i]!.retrievalScore);
    }
  });

  it("revision 失配的 active profile ⇒ 不生效（deepEqual 静态）", () => {
    const staticCandidates = index.search(query, { limit: 5 });
    const stale: ActivationProfile = {
      ...FINAL_HELDOUT_PROFILE,
      status: "active",
      parentSkillRevision: "rev:" + "9".repeat(64),
    };
    assert.deepEqual(
      applyActiveProfiles(staticCandidates, [stale], query, FINAL_HELDOUT_OVERLAY_OPTIONS),
      staticCandidates,
    );
  });

  it("非 active（shadow/draft）⇒ 不生效", () => {
    const staticCandidates = index.search(query, { limit: 5 });
    for (const status of ["draft", "shadow", "suspended", "retired"] as const) {
      const nonActive: ActivationProfile = { ...FINAL_HELDOUT_PROFILE, status };
      assert.deepEqual(
        applyActiveProfiles(staticCandidates, [nonActive], query, FINAL_HELDOUT_OVERLAY_OPTIONS),
        staticCandidates,
        `${status} profile 不得影响 discovery`,
      );
    }
  });
});

describe("evaluateProfileForPromotion：受控 evaluator", () => {
  it("report 来自 evaluateOverlay（四栏 + nonInferior 结构）", () => {
    const report = evaluateProfileForPromotion(
      FINAL_HELDOUT_PROFILE,
      FINAL_HELDOUT_CASES,
      FINAL_HELDOUT_RECORDS,
      FINAL_HELDOUT_OVERLAY_OPTIONS,
    );
    assert.equal(report.nonInferior, true);
    assert.equal(report.learnedColumns.length, 4);
  });
});

describe("promoteProfileIfEligible：受控 promotion 判门", () => {
  it("判门通过 ⇒ shadow→active 落盘（store 内部重算 verdict 兜底）", async () => {
    const store = makeStore();
    const draft = { ...FINAL_HELDOUT_PROFILE, status: "draft" as const };
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft, { decision: "shadow", shadowReportId: "shadow:phase6-host-001" });
    await store.transition(draft, shadow, { trigger: "procedure", reportId: "shadow:phase6-host-001" });

    const result = await promoteProfileIfEligible(
      store,
      shadow,
      FINAL_HELDOUT_CASES,
      FINAL_HELDOUT_RECORDS,
      FINAL_HELDOUT_OVERLAY_OPTIONS,
      "promotion:phase6-host-001",
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const current = await store.getProfile(FINAL_HELDOUT_PROFILE.profileId);
    assert.equal(current!.status, "active");
    const events = await store.listEvents(FINAL_HELDOUT_PROFILE.profileId);
    assert.equal(events[events.length - 1]!.reportId, "promotion:phase6-host-001");
  });

  it("判门失败 ⇒ promotion_gate_failed 且不落盘", async () => {
    const store = makeStore();
    const shadow = { ...FINAL_HELDOUT_PROFILE, status: "shadow" as const };
    // 缺 no_skill 栏 ⇒ 覆盖检查失败（column_not_covered）⇒ 判门失败（store.transition 不触发）。
    const cases = FINAL_HELDOUT_CASES.filter((c) => c.column !== "no_skill");
    const result = await promoteProfileIfEligible(
      store,
      shadow,
      cases,
      FINAL_HELDOUT_RECORDS,
      FINAL_HELDOUT_OVERLAY_OPTIONS,
      "promotion:phase6-host-fail",
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "promotion_gate_failed");
    assert.equal((await store.listCurrent()).length, 0, "判门失败不得落盘");
  });

  it("父 Skill 不在评估集 records 内 ⇒ parent_not_in_evaluation_set 拒绝（防 trivial 晋升）", async () => {
    const store = makeStore();
    const shadow = {
      ...FINAL_HELDOUT_PROFILE,
      parentSkillId: "skill:" + "ff".repeat(32),
      status: "shadow" as const,
    };
    const result = await promoteProfileIfEligible(
      store,
      shadow,
      FINAL_HELDOUT_CASES,
      FINAL_HELDOUT_RECORDS,
      FINAL_HELDOUT_OVERLAY_OPTIONS,
      "promotion:phase6-host-noparent",
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "promotion_gate_failed");
      assert.deepEqual(result.reasons, ["parent_not_in_evaluation_set"]);
    }
    assert.equal((await store.listCurrent()).length, 0, "不得落盘");
  });
});

describe("induceAndStoreShadow：真实事件 → draft → shadow 落盘", () => {
  it("verified 事件 ⇒ draft→shadow 落盘；二次调用幂等（created=false）", async () => {
    const store = makeStore();
    const events = [verifiedEvent("obs-1"), verifiedEvent("obs-2")];
    const first = await induceAndStoreShadow(store, events, parentSkill(), "shadow:phase6-host-001");
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.created, true);
    assert.equal(first.status, "shadow");
    assert.match(first.profileId, /^profile:[0-9a-f]{24}$/);

    const second = await induceAndStoreShadow(store, events, parentSkill(), "shadow:phase6-host-001");
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.created, false, "二次不重复 save");
    assert.equal(second.profileId, first.profileId);
    assert.equal((await store.listCurrent()).length, 1, "只落一个 profile");
  });

  it("无合格事件 ⇒ 拒绝不落盘", async () => {
    const store = makeStore();
    const events = [verifiedEvent("obs-9", { attribution: "mixed", verifierResults: [{ verifierId: "v1", result: "fail" }], failureClass: "tool_failure" as const })];
    const result = await induceAndStoreShadow(store, events, parentSkill(), "shadow:phase6-host-001");
    assert.equal(result.ok, false);
    assert.equal((await store.listCurrent()).length, 0);
  });
});

describe("revertProfilesForParentRevisionChanges：父 revision 漂移", () => {
  it("active profile 的父 revision 与当次不同 ⇒ 回 shadow", async () => {
    const store = makeStore();
    const draft = { ...FINAL_HELDOUT_PROFILE, status: "draft" as const };
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft, { decision: "shadow", shadowReportId: "shadow:phase6-host-001" });
    await store.transition(draft, shadow, { trigger: "procedure", reportId: "shadow:phase6-host-001" });
    await promoteProfileIfEligible(
      store,
      shadow,
      FINAL_HELDOUT_CASES,
      FINAL_HELDOUT_RECORDS,
      FINAL_HELDOUT_OVERLAY_OPTIONS,
      "promotion:phase6-host-001",
    );
    assert.equal((await store.getProfile(FINAL_HELDOUT_PROFILE.profileId))!.status, "active");

    // 父 revision 漂移：当次 revision 变了 ⇒ active 回 shadow。
    const outcome = await revertProfilesForParentRevisionChanges(
      store,
      new Map([[FINAL_HELDOUT_GOLD_KEYSET_ID, "rev:" + "9".repeat(64)]]),
    );
    assert.deepEqual(outcome.reverted, [FINAL_HELDOUT_PROFILE.profileId]);
    assert.equal((await store.getProfile(FINAL_HELDOUT_PROFILE.profileId))!.status, "shadow");
  });

  it("父 revision 一致 ⇒ 不回退", async () => {
    const store = makeStore();
    const draft = { ...FINAL_HELDOUT_PROFILE, status: "draft" as const };
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft, { decision: "shadow", shadowReportId: "shadow:phase6-host-001" });
    await store.transition(draft, shadow, { trigger: "procedure", reportId: "shadow:phase6-host-001" });
    await promoteProfileIfEligible(
      store,
      shadow,
      FINAL_HELDOUT_CASES,
      FINAL_HELDOUT_RECORDS,
      FINAL_HELDOUT_OVERLAY_OPTIONS,
      "promotion:phase6-host-001",
    );
    const outcome = await revertProfilesForParentRevisionChanges(
      store,
      new Map([[FINAL_HELDOUT_GOLD_KEYSET_ID, FINAL_HELDOUT_SKILL_REV]]),
    );
    assert.deepEqual(outcome.reverted, []);
    assert.equal((await store.getProfile(FINAL_HELDOUT_PROFILE.profileId))!.status, "active");
  });
});
