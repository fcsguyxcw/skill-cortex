/**
 * Phase 2 Practice Store 测试（node:test，仅 node 内置模块 + 项目内模块）。
 *
 * 验收覆盖：append+roundtrip、重复 ID（不可覆盖）、四分区隔离、tenant 隔离、
 * production query 排除三类、tombstone 后查询不可见且返回 invalidated ids、
 * path traversal tenant 不逃逸、并发 append 不丢事件（单进程 Promise 并发）、
 * 白名单校验拒绝（sensitivity/retentionClass/schemaVersion/provenance）。
 *
 * 临时数据：mkdtemp 于项目根（project-local），after() 用 fs/promises.rm 清理；
 * 不触碰用户 ~/.pi/.codex/.agents。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { PracticeEvent } from "../../core/contracts/index.ts";
import { validatePracticeEvent } from "../policy/index.ts";
import { PracticeStore, PROVENANCES } from "./index.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-practice-test-"));
  tempDirs.push(dir);
  return dir;
}

/** 探测本环境能否创建 Windows junction（普通用户可创建，无需提权）。 */
function probeJunction(): boolean {
  const root = makeTempDir();
  const target = path.join(root, "probe-target");
  mkdirSync(target, { recursive: true });
  const link = path.join(root, "probe-link");
  try {
    symlinkSync(target, link, "junction");
    return true;
  } catch {
    return false;
  }
}

const JUNCTION_SUPPORTED = probeJunction();
const SKIP_NO_JUNCTION = JUNCTION_SUPPORTED
  ? false
  : "junction 创建不可用（跳过；不伪通过）";

/**
 * store 应持久化的形态（契约镜像）：policy 正规化 + 白名单复制。
 * attribution/failureClass/firstAttributableFailureStepId 用 policy 计算值；
 * computed failureClass=unknown（无失败信号）时省略 optional failureClass。
 */
function expectedPersisted(event: PracticeEvent): PracticeEvent {
  const result = validatePracticeEvent(event);
  assert.equal(result.ok, true, "makeEvent fixture 必须通过 policy");
  const normalized: PracticeEvent = {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    tenantScope: event.tenantScope,
    provenance: event.provenance,
    parentSkillId: event.parentSkillId,
    parentSkillRevision: event.parentSkillRevision,
    sourceHash: event.sourceHash,
    candidateSkillIds: [...event.candidateSkillIds],
    selectedSkillIds: [...event.selectedSkillIds],
    executionMode: event.executionMode,
    redactedTaskFeatures: [...event.redactedTaskFeatures],
    stepSummaries: event.stepSummaries.map((s) => ({
      stepId: s.stepId,
      actor: s.actor,
      operationClass: s.operationClass,
      outcome: s.outcome,
    })),
    authorizationResults: event.authorizationResults.map((a) => ({ gateId: a.gateId, result: a.result })),
    guardResults: event.guardResults.map((g) => ({
      predicateId: g.predicateId,
      phase: g.phase,
      result: g.result,
    })),
    verifierResults: event.verifierResults.map((v) => ({
      verifierId: v.verifierId,
      result: v.result,
      ...(v.observedEffect !== undefined ? { observedEffect: v.observedEffect } : {}),
    })),
    attribution: result.attribution,
    sensitivity: event.sensitivity,
    retentionClass: event.retentionClass,
    ...(event.routeDecisionId !== undefined ? { routeDecisionId: event.routeDecisionId } : {}),
    ...(event.procedureId !== undefined ? { procedureId: event.procedureId } : {}),
    ...(event.environmentFingerprint !== undefined
      ? { environmentFingerprint: event.environmentFingerprint }
      : {}),
    ...(event.dependencyFingerprint !== undefined
      ? {
          dependencyFingerprint: {
            sourceHash: event.dependencyFingerprint.sourceHash,
            ...(event.dependencyFingerprint.toolSchemaHash !== undefined
              ? { toolSchemaHash: event.dependencyFingerprint.toolSchemaHash }
              : {}),
            ...(event.dependencyFingerprint.permissionPolicyHash !== undefined
              ? { permissionPolicyHash: event.dependencyFingerprint.permissionPolicyHash }
              : {}),
            ...(event.dependencyFingerprint.environmentClass !== undefined
              ? { environmentClass: event.dependencyFingerprint.environmentClass }
              : {}),
            ...(event.dependencyFingerprint.modelId !== undefined
              ? { modelId: event.dependencyFingerprint.modelId }
              : {}),
            ...(event.dependencyFingerprint.promptHash !== undefined
              ? { promptHash: event.dependencyFingerprint.promptHash }
              : {}),
          },
        }
      : {}),
  };
  if (result.failureClass !== "unknown") {
    normalized.failureClass = result.failureClass;
  }
  if (result.firstAttributableFailureStepId !== undefined) {
    normalized.firstAttributableFailureStepId = result.firstAttributableFailureStepId;
  }
  return normalized;
}

let seq = 0;

/** policy 要求完整 sha256（64 hex）。 */
const SOURCE_HASH = "sha256:" + "0".repeat(64);

/** 构造完整合法的 PracticeEvent（sensitivity=none、retentionClass=project_manual）。 */
function makeEvent(overrides: Partial<PracticeEvent> = {}): PracticeEvent {
  seq += 1;
  return {
    schemaVersion: 1,
    eventId: `evt-${seq.toString().padStart(6, "0")}`,
    occurredAt: "2026-08-14T00:00:00.000Z",
    tenantScope: "project:demo",
    provenance: "real",
    parentSkillId: "skill:aaa",
    parentSkillRevision: "rev:bbb",
    sourceHash: SOURCE_HASH,
    candidateSkillIds: [],
    selectedSkillIds: ["skill:aaa"],
    executionMode: "skill_md",
    redactedTaskFeatures: ["create docx"],
    stepSummaries: [
      { stepId: "s1", actor: "agent", operationClass: "read", outcome: "ok" },
    ],
    authorizationResults: [{ gateId: "g1", result: "approved" }],
    guardResults: [{ predicateId: "p1", phase: "precondition", result: "pass" }],
    verifierResults: [{ verifierId: "v1", result: "pass", observedEffect: "schema-ok" }],
    attribution: "verified_skill_effect",
    sensitivity: "none",
    retentionClass: "project_manual",
    ...overrides,
  };
}

describe("PracticeStore append + roundtrip", () => {
  it("append 后 getEvent 读回；attribution 用 policy 值，无失败信号时 failureClass=unknown 省略", async () => {
    const root = makeTempDir();
    const store = new PracticeStore({ rootDir: root });
    const event = makeEvent({ redactedTaskFeatures: ["create", "report"], stepSummaries: [] });
    await store.append(event);

    const round = await store.getEvent(event.tenantScope, event.eventId);
    assert.ok(round, "事件必须可读回");
    assert.deepEqual(round, expectedPersisted(event));
    assert.equal(round.attribution, "verified_skill_effect");
    // 无失败信号：computed failureClass=unknown 被省略（不落键）
    assert.equal(round.failureClass, undefined);

    // undefined 字段真正省略：磁盘 JSON 不含 firstAttributableFailureStepId / failureClass 键
    const hashDirs = readdirSync(root);
    assert.equal(hashDirs.length, 1);
    const raw = JSON.parse(
      await readFile(path.join(root, hashDirs[0]!, "real", `${event.eventId}.json`), "utf8"),
    ) as Record<string, unknown>;
    assert.ok(!("firstAttributableFailureStepId" in raw), "undefined 字段必须省略（不落键）");
    assert.ok(!("failureClass" in raw), "unknown failureClass 必须省略（不落键）");
  });

  it("同 eventId 重复 append 被拒绝，且事件本体不变（不可覆盖）", async () => {
    const store = new PracticeStore({ rootDir: makeTempDir() });
    const event = makeEvent({ eventId: "evt-dupe" });
    await store.append(event);

    await assert.rejects(
      store.append(makeEvent({ eventId: "evt-dupe", attribution: "mixed" })),
      /already exists/,
    );
    const round = await store.getEvent(event.tenantScope, "evt-dupe");
    assert.deepEqual(round, expectedPersisted(event), "原事件不得被覆盖");
  });

  it("policy/store 校验：sensitivity/retentionClass/schemaVersion/provenance 非法即拒绝（稳定错误码）", async () => {
    const store = new PracticeStore({ rootDir: makeTempDir() });
    // policy gate 拒绝：稳定错误码摘要，不回显原始值
    await assert.rejects(
      store.append(makeEvent({ sensitivity: "internal" })),
      /practice_event_rejected: .*sensitivity/,
    );
    await assert.rejects(
      store.append(makeEvent({ retentionClass: "ttl_30d" })),
      /practice_event_rejected: .*retention_class/,
    );
    await assert.rejects(
      store.append(makeEvent({ schemaVersion: 2 as never })),
      /practice_event_rejected: .*schema_version/,
    );
    // policy 已覆盖 provenance 枚举（provenance_invalid）；store 准入白名单仍作第二道防线
    await assert.rejects(
      store.append(makeEvent({ provenance: "production" as never })),
      /provenance/,
    );
  });

  it("eventId 含 path traversal 载荷 ⇒ policy 拒绝（稳定错误码 event_id_invalid）", async () => {
    const store = new PracticeStore({ rootDir: makeTempDir() });
    await assert.rejects(
      store.append(makeEvent({ eventId: "../../escape" })),
      /practice_event_rejected: .*event_id_invalid/,
    );
    await assert.rejects(
      store.append(makeEvent({ eventId: "a\\b" })),
      /practice_event_rejected: .*event_id_invalid/,
    );
  });
});

describe("四分区隔离", () => {
  it("四种 provenance 物理分区，互不串扰；queryEvidence 只见 real", async () => {
    const root = makeTempDir();
    const store = new PracticeStore({ rootDir: root });
    const tenant = "project:demo";
    const events: PracticeEvent[] = PROVENANCES.map((provenance) =>
      makeEvent({ provenance, eventId: `evt-${provenance}` }),
    );
    for (const event of events) {
      await store.append(event);
    }

    for (const provenance of PROVENANCES) {
      const listed = await store.listProvenance(tenant, provenance);
      assert.equal(listed.length, 1, `${provenance} 分区应只有自己的事件`);
      assert.equal(listed[0]!.eventId, `evt-${provenance}`);
    }

    const evidence = await store.queryEvidence(tenant);
    assert.deepEqual(
      evidence.map((e) => e.eventId),
      ["evt-real"],
      "production evidence query 只能返回 real",
    );
  });
});

describe("tenant 隔离", () => {
  it("project/user scope 的事件互不可见；目录名不含原始 tenant 字符串", async () => {
    const root = makeTempDir();
    const store = new PracticeStore({ rootDir: root });
    const eventA = makeEvent({ tenantScope: "project:alpha", eventId: "evt-a" });
    const eventB = makeEvent({ tenantScope: "user:alpha", eventId: "evt-b" });
    await store.append(eventA);
    await store.append(eventB);

    const evidenceA = await store.queryEvidence("project:alpha");
    assert.deepEqual(
      evidenceA.map((e) => e.eventId),
      ["evt-a"],
    );
    assert.equal(await store.getEvent("project:alpha", "evt-b"), undefined);
    assert.equal(await store.getEvent("user:alpha", "evt-a"), undefined);

    // store 根下只有 64-hex 目录名，绝不出现原始 tenant 字符串
    const entries = readdirSync(root);
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.match(entry, /^[0-9a-f]{64}$/);
      assert.ok(!entry.includes("alpha") && !entry.includes("project") && !entry.includes("user"));
    }
  });
});

describe("production query 排除三类 + tombstone", () => {
  it("queryEvidence 绝不包含 evaluation/synthetic/shadow", async () => {
    const store = new PracticeStore({ rootDir: makeTempDir() });
    const tenant = "project:demo";
    for (const provenance of ["real", "shadow", "evaluation", "synthetic"] as const) {
      await store.append(makeEvent({ provenance, eventId: `evt-${provenance}` }));
    }
    const evidence = await store.queryEvidence(tenant);
    assert.deepEqual(
      evidence.map((e) => e.eventId),
      ["evt-real"],
    );
  });

  it("invalidate 物理删除事件本体 + 保留 tombstone；getEvent/query/list 均不可见；幂等；不制造虚假失效", async () => {
    const root = makeTempDir();
    const store = new PracticeStore({ rootDir: root });
    const tenant = "project:demo";
    await store.append(makeEvent({ eventId: "evt-keep" }));
    await store.append(makeEvent({ eventId: "evt-drop" }));

    const result = await store.invalidate(tenant, ["evt-drop"]);
    assert.deepEqual(result.invalidatedEventIds, ["evt-drop"]);

    // query/list/getEvent 均不可见
    const evidence = await store.queryEvidence(tenant);
    assert.deepEqual(evidence.map((e) => e.eventId), ["evt-keep"]);
    assert.equal(await store.getEvent(tenant, "evt-drop"), undefined);
    const realList = await store.listProvenance(tenant, "real");
    assert.deepEqual(realList.map((e) => e.eventId), ["evt-keep"]);

    // 事件本体文件已物理删除；tombstone 审计保留（不含事件内容）
    const hashDirs = readdirSync(root);
    assert.equal(hashDirs.length, 1);
    const tenantHashDir = hashDirs[0]!;
    const realFiles = readdirSync(path.join(root, tenantHashDir, "real")).sort();
    assert.deepEqual(realFiles, ["evt-keep.json"], "被删除事件的本体文件必须物理移除");
    const tombstoneRaw = JSON.parse(
      await readFile(path.join(root, tenantHashDir, "tombstones", "evt-drop.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(tombstoneRaw.eventId, "evt-drop");
    assert.ok(!("redactedTaskFeatures" in tombstoneRaw), "tombstone 不得含事件内容");
    assert.ok(!("stepSummaries" in tombstoneRaw), "tombstone 不得含事件内容");

    // 幂等：重复 invalidate 同样返回该 id，不报错
    const again = await store.invalidate(tenant, ["evt-drop"]);
    assert.deepEqual(again.invalidatedEventIds, ["evt-drop"]);

    // 不存在的 id 不制造虚假 evidence invalidation
    const ghost = await store.invalidate(tenant, ["evt-ghost"]);
    assert.deepEqual(ghost.invalidatedEventIds, []);
  });
});

describe("eventId 跨 provenance 全局唯一（claims seam）", () => {
  it("串行：同 tenant 下不同 provenance 同 ID 第二次被拒绝", async () => {
    const store = new PracticeStore({ rootDir: makeTempDir() });
    const tenant = "project:demo";
    await store.append(makeEvent({ provenance: "real", eventId: "evt-x" }));
    await assert.rejects(
      store.append(makeEvent({ provenance: "shadow", eventId: "evt-x" })),
      /already exists/,
    );
    await assert.rejects(
      store.append(makeEvent({ provenance: "evaluation", eventId: "evt-x" })),
      /already exists/,
    );
    // 原事件保持
    assert.equal((await store.getEvent(tenant, "evt-x"))?.provenance, "real");
  });

  it("Promise 并发：跨分区同 ID 恰好一个成功（claims wx 仲裁）", async () => {
    const store = new PracticeStore({ rootDir: makeTempDir() });
    const tenant = "project:demo";
    const results = await Promise.allSettled([
      store.append(makeEvent({ provenance: "real", eventId: "evt-race" })),
      store.append(makeEvent({ provenance: "synthetic", eventId: "evt-race" })),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  });

  it("删除后 ID 不得被静默复用（claim 保留）", async () => {
    const store = new PracticeStore({ rootDir: makeTempDir() });
    const tenant = "project:demo";
    await store.append(makeEvent({ eventId: "evt-z" }));
    await store.invalidate(tenant, ["evt-z"]);
    await assert.rejects(
      store.append(makeEvent({ eventId: "evt-z" })),
      /already exists/,
    );
  });
});

describe("project-local 强制", () => {
  it("词法 ../ 外部路径 ⇒ 构造即拒绝", () => {
    assert.throws(
      () => new PracticeStore({ rootDir: path.join(process.cwd(), "..", "outside-store") }),
      /inside projectRoot/,
    );
  });

  it("rootDir 为 junction 指向 projectRoot 外（仓库内目标）⇒ 首次 I/O 拒绝", { skip: SKIP_NO_JUNCTION }, async () => {
    const base = makeTempDir(); // 项目内
    const projectRoot = path.join(base, "proj-a");
    await mkdir(projectRoot, { recursive: true });
    const outside = path.join(base, "outside-target"); // projectRoot 外、仓库内
    await mkdir(outside, { recursive: true });
    const storeRootLink = path.join(projectRoot, "store-link");
    symlinkSync(outside, storeRootLink, "junction");

    const store = new PracticeStore({ rootDir: storeRootLink, projectRoot });
    await assert.rejects(store.append(makeEvent()), /resolves outside projectRoot/);
  });
});

describe("path traversal tenant 不逃逸", () => {
  it("tenantScope 含 ../ 由 policy 在任何写入前拒绝（tenant_scope_invalid），store root 保持为空", async () => {
    const root = makeTempDir();
    const store = new PracticeStore({ rootDir: root });
    const evil = "../escape";
    await assert.rejects(
      store.append(makeEvent({ tenantScope: evil, eventId: "evt-x" })),
      /practice_event_rejected: .*tenant_scope_invalid/,
    );
    // policy 在任何 mkdir/write 前拒绝：store 根下不得出现 tenant/event/claim 文件
    assert.deepEqual(readdirSync(root), [], "policy 拒绝后 store root 必须为空");
  });

  it("getEvent/invalidate 的 eventId 含路径分隔符 ⇒ 拒绝", async () => {
    const store = new PracticeStore({ rootDir: makeTempDir() });
    await assert.rejects(store.getEvent("project:demo", "a/b"), /eventId is invalid/);
    await assert.rejects(store.invalidate("project:demo", ["../x"]), /eventId is invalid/);
  });
});

describe("并发 append（单进程 Promise 并发）", () => {
  it("并发不同 eventId 全部落盘，queryEvidence 不丢事件", async () => {
    const store = new PracticeStore({ rootDir: makeTempDir() });
    const tenant = "project:demo";
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ eventId: `evt-conc-${i.toString().padStart(2, "0")}` }),
    );
    await Promise.all(events.map((event) => store.append(event)));

    const evidence = await store.queryEvidence(tenant);
    assert.equal(evidence.length, 10);
    assert.deepEqual(
      evidence.map((e) => e.eventId),
      [...evidence].map((e) => e.eventId).sort(),
    );
  });

  it("并发同 eventId：恰好一个成功，其余拒绝（不覆盖）", async () => {
    const store = new PracticeStore({ rootDir: makeTempDir() });
    const tenant = "project:demo";
    const first = makeEvent({ eventId: "evt-race" });
    const second = makeEvent({ eventId: "evt-race", attribution: "mixed" });
    const results = await Promise.allSettled([store.append(first), store.append(second)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    assert.equal(fulfilled, 1, "并发同 eventId 只能有一个成功");
    assert.equal(rejected, 1, "另一个必须拒绝（不可覆盖）");

    // O_EXCL 下赢家不确定（两个版本任一完整写入均合法），但只能存在一个且必须是完整版本之一
    const evidence = await store.queryEvidence(tenant);
    assert.equal(evidence.length, 1);
    const winner = evidence[0]!;
    assert.equal(winner.eventId, "evt-race");
    assert.ok(
      winner.attribution === "verified_skill_effect" || winner.attribution === "mixed",
      "获胜者必须是某个完整写入的事件版本",
    );
  });
});

describe("未知字段安全忽略 + 全字段 roundtrip", () => {
  it("append 后磁盘 JSON 真实存在；未知顶层/嵌套字段被安全忽略（不落盘、不回读）", async () => {
    const root = makeTempDir();
    const store = new PracticeStore({ rootDir: root });
    const tenant = "project:demo";
    // 调用方在类型外附加字段：policy 不扫描未知键，若 normalize 直接 spread 会绕过扫描落盘
    const event = makeEvent({ eventId: "evt-extra" }) as PracticeEvent & {
      rawTask?: string;
      rawToolOutput?: string;
    };
    event.rawTask = "Create a docx report then send it via email.";
    event.rawToolOutput = "api_key=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    (event.stepSummaries[0] as unknown as Record<string, unknown>).extraSecret = "sk-DEEP-NESTED-SECRET";
    (event.verifierResults[0] as unknown as Record<string, unknown>).extraOutput = "api_key=sk-VERIFIER-SECRET";
    await store.append(event);

    // 磁盘原始 JSON：合同字段保留，未知键全部丢弃，secret 值不出现
    const dirs = readdirSync(root);
    const rawText = await readFile(path.join(root, dirs[0]!, "real", "evt-extra.json"), "utf8");
    const parsedRaw = JSON.parse(rawText) as Record<string, unknown>;
    assert.equal(parsedRaw.eventId, "evt-extra");
    assert.equal(parsedRaw.sensitivity, "none");
    assert.deepEqual(parsedRaw.redactedTaskFeatures, ["create docx"]);
    for (const key of ["rawTask", "rawToolOutput"]) {
      assert.ok(!(key in parsedRaw), `顶层 ${key} 必须被丢弃`);
    }
    const step0 = (parsedRaw.stepSummaries as Array<Record<string, unknown>>)[0]!;
    assert.ok(!("extraSecret" in step0), "step.extraSecret 必须被丢弃");
    const verifier0 = (parsedRaw.verifierResults as Array<Record<string, unknown>>)[0]!;
    assert.ok(!("extraOutput" in verifier0), "verifier.extraOutput 必须被丢弃");
    assert.ok(!rawText.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "顶层 secret 值不得落盘");
    assert.ok(!rawText.includes("DEEP-NESTED-SECRET"), "嵌套 secret 值不得落盘");

    // roundtrip 同样不含未知键，合同字段保留
    const round = await store.getEvent(tenant, "evt-extra");
    assert.ok(round);
    assert.ok(!("rawTask" in round) && !("rawToolOutput" in round), "roundtrip 不含未知顶层键");
    assert.ok(!("extraSecret" in round.stepSummaries[0]), "roundtrip 不含嵌套未知键");
    assert.ok(!("extraOutput" in round.verifierResults[0]), "roundtrip 不含嵌套未知键");
    assert.equal(round.eventId, "evt-extra");
  });

  it("roundtrip 覆盖全部合同字段（含全部可选字段与失败信号）", async () => {
    const root = makeTempDir();
    const store = new PracticeStore({ rootDir: root });
    const tenant = "project:alpha";
    const event = makeEvent({
      eventId: "evt-full",
      tenantScope: tenant,
      routeDecisionId: "route:r1",
      executionMode: "compiled_procedure",
      procedureId: "proc:p1",
      environmentFingerprint: "node-v24-win32",
      dependencyFingerprint: {
        sourceHash: SOURCE_HASH,
        toolSchemaHash: "sha256:" + "a".repeat(64),
        permissionPolicyHash: "sha256:" + "b".repeat(64),
        environmentClass: "local",
        modelId: "model-x",
        promptHash: "sha256:" + "c".repeat(64),
      },
      stepSummaries: [
        { stepId: "s1", actor: "agent", operationClass: "read", outcome: "ok" },
        { stepId: "s2", actor: "procedure", operationClass: "run", outcome: "failed" },
      ],
      attribution: "mixed", // failed step ⇒ policy 计算 mixed（claimed verified 会被拒）
    });
    await store.append(event);

    const round = await store.getEvent(tenant, "evt-full");
    assert.ok(round);
    assert.deepEqual(round, expectedPersisted(event));
    // 失败信号 ⇒ failureClass 保留（procedure_error，非 unknown），首失败点保留
    assert.equal(round.failureClass, "procedure_error");
    assert.equal(round.firstAttributableFailureStepId, "s2");
    // 全部可选合同字段 roundtrip 保留（白名单未漏掉任何合法字段）
    assert.equal(round.routeDecisionId, "route:r1");
    assert.equal(round.procedureId, "proc:p1");
    assert.equal(round.environmentFingerprint, "node-v24-win32");
    assert.deepEqual(round.dependencyFingerprint, {
      sourceHash: SOURCE_HASH,
      toolSchemaHash: "sha256:" + "a".repeat(64),
      permissionPolicyHash: "sha256:" + "b".repeat(64),
      environmentClass: "local",
      modelId: "model-x",
      promptHash: "sha256:" + "c".repeat(64),
    });
  });
});

describe("policy gate（Store 集成，拒绝不落盘）", () => {
  it("secret/API key/Windows user path/单句完整用户任务/malformed 均被拒绝，store 根下无任何 tenant/event/claim 文件", async () => {
    const root = makeTempDir(); // 已存在且为空
    const store = new PracticeStore({ rootDir: root });
    const tenant = "project:demo";

    const rejected = [
      { name: "secret 键值", event: makeEvent({ redactedTaskFeatures: ["api_key=sk-1234567890abcdefgh"] }) },
      { name: "API key", event: makeEvent({ redactedTaskFeatures: ["use sk-abcdefghijklmnopqrstuvwxyz1234567890"] }) },
      { name: "Windows user path", event: makeEvent({ redactedTaskFeatures: ["file at C:\\Users\\alice\\documents\\plan.docx"] }) },
      { name: "单句完整用户任务", event: makeEvent({ redactedTaskFeatures: ["Please create a report. Send it now."] }) },
      { name: "malformed stepId", event: makeEvent({ stepSummaries: [{ stepId: "", actor: "agent", operationClass: "read", outcome: "ok" }] }) },
      { name: "malformed occurredAt", event: makeEvent({ occurredAt: "" }) },
    ];

    for (const { name, event } of rejected) {
      await assert.rejects(store.append(event), /practice_event_rejected/, `${name} 必须被 policy 拒绝`);
    }

    // 拒绝发生在任何 mkdir/write 之前：store 根下无 tenant/event/claim 文件
    const entries = readdirSync(root);
    assert.deepEqual(entries, [], "policy 拒绝后 store 根下不得有任何 tenant/event/claim 文件");

    // 错误码稳定且不回显原始敏感值
    await assert.rejects(
      store.append(makeEvent({ redactedTaskFeatures: ["api_key=sk-SUPERSECRETVALUE123"] })),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /feature_secret/);
        assert.ok(!message.includes("SUPERSECRETVALUE"), "错误消息不得回显原始敏感值");
        return true;
      },
    );

    // 合法事件仍可存（policy 通过时）；非 real 分区照常存储、queryEvidence 排除
    await store.append(makeEvent({ provenance: "evaluation", eventId: "evt-eval" }));
    await store.append(makeEvent({ provenance: "synthetic", eventId: "evt-syn" }));
    assert.equal((await store.queryEvidence(tenant)).length, 0, "evaluation/synthetic 不进 production query");
    assert.equal((await store.listProvenance(tenant, "evaluation")).length, 1);
    assert.equal((await store.listProvenance(tenant, "synthetic")).length, 1);
  });
});

describe("invalidate 事务顺序（tombstone 先于物理删除）", () => {
  it("rm 失败窗口：tombstone 已写入使查询隐藏，重试仍尝试物理删除（无审计缺口）", async () => {
    const root = makeTempDir();
    const store = new PracticeStore({ rootDir: root });
    const tenant = "project:demo";
    await store.append(makeEvent({ eventId: "evt-tx" }));

    const hashDirs = readdirSync(root);
    assert.equal(hashDirs.length, 1);
    const eventFile = path.join(root, hashDirs[0]!, "real", "evt-tx.json");
    assert.ok(existsSync(eventFile));

    // 模拟 rm 失败：把事件文件替换为同名目录（rm 不带 recursive 对目录抛 EISDIR）
    await rm(eventFile, { force: true });
    await mkdir(eventFile);

    // 第一次 invalidate：tombstone 先写入成功，rm 失败 ⇒ 整体抛错
    await assert.rejects(store.invalidate(tenant, ["evt-tx"]), /EISDIR|EPERM|directory/i);

    // 审计缺口窗口不存在：tombstone 已存在且查询已隐藏
    const tombstonePath = path.join(root, hashDirs[0]!, "tombstones", "evt-tx.json");
    assert.ok(existsSync(tombstonePath), "rm 失败时 tombstone 必须已写入（审计先于删除）");
    assert.deepEqual(await store.queryEvidence(tenant), [], "tombstone 已使查询隐藏");
    assert.ok(existsSync(eventFile), "物理删除未完成（rm 失败），事件文件仍在");

    // 修复状态（目录还原为可删文件）后重试：仍尝试物理删除并成功
    await rm(eventFile, { recursive: true, force: true });
    await writeFile(eventFile, "{\"restored\":true}");
    const retry = await store.invalidate(tenant, ["evt-tx"]);
    assert.deepEqual(retry.invalidatedEventIds, ["evt-tx"]);
    assert.ok(!existsSync(eventFile), "重试必须完成物理删除");
    assert.deepEqual(await store.queryEvidence(tenant), []);
  });
});

describe("读侧 fail-closed（损坏事件稳定拒绝，不回显内容）", () => {
  const tenant = "project:corrupt";
  const SECRET = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";

  /** 先 append 合法种子事件创建目录结构，再向指定分区手工写入损坏文件。 */
  async function seedWithBadFile(
    root: string,
    fileName: string,
    body: unknown,
    provenance: "real" | "shadow" | "evaluation" | "synthetic" = "real",
  ): Promise<{ store: PracticeStore; hashDir: string }> {
    const store = new PracticeStore({ rootDir: root });
    await store.append(makeEvent({ tenantScope: tenant, eventId: "seed" }));
    const hashDir = readdirSync(root).find((d) => /^[0-9a-f]{64}$/.test(d))!;
    assert.ok(hashDir, "种子 append 必须创建 tenant hash 目录");
    const content = typeof body === "string" ? body : JSON.stringify(body);
    await writeFile(path.join(root, hashDir, provenance, `${fileName}.json`), content);
    return { store, hashDir };
  }

  it("非法 JSON 含 secret ⇒ json_parse；错误不回显 secret/绝对路径", async () => {
    const root = makeTempDir();
    const { store } = await seedWithBadFile(root, "bad-json", `{ "x": "${SECRET}", `);
    await assert.rejects(store.queryEvidence(tenant), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /practice_store_corrupt_event: json_parse/);
      assert.ok(!message.includes(SECRET), "错误不得回显 secret");
      assert.ok(!message.includes(root), "错误不得回显绝对路径");
      return true;
    });
  });

  it("合法 JSON 但短 sourceHash ⇒ policy_source_hash_invalid；queryEvidence/getEvent 均拒绝", async () => {
    const root = makeTempDir();
    const bad = { ...makeEvent({ eventId: "bad-short" }), sourceHash: "sha256:short" };
    const { store } = await seedWithBadFile(root, "bad-short", bad);
    await assert.rejects(
      store.queryEvidence(tenant),
      /practice_store_corrupt_event: policy_source_hash_invalid/,
    );
    await assert.rejects(
      store.getEvent(tenant, "bad-short"),
      /practice_store_corrupt_event: policy_source_hash_invalid/,
    );
  });

  it("坏 nested enum（step actor）⇒ policy_step_actor_invalid", async () => {
    const root = makeTempDir();
    const bad = {
      ...makeEvent({ eventId: "bad-enum" }),
      stepSummaries: [{ stepId: "s1", actor: "hacker", operationClass: "read", outcome: "ok" }],
    };
    const { store } = await seedWithBadFile(root, "bad-enum", bad);
    await assert.rejects(
      store.queryEvidence(tenant),
      /practice_store_corrupt_event: policy_step_actor_invalid/,
    );
  });

  it("文件名与 body eventId 不同 ⇒ event_id_mismatch", async () => {
    const root = makeTempDir();
    const body = makeEvent({ eventId: "body-id" });
    const { store } = await seedWithBadFile(root, "file-id", body);
    await assert.rejects(
      store.queryEvidence(tenant),
      /practice_store_corrupt_event: event_id_mismatch/,
    );
  });

  it("分区 provenance 与 body 不同 ⇒ provenance_mismatch（real 分区内 body= synthetic）", async () => {
    const root = makeTempDir();
    const bad = makeEvent({ eventId: "bad-prov", provenance: "synthetic" });
    const { store } = await seedWithBadFile(root, "bad-prov", bad, "real");
    await assert.rejects(
      store.queryEvidence(tenant),
      /practice_store_corrupt_event: provenance_mismatch/,
    );
  });

  it("body tenantScope 与查询不一致 ⇒ tenant_scope_mismatch；listProvenance 同样拒绝", async () => {
    const root = makeTempDir();
    const bad = makeEvent({ eventId: "bad-tenant", tenantScope: "project:other" });
    const { store } = await seedWithBadFile(root, "bad-tenant", bad);
    await assert.rejects(
      store.queryEvidence(tenant),
      /practice_store_corrupt_event: tenant_scope_mismatch/,
    );
    await assert.rejects(
      store.listProvenance(tenant, "real"),
      /practice_store_corrupt_event: tenant_scope_mismatch/,
    );
    // 合法种子事件行为不变：无坏文件时正常返回
    const cleanRoot = makeTempDir();
    const clean = new PracticeStore({ rootDir: cleanRoot });
    await clean.append(makeEvent({ tenantScope: tenant, eventId: "seed" }));
    const evidence = await clean.queryEvidence(tenant);
    assert.deepEqual(evidence.map((e) => e.eventId), ["seed"]);
  });

  it("手工注入的 policy-valid 未知字段在读侧也被白名单剥离", async () => {
    const root = makeTempDir();
    const injected = makeEvent({ tenantScope: tenant, eventId: "manual-extra" }) as PracticeEvent & {
      rawTask?: string;
      stepSummaries: Array<PracticeEvent["stepSummaries"][number] & { extraSecret?: string }>;
    };
    injected.rawTask = SECRET;
    injected.stepSummaries = injected.stepSummaries.map((step) => ({
      ...step,
      extraSecret: SECRET,
    }));
    const { store } = await seedWithBadFile(root, "manual-extra", injected);
    const round = await store.getEvent(tenant, "manual-extra");
    assert.ok(round);
    const serialized = JSON.stringify(round);
    assert.ok(!serialized.includes(SECRET));
    assert.equal("rawTask" in round, false);
    assert.equal("extraSecret" in round.stepSummaries[0]!, false);
  });
});
