/**
 * Phase 6/7 host —— 管线 + overlay seam 测试（project-local）。
 *
 * 覆盖：
 * - applyActiveProfiles：无 active profile / 关闭 boost ⇒ 无损回静态（deepEqual）；
 *   仅 revision 匹配的 active profile 生效；revision 失配 / 非 active ⇒ 忽略。
 * - evaluateProfileForPromotion：受控 evaluator（= evaluateOverlay 包装）。
 * - buildFrozenEvaluation（Seam 3）：父在 catalog ⇒ 四栏；父不在 ⇒ 空 case 集。
 * - promoteProfileIfEligible（Seam 3）：冻结评估集判门 → active；父不在集拒绝；真正重叠
 *   confuser ⇒ 诚实拒绝（不 trivial 晋升）。
 * - induceAndStoreShadow：真实 verified 事件 → draft → shadow 落盘；幂等。
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
  buildFrozenEvaluation,
  evaluateProfileForPromotion,
  induceAndStoreShadow,
  promoteProfileIfEligible,
  revertProfilesForParentRevisionChanges,
} from "./index.ts";
import { transitionProfileToShadow, type ShadowActivationProfile } from "./index.ts";
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

/** 简单 catalog record（skillId 由 idHex 派生，revision 固定）。 */
function catalogSkill(idHex: string, name: string, description: string): SkillRecord {
  return {
    schemaVersion: 1,
    skillId: "skill:" + idHex.repeat(32),
    skillRevision: "rev:" + "1".repeat(64),
    name,
    description,
    scope: "user",
    sourceLocator: "/test-fixture",
    sourceHash: "sha256:" + "2".repeat(64),
    disableModelInvocation: false,
    declaredAliases: [],
    declaredEffects: [],
    declaredPermissions: [],
    dependencyManifest: [],
    discoveredAt: "2026-08-14T00:00:00.000Z",
  };
}

/** shadow profile bound to a catalog record（可带 learned aliases）。 */
function shadowProfile(record: SkillRecord, aliases: string[] = []): ShadowActivationProfile {
  return {
    schemaVersion: 1,
    profileId: "profile:host-test",
    parentSkillId: record.skillId,
    parentSkillRevision: record.skillRevision,
    status: "shadow",
    learnedAliases: aliases.map((text, index) => ({
      cueId: `cue:a${index}`,
      text,
      evidenceIds: ["obs-1"],
    })),
    positiveExamples: [],
    nearMissExamples: [],
    environmentCues: [],
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

const GOLD = catalogSkill("aa", "sql-pagination-helper", "Detect pagination in SQL queries using offset or keyset.");
const CONFUSER_DISTINCT = catalogSkill("bb", "pdf-reader", "Read and merge PDF documents.");

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
    assert.ok(gold.retrievalScore > staticGold.retrievalScore, "active overlay 必须提升 gold 分数");
    assert.ok(
      gold.evidence.some((e) => e.kind === "learned_cue" && e.cueId === "cue:fh-alias-en"),
      "gold 必须追加 learned_cue evidence",
    );
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

describe("buildFrozenEvaluation（Seam 3）：冻结 real-skill 评估 provider", () => {
  it("父在 catalog ⇒ 四栏各 ≥1 例（含冻结 no_skill + cross_language 回退）", () => {
    const { cases, records } = buildFrozenEvaluation(
      shadowProfile(GOLD),
      [GOLD, CONFUSER_DISTINCT],
    );
    assert.equal(records.length, 2);
    const columns = new Set(cases.map((c) => c.column));
    for (const column of ["hard_confuser", "no_skill", "multi_skill", "cross_language"] as const) {
      assert.ok(columns.has(column), `缺 ${column} 栏`);
      assert.ok(cases.some((c) => c.column === column), `${column} 栏必须有 case`);
    }
  });

  it("父不在 catalog ⇒ 空 case 集（调用方拒绝晋升）", () => {
    const { cases } = buildFrozenEvaluation(
      shadowProfile(catalogSkill("ff", "absent-skill", "Not in catalog.")),
      [GOLD, CONFUSER_DISTINCT],
    );
    assert.equal(cases.length, 0);
  });
});

describe("promoteProfileIfEligible（Seam 3）：冻结评估集判门", () => {
  it("父在 catalog + confuser 区分 ⇒ shadow→active 落盘（store 内部重算 verdict 兜底）", async () => {
    const store = makeStore();
    const draft = { ...shadowProfile(GOLD), status: "draft" as const };
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft, { decision: "shadow", shadowReportId: "shadow:host-001" });
    await store.transition(draft, shadow, { trigger: "procedure", reportId: "shadow:host-001" });

    const result = await promoteProfileIfEligible(
      store,
      shadow,
      [GOLD, CONFUSER_DISTINCT],
      "promotion:host-001",
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await store.getProfile("profile:host-test"))!.status, "active");
    const events = await store.listEvents("profile:host-test");
    assert.equal(events[events.length - 1]!.reportId, "promotion:host-001");
  });

  it("父不在 catalog ⇒ parent_not_in_evaluation_set 拒绝且不落盘", async () => {
    const store = makeStore();
    const shadow = shadowProfile(catalogSkill("ff", "absent-skill", "Not in catalog."));
    const result = await promoteProfileIfEligible(
      store,
      shadow,
      [GOLD, CONFUSER_DISTINCT],
      "promotion:host-noparent",
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "promotion_gate_failed");
      assert.deepEqual(result.reasons, ["parent_not_in_evaluation_set"]);
    }
    assert.equal((await store.listCurrent()).length, 0);
  });

  it("真正高词汇重叠 confuser ⇒ 诚实拒绝（confuserNotRecalled 掉门槛），不 trivial 晋升", async () => {
    const store = makeStore();
    const nearGold = catalogSkill("cc", "keyset-pagination-detector", "Detect keyset pagination using row-value comparison.");
    const nearConfuser = catalogSkill("dd", "sql-cursor-traversal-tool", "Apply keyset pagination to SQL result sets using cursor pointers.");
    const shadow = shadowProfile(nearGold);
    const result = await promoteProfileIfEligible(
      store,
      shadow,
      [nearGold, nearConfuser],
      "promotion:host-hard",
    );
    assert.equal(result.ok, false, "重叠 confuser 必须拒绝");
    assert.equal((await store.listCurrent()).length, 0);
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
  async function activeProfile(store: ActivationProfileStore): Promise<void> {
    const draft = { ...shadowProfile(GOLD), status: "draft" as const };
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft, { decision: "shadow", shadowReportId: "shadow:host-001" });
    await store.transition(draft, shadow, { trigger: "procedure", reportId: "shadow:host-001" });
    await promoteProfileIfEligible(store, shadow, [GOLD, CONFUSER_DISTINCT], "promotion:host-001");
  }

  it("active profile 的父 revision 与当次不同 ⇒ 回 shadow", async () => {
    const store = makeStore();
    await activeProfile(store);
    assert.equal((await store.getProfile("profile:host-test"))!.status, "active");

    const outcome = await revertProfilesForParentRevisionChanges(
      store,
      new Map([[GOLD.skillId, "rev:" + "9".repeat(64)]]),
    );
    assert.deepEqual(outcome.reverted, ["profile:host-test"]);
    assert.equal((await store.getProfile("profile:host-test"))!.status, "shadow");
  });

  it("父 revision 一致 ⇒ 不回退", async () => {
    const store = makeStore();
    await activeProfile(store);
    const outcome = await revertProfilesForParentRevisionChanges(
      store,
      new Map([[GOLD.skillId, GOLD.skillRevision]]),
    );
    assert.deepEqual(outcome.reverted, []);
    assert.equal((await store.getProfile("profile:host-test"))!.status, "active");
  });
});
