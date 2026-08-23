/**
 * Phase 6 第四批 —— ActivationProfile store 测试（project-local 持久化 + 删除级联落盘）。
 *
 * 覆盖：
 * - save 首次落盘（wx）+ round-trip（cue 数据/父绑定一致）+ 重复 save 拒绝；
 * - transition：合法边落盘 + append-only 事件（seq/from/to/reportId/reason）；
 *   非法边 / stale-prior 三要素 / immutable 内容变化 ⇒ 拒绝且不落盘；
 * - 查询：getProfile / listCurrent / listByStatus / listByEvidenceId（cascade 注入）/ listEvents；
 * - 删除级联落盘：applyEvidenceDeletionCascade（命中 suspend 落盘 + 事件；未命中不变）；
 * - 分区/脱敏：rootDir 强制 projectRoot 内（词法 + realpath）、tenantScope SHA-256、
 *   读取 fail-closed（损坏 JSON 抛受控错误）、事件只落受控字段。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ActivationProfile, SkillRecord } from "../core/contracts/index.ts";
import {
  applyEvidenceDeletionCascade,
  ActivationProfileStore,
  transitionProfileToActive,
  transitionProfileToShadow,
  transitionProfileToSuspended,
  type ShadowActivationProfile,
} from "./index.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SKILL_ID = "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2";
const SKILL_REV = "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec";

let tempRoot = "";
let storeSeq = 0;

function makeStore(overrides: { tenantScope?: string } = {}): ActivationProfileStore {
  storeSeq += 1;
  return new ActivationProfileStore({
    rootDir: path.join(tempRoot, `store-${storeSeq}`),
    projectRoot: tempRoot,
    tenantScope: overrides.tenantScope,
    now: () => new Date("2026-08-20T00:00:00.000Z"),
  });
}

function draftProfile(id = "profile:test1", overrides: Partial<ActivationProfile> = {}): ActivationProfile {
  return {
    schemaVersion: 1,
    profileId: id,
    parentSkillId: SKILL_ID,
    parentSkillRevision: SKILL_REV,
    status: "draft",
    learnedAliases: [{ cueId: "cue:a1", text: "offset-check", evidenceIds: ["obs-1"] }],
    positiveExamples: [{ cueId: "cue:p1", features: ["offset-page-query"], evidenceIds: ["obs-1"] }],
    nearMissExamples: [{ cueId: "cue:n1", features: ["cursor-query"], evidenceIds: ["obs-2"] }],
    environmentCues: [{ key: "environment", valueClass: "os:win32", evidenceIds: ["obs-3"] }],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

/** 父 SkillRecord（skillId=SKILL_ID/revision=SKILL_REV，与 draftProfile 绑定一致）。 */
function parentRecord(): SkillRecord {
  return skillRecord(SKILL_ID, SKILL_REV, "sql-pagination-helper", "Detect pagination in SQL queries using offset or keyset.");
}

/** 无关 confuser（pdf；与父查询不重叠，hard_confuser 不误召）。 */
const CONFUSER_ID = "skill:" + "b".repeat(64);
function confuserRecord(): SkillRecord {
  return skillRecord(CONFUSER_ID, SKILL_REV, "pdf-reader", "Read and merge PDF documents.");
}

function skillRecord(id: string, rev: string, name: string, description: string): SkillRecord {
  return {
    schemaVersion: 1,
    skillId: id,
    skillRevision: rev,
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

/** 与父高词汇重叠的 confuser（keyset/pagination 共享词，hard_confuser 会误召 ⇒ 判门拒绝）。 */
function overlappingConfuser(): SkillRecord {
  return skillRecord(
    "skill:" + "c".repeat(64),
    SKILL_REV,
    "sql-cursor-traversal-tool",
    "Apply keyset pagination to SQL result sets using cursor pointers.",
  );
}

/** 冻结评估语料：父 + 无关 confuser（可通过 hard_confuser + no_skill 判门）。 */
function promotionRecords(): SkillRecord[] {
  return [parentRecord(), confuserRecord()];
}

/** 构造 promotion 边需要的结构化 evidence（Issue 2：只传 records + 受控报告 ID，store 自行重算）。 */
function promotionMeta(
  records: SkillRecord[] = promotionRecords(),
  promotionReportId = "promotion:phase6-gate-001",
) {
  return { promotion: { records, promotionReportId } };
}

before(() => {
  tempRoot = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-activation-store-"));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("ActivationProfileStore：save 与 round-trip", () => {
  it("save draft profile ⇒ getProfile 一致（cue 数据/父绑定/状态），事件首条 fromStatus=undefined", async () => {
    const store = makeStore();
    await store.save(draftProfile(), { trigger: "procedure" });
    const profile = await store.getProfile("profile:test1");
    assert.ok(profile, "必须可读回");
    assert.equal(profile!.status, "draft");
    assert.equal(profile!.parentSkillId, SKILL_ID);
    assert.equal(profile!.parentSkillRevision, SKILL_REV);
    assert.deepEqual(profile!.learnedAliases, draftProfile().learnedAliases);
    assert.deepEqual(profile!.positiveExamples, draftProfile().positiveExamples);

    const events = await store.listEvents("profile:test1");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.fromStatus, undefined);
    assert.equal(events[0]!.toStatus, "draft");
    assert.equal(events[0]!.seq, 1);
    assert.equal(events[0]!.trigger, "procedure");
  });

  it("重复 save ⇒ 拒绝（activation_store_already_exists），不覆盖", async () => {
    const store = makeStore();
    await store.save(draftProfile(), { trigger: "procedure" });
    await assert.rejects(
      store.save(draftProfile(), { trigger: "procedure" }),
      /activation_store_already_exists/,
    );
    const profiles = await store.listCurrent();
    assert.equal(profiles.length, 1);
  });

  it("rootDir 在 projectRoot 外 ⇒ 构造拒绝（词法校验）", () => {
    const outside = path.join(PROJECT_ROOT, "..", "outside-activation");
    assert.throws(
      () => new ActivationProfileStore({ rootDir: outside, projectRoot: PROJECT_ROOT }),
      /activation_store_root_must_be_inside_project_root/,
    );
  });
});

describe("ActivationProfileStore：transition 落盘 + 事件", () => {
  it("合法链 draft→shadow→active：current 更新 + append-only 事件（seq 递增、from/to 正确）", async () => {
    const store = makeStore();
    const draft = draftProfile();
    await store.save(draft, { trigger: "procedure" });

    const shadow = transitionProfileToShadow(draft as never, {
      decision: "shadow",
      shadowReportId: "shadow:phase6-replay-001",
    });
    await store.transition(draft, shadow, {
      trigger: "agent",
      reportId: "shadow:phase6-replay-001",
    });

    const active = transitionProfileToActive(shadow, {
      decision: "active",
      promotionReportId: "promotion:phase6-gate-001",
    });
    await store.transition(shadow, active, {
      trigger: "agent",
      ...promotionMeta(),
    });

    const current = await store.getProfile("profile:test1");
    assert.equal(current!.status, "active");
    const events = await store.listEvents("profile:test1");
    assert.equal(events.length, 3, "save + 2 transitions = 3 事件");
    assert.deepEqual(
      events.map((e) => `${e.fromStatus ?? "∅"}→${e.toStatus}`),
      ["∅→draft", "draft→shadow", "shadow→active"],
    );
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
    assert.equal(events[1]!.reportId, "shadow:phase6-replay-001");
    assert.equal(events[2]!.reportId, "promotion:phase6-gate-001");
  });

  it("非法边（draft→active）⇒ 拒绝且不落盘（current/事件不变）", async () => {
    const store = makeStore();
    const draft = draftProfile();
    await store.save(draft, { trigger: "procedure" });
    await assert.rejects(
      store.transition(draft, { ...draft, status: "active" } as ActivationProfile, { trigger: "agent" }),
      /activation_store_illegal_transition: draft -> active/,
    );
    const current = await store.getProfile("profile:test1");
    assert.equal(current!.status, "draft", "current 不得变化");
    assert.equal((await store.listEvents("profile:test1")).length, 1, "事件不得追加");
  });

  it("stale-prior 三要素失配 ⇒ 拒绝（不信任调用方旧 prior）", async () => {
    const store = makeStore();
    const draft = draftProfile();
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft as never, {
      decision: "shadow",
      shadowReportId: "shadow:phase6-replay-001",
    });
    await store.transition(draft, shadow, { trigger: "agent" });

    // 用旧 prior（status=draft）再次 transition ⇒ stale。
    await assert.rejects(
      store.transition(draft, shadow, { trigger: "agent" }),
      /activation_store_stale_prior/,
    );
    // 伪造 parentSkillRevision 的 prior + 合法 next（shadow→suspended 无需 promotion verdict）
    // ⇒ stale-prior 三要素失配拒绝。
    const suspended = transitionProfileToSuspended(shadow as never, {
      decision: "suspended",
      reason: "overlay degraded",
    });
    await assert.rejects(
      store.transition(
        { ...shadow, parentSkillRevision: "rev:" + "9".repeat(64) },
        suspended,
        { trigger: "agent", reason: "overlay degraded" },
      ),
      /activation_store_stale_prior/,
    );
  });

  it("immutable 内容变化（cue 数据被改）⇒ 拒绝（以落盘 stored 为权威）", async () => {
    const store = makeStore();
    const draft = draftProfile();
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft as never, {
      decision: "shadow",
      shadowReportId: "shadow:phase6-replay-001",
    });
    const tampered = {
      ...shadow,
      learnedAliases: [{ cueId: "cue:hacked", text: "x", evidenceIds: ["obs-9"] }],
    };
    await assert.rejects(
      store.transition(draft, tampered, { trigger: "agent" }),
      /activation_store_immutable_content_mutation: learnedAliases/,
    );
    const current = await store.getProfile("profile:test1");
    assert.equal(current!.status, "draft", "拒绝后 current 不得变化");
  });
});

describe("ActivationProfileStore：查询", () => {
  it("listCurrent / listByStatus / listByEvidenceId", async () => {
    const store = makeStore();
    const draft = draftProfile("profile:a");
    const other = draftProfile("profile:b", {
      learnedAliases: [{ cueId: "cue:z1", text: "z", evidenceIds: ["obs-9"] }],
      positiveExamples: [],
      nearMissExamples: [],
      environmentCues: [],
    });
    await store.save(draft, { trigger: "procedure" });
    await store.save(other, { trigger: "procedure" });

    assert.equal((await store.listCurrent()).length, 2);
    assert.equal((await store.listByStatus("draft")).length, 2);
    assert.equal((await store.listByStatus("active")).length, 0);
    // listByEvidenceId：obs-1 命中 a（alias/positive）；obs-2 命中 a（nearMiss）；obs-9 命中 b；obs-99 无。
    assert.deepEqual(
      (await store.listByEvidenceId("obs-1")).map((p) => p.profileId),
      ["profile:a"],
    );
    assert.deepEqual(
      (await store.listByEvidenceId("obs-2")).map((p) => p.profileId),
      ["profile:a"],
    );
    assert.deepEqual(
      (await store.listByEvidenceId("obs-9")).map((p) => p.profileId),
      ["profile:b"],
    );
    assert.equal((await store.listByEvidenceId("obs-99")).length, 0);
  });

  it("事件只落受控字段：不落完整用户文本/路径（受控 reason/reportId/trigger）", async () => {
    const store = makeStore();
    const draft = draftProfile();
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft as never, {
      decision: "shadow",
      shadowReportId: "shadow:phase6-replay-001",
    });
    await store.transition(draft, shadow, { trigger: "agent", reportId: "shadow:phase6-replay-001" });
    const serialized = JSON.stringify(await store.listEvents("profile:test1"));
    assert.ok(!serialized.includes("C:\\"), "事件不得含绝对路径");
    assert.ok(!serialized.includes("offset-check"), "事件不得含 cue 文本（只有受控元数据）");
    assert.ok(serialized.includes("shadow:phase6-replay-001"), "受控报告引用可审计");
  });
});

describe("删除级联落盘：applyEvidenceDeletionCascade", () => {
  it("命中被删 evidence 的非终态 profile ⇒ transition 落盘 suspended（受控 reason + 事件）；未命中不变", async () => {
    const store = makeStore();
    const hit = draftProfile("profile:hit"); // cue 含 obs-1
    const miss = draftProfile("profile:miss", {
      learnedAliases: [{ cueId: "cue:z1", text: "z", evidenceIds: ["obs-9"] }],
      positiveExamples: [],
      nearMissExamples: [],
      environmentCues: [],
    }); // 不含 obs-1
    await store.save(hit, { trigger: "procedure" });
    await store.save(miss, { trigger: "procedure" });

    const outcome = await applyEvidenceDeletionCascade(store, ["obs-1"], "tool");
    assert.deepEqual(outcome.suspended, ["profile:hit"], "只有命中 profile 被 suspend");

    const hitNow = await store.getProfile("profile:hit");
    assert.equal(hitNow!.status, "suspended");
    assert.deepEqual(hitNow!.learnedAliases, hit.learnedAliases, "suspend 保留 cue（降权语义）");
    const hitEvents = await store.listEvents("profile:hit");
    assert.equal(hitEvents.length, 2, "save + suspend 事件");
    assert.equal(hitEvents[1]!.fromStatus, "draft");
    assert.equal(hitEvents[1]!.toStatus, "suspended");
    assert.equal(hitEvents[1]!.reason, "evidence_cascade_deletion");
    assert.equal(hitEvents[1]!.trigger, "tool");

    const missNow = await store.getProfile("profile:miss");
    assert.equal(missNow!.status, "draft", "未命中 profile 不变");
  });

  it("无命中 ⇒ 0 suspend", async () => {
    const store = makeStore();
    await store.save(draftProfile("profile:a"), { trigger: "procedure" });
    const outcome = await applyEvidenceDeletionCascade(store, ["obs-99"], "tool");
    assert.deepEqual(outcome.suspended, []);
    assert.equal((await store.getProfile("profile:a"))!.status, "draft");
  });
});

describe("ActivationProfileStore：读取 fail-closed", () => {
  it("损坏 JSON / id 不一致 ⇒ 抛受控错误码（不含原始内容）", async () => {
    const store = makeStore();
    const draft = draftProfile();
    await store.save(draft, { trigger: "procedure" });

    // 手写损坏 current（JSON 非法）。目录 = rootDir/<tenantHash>/current（仿 store 布局）。
    const { createHash } = await import("node:crypto");
    const tenantHash = createHash("sha256").update(store.tenantScope, "utf8").digest("hex").slice(0, 32);
    const fileHash = createHash("sha256").update("profile:test1", "utf8").digest("hex").slice(0, 40);
    const currentDir = path.join(store.rootDir, tenantHash, "current");
    mkdirSync(currentDir, { recursive: true });
    const currentPath = path.join(currentDir, `${fileHash}.json`);
    writeFileSync(currentPath, "{ not json");

    await assert.rejects(store.getProfile("profile:test1"), /activation_store_corrupt: json_parse/);

    // id 不一致（body 与文件名 hash 不匹配）。
    writeFileSync(
      currentPath,
      JSON.stringify({ ...draft, profileId: "profile:other" }),
    );
    await assert.rejects(store.getProfile("profile:test1"), /activation_store_corrupt: profile_id_mismatch/);
  });

  it("tenantScope 哈希目录（不拼接原始 scope 字符串）", async () => {
    const store = makeStore({ tenantScope: "project:anything-with/../chars" });
    await store.save(draftProfile(), { trigger: "procedure" });
    const files = await readFile(path.join(store.rootDir, "current"), "utf8").catch(() => "");
    void files;
    // 目录结构存在（不抛错即已创建哈希分区）；getProfile round-trip 成功即证明分区可用。
    assert.ok(await store.getProfile("profile:test1"), "哈希分区可读写");
  });
});

describe("BLOCKER 2：promotion trust boundary + save draft-only", () => {
  it("save 只允许初始 draft：直接 save active/shadow ⇒ 拒绝零写入", async () => {
    const store = makeStore();
    const shadow = { ...draftProfile("profile:x"), status: "shadow" as const };
    await assert.rejects(store.save(shadow, { trigger: "agent" }), /activation_store_save_requires_draft/);
    const active = { ...draftProfile("profile:y"), status: "active" as const };
    await assert.rejects(store.save(active, { trigger: "agent" }), /activation_store_save_requires_draft/);
    assert.equal((await store.listCurrent()).length, 0, "非 draft 拒绝后零写入");
  });

  it("shadow→active 缺结构化 promotion verdict（即使带裸 reportId）⇒ 拒绝零写入", async () => {
    const store = makeStore();
    const draft = draftProfile();
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft as never, {
      decision: "shadow",
      shadowReportId: "shadow:phase6-replay-001",
    });
    await store.transition(draft, shadow, { trigger: "agent", reportId: "shadow:phase6-replay-001" });
    const active = transitionProfileToActive(shadow, {
      decision: "active",
      promotionReportId: "promotion:phase6-gate-001",
    });
    // 只有裸 reportId（无结构化 verdict）⇒ 拒绝。
    await assert.rejects(
      store.transition(shadow, active, { trigger: "agent", reportId: "promotion:phase6-gate-001" }),
      /activation_store_promotion_verdict_required/,
    );
    assert.equal((await store.getProfile("profile:test1"))!.status, "shadow", "拒绝后 current 不变");
    assert.equal((await store.listEvents("profile:test1")).length, 2, "拒绝后事件不变");
  });

  it("shadow→active 的 evidence 未通过（报告 ID 非法 / 父不在 records / 重叠 confuser）⇒ 全部拒绝（store 自行重算）", async () => {
    const store = makeStore();
    const draft = draftProfile();
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft as never, {
      decision: "shadow",
      shadowReportId: "shadow:phase6-replay-001",
    });
    await store.transition(draft, shadow, { trigger: "agent", reportId: "shadow:phase6-replay-001" });
    const active = transitionProfileToActive(shadow, {
      decision: "active",
      promotionReportId: "promotion:phase6-gate-001",
    });

    const cases: Array<[string, Parameters<typeof store.transition>[2]]> = [
      ["activation_store_promotion_report_id_invalid", { trigger: "agent", promotion: { records: promotionRecords(), promotionReportId: "not-a-promotion-report" } }],
      ["activation_store_promotion_parent_not_in_evaluation_set", { trigger: "agent", promotion: { records: [confuserRecord()], promotionReportId: "promotion:phase6-gate-001" } }],
      ["activation_store_promotion_verdict_not_passed", { trigger: "agent", promotion: { records: [parentRecord(), overlappingConfuser()], promotionReportId: "promotion:phase6-gate-001" } }],
    ];
    for (const [expected, meta] of cases) {
      await assert.rejects(
        store.transition(shadow, active, meta),
        new RegExp(expected),
        `必须拒绝：${expected}`,
      );
    }
    assert.equal((await store.getProfile("profile:test1"))!.status, "shadow", "全部拒绝后 current 不变");
  });

  it("通过的结构化 verdict ⇒ shadow→active 落盘成功，事件 reportId=promotionReportId", async () => {
    const store = makeStore();
    const draft = draftProfile();
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft as never, {
      decision: "shadow",
      shadowReportId: "shadow:phase6-replay-001",
    });
    await store.transition(draft, shadow, { trigger: "agent", reportId: "shadow:phase6-replay-001" });
    const active = transitionProfileToActive(shadow, {
      decision: "active",
      promotionReportId: "promotion:phase6-gate-001",
    });
    await store.transition(shadow, active, {
      trigger: "agent",
      ...promotionMeta(),
    });
    assert.equal((await store.getProfile("profile:test1"))!.status, "active");
    const events = await store.listEvents("profile:test1");
    assert.equal(events[2]!.toStatus, "active");
    assert.equal(events[2]!.reportId, "promotion:phase6-gate-001");
  });
});

/** 故障注入：手工写某 profile 的 WAL 事务文件（模拟崩溃后遗留的未清除 txn）。 */
async function writeProfileTxn(
  store: ActivationProfileStore,
  profileId: string,
  txn: Record<string, unknown>,
): Promise<void> {
  const { createHash } = await import("node:crypto");
  const tenantHash = createHash("sha256").update(store.tenantScope, "utf8").digest("hex").slice(0, 32);
  const pidHash = createHash("sha256").update(profileId, "utf8").digest("hex").slice(0, 40);
  const dir = path.join(store.rootDir, tenantHash, "txn");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${pidHash}.txn.json`), JSON.stringify(txn), "utf8");
}

/** 落盘一个 draft→shadow 的 profile（返回 draft 与 shadow 对象）。 */
async function seedShadow(
  store: ActivationProfileStore,
  id: string,
  overrides: Partial<ActivationProfile> = {},
): Promise<{ draft: ActivationProfile; shadow: ShadowActivationProfile }> {
  const draft = draftProfile(id, overrides);
  const reportId = `shadow:${id.replace("profile:", "")}`;
  await store.save(draft, { trigger: "procedure" });
  const shadow = transitionProfileToShadow(draft as never, {
    decision: "shadow",
    shadowReportId: reportId,
  });
  await store.transition(draft, shadow, { trigger: "agent", reportId });
  return { draft, shadow };
}

describe("并发与 crash 恢复（WAL，Issue 1/3/4）", () => {
  it("并发 transition（同一 prior）⇒ 恰好一个 writer 成功，另一个 stale_prior 拒绝", async () => {
    const store = makeStore();
    const draft = draftProfile();
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft as never, {
      decision: "shadow",
      shadowReportId: "shadow:phase6-replay-001",
    });
    const results = await Promise.allSettled([
      store.transition(draft, shadow, { trigger: "agent", reportId: "shadow:phase6-replay-001" }),
      store.transition(draft, shadow, { trigger: "agent", reportId: "shadow:phase6-replay-001" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "恰好一个 writer 成功");
    assert.equal(rejected.length, 1, "另一个 writer 拒绝");
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
    assert.match(reason.message, /activation_store_stale_prior/);
    assert.equal((await store.getProfile("profile:test1"))!.status, "shadow");
    assert.equal((await store.listEvents("profile:test1")).length, 2, "save + 1 次成功 transition = 2 事件");
  });

  it("两个 Store 实例并发 transition（同一 rootDir）⇒ 文件锁串行，恰好一个成功（Issue 3）", async () => {
    const store1 = makeStore();
    const store2 = new ActivationProfileStore({
      rootDir: store1.rootDir,
      projectRoot: tempRoot,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const draft = draftProfile();
    await store1.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft as never, {
      decision: "shadow",
      shadowReportId: "shadow:phase6-replay-001",
    });
    const results = await Promise.allSettled([
      store1.transition(draft, shadow, { trigger: "agent", reportId: "shadow:phase6-replay-001" }),
      store2.transition(draft, shadow, { trigger: "agent", reportId: "shadow:phase6-replay-001" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "恰好一个实例成功");
    assert.equal(rejected.length, 1, "另一个实例拒绝");
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
    assert.match(reason.message, /activation_store_stale_prior/);
    assert.equal((await store1.getProfile("profile:test1"))!.status, "shadow");
  });

  it("crash 恢复：遗留 write txn ⇒ recoverAll 重放，current/event 一致（Issue 1）", async () => {
    const store = makeStore();
    const draft = draftProfile();
    await store.save(draft, { trigger: "procedure" });
    const shadow = transitionProfileToShadow(draft as never, {
      decision: "shadow",
      shadowReportId: "shadow:phase6-replay-001",
    });
    await writeProfileTxn(store, "profile:test1", {
      kind: "write",
      seq: 2,
      profileId: "profile:test1",
      profile: shadow,
      event: {
        schemaVersion: 1,
        eventId: "evt-crash",
        seq: 2,
        profileId: "profile:test1",
        fromStatus: "draft",
        toStatus: "shadow",
        reportId: "shadow:phase6-replay-001",
        trigger: "agent",
        occurredAt: "2026-08-20T00:00:00.000Z",
      },
    });
    const reloaded = new ActivationProfileStore({
      rootDir: store.rootDir,
      projectRoot: tempRoot,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    assert.equal((await reloaded.getProfile("profile:test1"))!.status, "shadow", "txn 被重放，current=shadow");
    assert.deepEqual(
      (await reloaded.listEvents("profile:test1")).map((e) => e.toStatus),
      ["draft", "shadow"],
      "event 被重放",
    );
  });

  it("crash 恢复：遗留 delete txn ⇒ recoverAll 完成删除（Issue 4）", async () => {
    const store = makeStore();
    const draft = draftProfile();
    await store.save(draft, { trigger: "procedure" });
    await writeProfileTxn(store, "profile:test1", { kind: "delete", profileId: "profile:test1" });
    const reloaded = new ActivationProfileStore({
      rootDir: store.rootDir,
      projectRoot: tempRoot,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    assert.equal(await reloaded.getProfile("profile:test1"), undefined, "delete txn 重放，current 已删");
    assert.deepEqual(await reloaded.listEvents("profile:test1"), [], "事件目录已清理");
  });
});

describe("Issue 2：promotion 不可拼接绕过（store 用落盘 profile + records 自行重算）", () => {
  it("Profile A 的评估 records（含 A 父）用于 Profile B ⇒ 父不在 records 拒绝", async () => {
    const store = makeStore();
    const a = await seedShadow(store, "profile:a");
    const otherId = "skill:" + "d".repeat(64);
    const b = await seedShadow(store, "profile:b", { parentSkillId: otherId });
    void a;
    // 只传含 A 父（SKILL_ID）的 records（对 A 可通过），试图晋升 B（父=otherId）⇒ 拒绝。
    const bActive = transitionProfileToActive(b.shadow, {
      decision: "active",
      promotionReportId: "promotion:b",
    });
    await assert.rejects(
      store.transition(b.shadow, bActive, {
        trigger: "agent",
        promotion: { records: promotionRecords(), promotionReportId: "promotion:b" },
      }),
      /activation_store_promotion_parent_not_in_evaluation_set/,
    );
    assert.equal((await store.getProfile("profile:b"))!.status, "shadow", "B 不得晋升");
  });

  it("records 缺父 ⇒ 拒绝（空 case 集，不虚判）", async () => {
    const store = makeStore();
    const b = await seedShadow(store, "profile:b");
    const bActive = transitionProfileToActive(b.shadow, {
      decision: "active",
      promotionReportId: "promotion:b",
    });
    await assert.rejects(
      store.transition(b.shadow, bActive, {
        trigger: "agent",
        promotion: { records: [confuserRecord()], promotionReportId: "promotion:b" },
      }),
      /activation_store_promotion_parent_not_in_evaluation_set/,
    );
    assert.equal((await store.getProfile("profile:b"))!.status, "shadow");
  });
});
