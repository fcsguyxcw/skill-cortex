/**
 * Phase 5 host lifecycle E2E（project-local；真实事件源）。
 *
 * 真实事件源（非 mock）：
 * - fixture SKILL.md 由宿主 loadSkillsFromDir 真实读盘加载；
 * - deriveDiscoverySourceHashes 真实计算当次 sourceHash（含 source drift 的重新摄入）；
 * - PracticeStore 真实落盘 practice 事件 + invalidate 返回真实 invalidatedEventIds；
 * - ProcedureStore 真实持久化（含 reload 验证）；
 * - executor 真实执行（fast_path/slow_path）。
 *
 * 覆盖（plan §10 验证清单的 E2E 锚点）：
 * 1. dependency match → active 保持可执行（executor fast_path）；
 * 2. source/tool/permission 相关 drift → 只 suspend 受影响 procedure（source 真实读盘驱动）；
 * 3. Skill uninstall / identity change → 旧 procedure suspend；
 * 4. evidence deletion（真实 invalidate）→ 对应 procedure suspend；
 * 5. unrelated procedure 不受影响；
 * 6. rollback stable + current deps match → 真正落盘恢复 previousStableRevision；
 * 7. rollback stable 仍 drift → 不恢复（slow path）；
 * 8. no stable → parent Skill slow path；
 * 9. store reload → lifecycle/rollback 状态保持。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { rmSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";

import type { CompiledProcedure, DependencyFingerprint, PracticeEvent } from "../../core/contracts/index.ts";
import {
  buildPhase3ProcedureDraft,
  transitionPhase3ProcedureActive,
  transitionPhase3ProcedureCanary,
  transitionPhase3ProcedureSuspend,
  transitionPhase3ProcedureValidation,
  type Phase3ActiveProcedure,
  type Phase3InvalidatableProcedure,
} from "../phase3/index.ts";
import { deriveDiscoverySourceHashes } from "../../adapters/pi/core.ts";
import { ProcedureStore } from "../store/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import { execute } from "../../runtime/executor.ts";
import { createCanaryServices } from "../../evaluation/phase4/canary.ts";
import { rollbackToPreviousStable } from "./index.ts";
import {
  currentFingerprintFromSourceHashes,
  installedSkillIdsFromSkills,
  runHostLifecycle,
} from "./host.ts";

const VALIDATION_REPORT = "validation:phase3-pagination-p3-gate-2026-08-15";
const CANARY_REPORT = "canary:phase3-pagination-p4-gate-2026-08-16";
const ACTIVE_REPORT = "active:phase3-pagination-p4-canary-2026-08-16";
const REFERENCE_HASH = "73c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa";
const FIXTURE_SKILL_REVISION = "rev:" + "2".repeat(64);
const OFFSET_SQL = "SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;";
const EVIDENCE_ID = "evt-000001";

let tempRoot = "";
let storeSeq = 0;

function makeProcedureStore(): ProcedureStore {
  storeSeq += 1;
  return new ProcedureStore({
    rootDir: path.join(tempRoot, `proc-${storeSeq}`),
    projectRoot: tempRoot,
    now: () => new Date("2026-08-20T00:00:00.000Z"),
  });
}

/** 独立 fixture 副本（source drift 场景会修改 SKILL.md，必须每测试隔离）。 */
function makeFixture(name: string, description: string, body: string): { rootDir: string; skills: Skill[] } {
  const rootDir = mkdtempSync(path.join(tempRoot, `fixture-${storeSeq}-${name}-`));
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(
    path.join(rootDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
    "utf8",
  );
  const { skills, diagnostics } = loadSkillsFromDir({ dir: rootDir, source: "user" });
  assert.deepEqual(diagnostics, [], `fixture ${name} 解析无诊断`);
  return { rootDir, skills };
}

/** 从 derive 表取唯一 fixture skill 的 identity（key=skillId，value=sourceHash）。 */
function firstSkill(hashes: ReadonlyMap<string, string>): { skillId: string; sourceHash: string } {
  const entries = [...hashes.entries()];
  assert.equal(entries.length, 1, "每个 fixture 一个 skill");
  return { skillId: entries[0]![0], sourceHash: entries[0]![1] };
}

/** 绑定真实 fixture skill 的 procedure（skillMdHash 来自 derive 真实 sourceHash），落盘到 active。 */
async function persistActiveForSkill(
  store: ProcedureStore,
  skillId: string,
  sourceHash: string,
): Promise<Phase3ActiveProcedure> {
  const draft = buildPhase3ProcedureDraft({
    parentSkillId: skillId,
    parentSkillRevision: FIXTURE_SKILL_REVISION,
    skillMdHash: sourceHash,
    selectedReferenceHash: REFERENCE_HASH,
    createdAt: "2026-08-14T00:00:00.000Z",
    evidenceIds: [EVIDENCE_ID],
  });
  await store.save(draft, { trigger: "agent" });
  const validated = transitionPhase3ProcedureValidation(draft, {
    decision: "validated",
    validationReportId: VALIDATION_REPORT,
  });
  await store.transition(draft, validated, { trigger: "procedure" });
  const canary = transitionPhase3ProcedureCanary(validated, {
    decision: "canary",
    canaryReportId: CANARY_REPORT,
  });
  await store.transition(validated, canary, { trigger: "procedure" });
  const active = transitionPhase3ProcedureActive(canary, {
    decision: "active",
    activeReportId: ACTIVE_REPORT,
  });
  await store.transition(canary, active, { trigger: "tool" });
  return active;
}

function matchingCurrent(procedure: CompiledProcedure): DependencyFingerprint {
  return { ...procedure.dependencyFingerprint };
}

async function executeOutcome(procedure: CompiledProcedure): Promise<"fast_path" | "slow_path"> {
  const outcome = await execute({
    selectedSkill: { skillId: procedure.parentSkillId, skillRevision: procedure.parentSkillRevision },
    procedure,
    environment: {
      executionContext: procedure.status === "active" ? "active" : "shadow_replay",
      currentSkillRevision: procedure.parentSkillRevision,
      currentDependencyFingerprint: procedure.dependencyFingerprint,
      preconditions: [
        { predicateId: "bounded-sql-input", result: true },
        { predicateId: "source-bindings-current", result: true },
      ],
      requestedEffects: [],
      authorizationRequired: false,
    },
    taskInput: { sql: OFFSET_SQL },
    guardObservations: [
      { predicateId: "bounded-supported-sql", phase: "runtime", result: true },
      { predicateId: "source-and-dependency-match", phase: "runtime", result: true },
    ],
    services: createCanaryServices(),
  });
  return outcome.outcome === "fast_path" ? "fast_path" : "slow_path";
}

/** 构造合法 practice 事件并真实落盘 + invalidate（evidence deletion 真实来源）。 */
async function invalidateRealEvidence(
  fixtureRoot: string,
  eventId: string,
): Promise<{ invalidatedEventIds: string[] }> {
  const practiceStore = new PracticeStore({
    rootDir: path.join(fixtureRoot, ".skill-cortex", "practice"),
    projectRoot: fixtureRoot,
  });
  const event: PracticeEvent = {
    schemaVersion: 1,
    eventId,
    occurredAt: "2026-08-14T00:00:00.000Z",
    tenantScope: "project:demo",
    provenance: "real",
    parentSkillId: "skill:aaa",
    parentSkillRevision: "rev:bbb",
    sourceHash: `sha256:${"c".repeat(64)}`,
    candidateSkillIds: [],
    selectedSkillIds: ["skill:aaa"],
    executionMode: "skill_md",
    redactedTaskFeatures: ["create docx"],
    stepSummaries: [{ stepId: "s1", actor: "agent", operationClass: "read", outcome: "ok" }],
    authorizationResults: [{ gateId: "g1", result: "approved" }],
    guardResults: [{ predicateId: "p1", phase: "precondition", result: "pass" }],
    verifierResults: [{ verifierId: "v1", result: "pass", observedEffect: "schema-ok" }],
    attribution: "verified_skill_effect",
    sensitivity: "none",
    retentionClass: "project_manual",
  };
  await practiceStore.append(event);
  return practiceStore.invalidate("project:demo", [eventId]);
}

before(() => {
  tempRoot = mkdtempSync(path.join(process.cwd(), ".tmp-lifecycle-host-e2e-"));
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Phase 5 host lifecycle E2E（真实事件源）", () => {
  it("1+5. dependency match ⇒ active 保持可执行；unrelated 不受影响", async () => {
    const store = makeProcedureStore();
    const fixtureA = makeFixture("docx-a", "Creates and reads Word docx files.", "body a");
    const fixtureB = makeFixture("pdf", "Read and merge PDF documents.", "body b");
    const hashesA = await deriveDiscoverySourceHashes(fixtureA.skills);
    const hashesB = await deriveDiscoverySourceHashes(fixtureB.skills);
    const procA = await persistActiveForSkill(store, firstSkill(hashesA).skillId, firstSkill(hashesA).sourceHash);
    const procB = await persistActiveForSkill(store, firstSkill(hashesB).skillId, firstSkill(hashesB).sourceHash);

    const result = await runHostLifecycle({
      store,
      sources: {
        installedSkillIds: await installedSkillIdsFromSkills([...fixtureA.skills, ...fixtureB.skills]),
        currentFingerprintFor: (procedure) =>
          procedure.procedureId === procA.procedureId
            ? currentFingerprintFromSourceHashes(hashesA, procedure)
            : currentFingerprintFromSourceHashes(hashesB, procedure),
        trigger: "tool",
      },
    });
    assert.ok(
      result.drift.every((o) => o.status === "unchanged"),
      "match ⇒ 全部 unchanged（drift 数组含每个 procedure 的处理结果）",
    );
    assert.deepEqual(result.missingSkills, [], "全部 skill 在完整快照");
    assert.deepEqual(result.cascade, []);
    assert.equal((await store.getProcedure(procA.procedureId))!.status, "active");
    assert.equal((await store.getProcedure(procB.procedureId))!.status, "active");
    assert.equal(await executeOutcome(procA), "fast_path", "active + match 可执行");
    assert.equal(await executeOutcome(procB), "fast_path");
  });

  it("2. source drift（真实读盘驱动）⇒ 只 suspend 受影响 procedure；unrelated 不变", async () => {
    const store = makeProcedureStore();
    const fixtureA = makeFixture("docx-a", "Creates and reads Word docx files.", "body a");
    const fixtureB = makeFixture("pdf", "Read and merge PDF documents.", "body b");
    const hashesA0 = await deriveDiscoverySourceHashes(fixtureA.skills);
    const hashesB = await deriveDiscoverySourceHashes(fixtureB.skills);
    const procA = await persistActiveForSkill(store, firstSkill(hashesA0).skillId, firstSkill(hashesA0).sourceHash);
    const procB = await persistActiveForSkill(store, firstSkill(hashesB).skillId, firstSkill(hashesB).sourceHash);

    // 真实 source drift：修改 SKILL.md 后重新摄入 ⇒ sourceHash 变化。
    writeFileSync(path.join(fixtureA.rootDir, "SKILL.md"), `---\nname: docx-a\ndescription: Creates and reads Word docx files.\n---\n\n# docx-a\n\nbody a CHANGED\n`, "utf8");
    const reloadedSkillsA = loadSkillsFromDir({ dir: fixtureA.rootDir, source: "user" }).skills;
    const hashesA1 = await deriveDiscoverySourceHashes(reloadedSkillsA);
    assert.notEqual(hashesA1.get(procA.parentSkillId), procA.dependencyFingerprint.sourceHash, "SKILL.md 变化必须改变 sourceHash");

    const result = await runHostLifecycle({
      store,
      sources: {
        installedSkillIds: new Set([...hashesA1.keys(), ...hashesB.keys()]),
        currentFingerprintFor: (procedure) =>
          procedure.procedureId === procA.procedureId
            ? currentFingerprintFromSourceHashes(hashesA1, procedure)
            : currentFingerprintFromSourceHashes(hashesB, procedure),
        trigger: "tool",
      },
    });
    const drifted = result.drift.find((o) => o.procedureId === procA.procedureId);
    assert.equal(drifted!.status, "suspended");
    assert.deepEqual(drifted!.impactedDimensions, ["source"]);
    assert.equal((await store.getProcedure(procA.procedureId))!.status, "suspended", "source drift ⇒ suspend");
    assert.equal((await store.getProcedure(procB.procedureId))!.status, "active", "unrelated 不变");
  });

  it("2b. tool / permission 相关 drift ⇒ 只 suspend 受影响（注入当次 fingerprint）", async () => {
    const store = makeProcedureStore();
    const fixtureA = makeFixture("docx-a", "Creates and reads Word docx files.", "body a");
    const fixtureB = makeFixture("pdf", "Read and merge PDF documents.", "body b");
    const hashesA = await deriveDiscoverySourceHashes(fixtureA.skills);
    const hashesB = await deriveDiscoverySourceHashes(fixtureB.skills);
    const procA = await persistActiveForSkill(store, firstSkill(hashesA).skillId, firstSkill(hashesA).sourceHash);
    const procB = await persistActiveForSkill(store, firstSkill(hashesB).skillId, firstSkill(hashesB).sourceHash);

    // tool drift：当次 fingerprint 的 toolSchemaHash 不同 ⇒ 只影响 procA。
    const result = await runHostLifecycle({
      store,
      sources: {
        installedSkillIds: new Set([...hashesA.keys(), ...hashesB.keys()]),
        currentFingerprintFor: (procedure) => {
          const base = currentFingerprintFromSourceHashes(
            procedure.procedureId === procA.procedureId ? hashesA : hashesB,
            procedure,
          )!;
          if (procedure.procedureId === procA.procedureId) {
            return { ...base, toolSchemaHash: "tool-schema-drifted" };
          }
          return base;
        },
        trigger: "tool",
      },
    });
    assert.equal(
      result.drift.find((o) => o.procedureId === procA.procedureId)!.status,
      "suspended",
      "tool drift ⇒ procA suspend",
    );
    assert.equal((await store.getProcedure(procB.procedureId))!.status, "active", "procB 不受影响");
  });

  it("3+5. uninstall / identity change ⇒ 旧 procedure suspend；仍安装的 skill 不变", async () => {
    const store = makeProcedureStore();
    const fixtureA = makeFixture("docx-a", "Creates and reads Word docx files.", "body a");
    const fixtureB = makeFixture("pdf", "Read and merge PDF documents.", "body b");
    const hashesA = await deriveDiscoverySourceHashes(fixtureA.skills);
    const hashesB = await deriveDiscoverySourceHashes(fixtureB.skills);
    const procA = await persistActiveForSkill(store, firstSkill(hashesA).skillId, firstSkill(hashesA).sourceHash);
    const procB = await persistActiveForSkill(store, firstSkill(hashesB).skillId, firstSkill(hashesB).sourceHash);

    // uninstall A：完整 installed 快照不再含 A 的 skillId。
    const result = await runHostLifecycle({
      store,
      sources: {
        installedSkillIds: new Set(hashesB.keys()),
        currentFingerprintFor: (procedure) =>
          currentFingerprintFromSourceHashes(
            procedure.procedureId === procA.procedureId ? hashesA : hashesB,
            procedure,
          ),
        trigger: "tool",
      },
    });
    const missing = result.missingSkills.find((o) => o.procedureId === procA.procedureId);
    assert.ok(missing !== undefined, "A 的旧 parent 不在快照 ⇒ 命中");
    assert.equal((await store.getProcedure(procA.procedureId))!.status, "suspended");
    // MEDIUM：identity snapshot 先于 drift 处理 ⇒ 审计原因必须是 skill identity change，
    // 不得被 drift 步落成 current_unavailable。
    const suspendedA = await store.getProcedure(procA.procedureId);
    assert.equal(suspendedA!.suspendKind, "dependency_drift");
    assert.match(suspendedA!.lifecycleReason ?? "", /skill identity change/);
    assert.ok(
      !(suspendedA!.lifecycleReason ?? "").includes("current_unavailable"),
      "原因必须是 identity 缺失而非 current_unavailable",
    );
    assert.equal((await store.getProcedure(procB.procedureId))!.status, "active", "B 仍安装 ⇒ 不变");
  });

  it("4+5. evidence deletion（真实 invalidate）⇒ 依赖者 suspend；无关不变", async () => {
    const store = makeProcedureStore();
    const fixtureA = makeFixture("docx-a", "Creates and reads Word docx files.", "body a");
    const fixtureB = makeFixture("pdf", "Read and merge PDF documents.", "body b");
    const hashesA = await deriveDiscoverySourceHashes(fixtureA.skills);
    const hashesB = await deriveDiscoverySourceHashes(fixtureB.skills);
    // A 依赖 EVIDENCE_ID；B 依赖其它 evidence（无关）。
    const procA = await persistActiveForSkill(store, firstSkill(hashesA).skillId, firstSkill(hashesA).sourceHash);
    const draftB = buildPhase3ProcedureDraft({
      parentSkillId: firstSkill(hashesB).skillId,
      parentSkillRevision: FIXTURE_SKILL_REVISION,
      skillMdHash: firstSkill(hashesB).sourceHash,
      selectedReferenceHash: REFERENCE_HASH,
      createdAt: "2026-08-14T00:00:00.000Z",
      evidenceIds: ["evt-000002"],
    });
    await store.save(draftB, { trigger: "agent" });
    const validatedB = transitionPhase3ProcedureValidation(draftB, { decision: "validated", validationReportId: VALIDATION_REPORT });
    await store.transition(draftB, validatedB, { trigger: "procedure" });
    const canaryB = transitionPhase3ProcedureCanary(validatedB, { decision: "canary", canaryReportId: CANARY_REPORT });
    await store.transition(validatedB, canaryB, { trigger: "procedure" });
    const activeB = transitionPhase3ProcedureActive(canaryB, { decision: "active", activeReportId: ACTIVE_REPORT });
    await store.transition(canaryB, activeB, { trigger: "tool" });

    // 真实 practice 事件落盘 + invalidate。
    const { invalidatedEventIds } = await invalidateRealEvidence(tempRoot, EVIDENCE_ID);
    assert.deepEqual(invalidatedEventIds, [EVIDENCE_ID], "真实删除只返回存在且被删除的 ids");

    const result = await runHostLifecycle({
      store,
      sources: {
        installedSkillIds: new Set([...hashesA.keys(), ...hashesB.keys()]),
        currentFingerprintFor: (procedure) =>
          currentFingerprintFromSourceHashes(
            procedure.procedureId === procA.procedureId ? hashesA : hashesB,
            procedure,
          ),
        invalidatedEventIds,
        trigger: "tool",
      },
    });
    assert.equal(result.cascade.length, 1, "只有依赖被删 evidence 的 A 命中");
    assert.equal(result.cascade[0]!.procedureId, procA.procedureId);
    assert.equal((await store.getProcedure(procA.procedureId))!.status, "suspended");
    assert.equal((await store.getProcedure(activeB.procedureId))!.status, "active", "无关不变");
  });

  it("6. rollback stable + deps match ⇒ 真正落盘恢复 previousStableRevision", async () => {
    const store = makeProcedureStore();
    const fixture = makeFixture("docx-a", "Creates and reads Word docx files.", "body a");
    const hashes = await deriveDiscoverySourceHashes(fixture.skills);
    const v1 = await persistActiveForSkill(store, firstSkill(hashes).skillId, firstSkill(hashes).sourceHash);

    // 构造 v2（同 procedureId 新 revision，previousStableRevision=v1）作为 current 并失效。
    // 无 revision save seam：仿 store 单测直写 current（模拟「新 revision 晋升后失效」）。
    const v2Active = buildPhase3ProcedureDraft({
      parentSkillId: v1.parentSkillId,
      parentSkillRevision: v1.parentSkillRevision,
      skillMdHash: v1.dependencyFingerprint.sourceHash,
      selectedReferenceHash: "44c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa",
      createdAt: "2026-08-14T00:00:00.000Z",
      evidenceIds: [EVIDENCE_ID],
    });
    const v2Validated = transitionPhase3ProcedureValidation(v2Active, { decision: "validated", validationReportId: VALIDATION_REPORT });
    const v2Canary = transitionPhase3ProcedureCanary(v2Validated, { decision: "canary", canaryReportId: CANARY_REPORT });
    const v2Published = transitionPhase3ProcedureActive(v2Canary, {
      decision: "active",
      activeReportId: ACTIVE_REPORT,
      previousStableRevision: v1.procedureRevision,
    });
    const v2Failed = transitionPhase3ProcedureSuspend(v2Published as Phase3InvalidatableProcedure, {
      decision: "suspended",
      reason: "dependency drift: tool",
      suspendKind: "dependency_drift",
    });
    assert.notEqual(v2Failed.procedureRevision, v1.procedureRevision, "v2 是新 revision");
    const currentDir = path.join(store.tenantDir, "current");
    const currentFile = readdirSync(currentDir).find((f) => f.endsWith(".json"))!;
    writeFileSync(path.join(currentDir, currentFile), JSON.stringify(v2Failed), "utf8");

    // current deps match（v1 绑定 hash == 当次）⇒ rollback 成功并落盘。
    const result = await rollbackToPreviousStable({
      store,
      failedProcedure: v2Failed,
      current: matchingCurrent(v1),
      trigger: "tool",
    });
    assert.equal(result.ok, true, "stable match 必须回滚成功");
    const restored = await store.getProcedure(v1.procedureId);
    assert.equal(restored!.procedureRevision, v1.procedureRevision, "真正落盘恢复 previousStableRevision");
    assert.equal(restored!.status, "active");
    assert.equal(await executeOutcome(restored!), "fast_path", "恢复后 active 可执行");
  });

  it("7. rollback stable 仍 drift ⇒ 不恢复（slow path）", async () => {
    const store = makeProcedureStore();
    const fixture = makeFixture("docx-a", "Creates and reads Word docx files.", "body a");
    const hashes0 = await deriveDiscoverySourceHashes(fixture.skills);
    const v1 = await persistActiveForSkill(store, firstSkill(hashes0).skillId, firstSkill(hashes0).sourceHash);
    // v1 被真实 source drift 失效（release[v1]=suspended-from-drift）。
    writeFileSync(path.join(fixture.rootDir, "SKILL.md"), `---\nname: docx-a\ndescription: Creates and reads Word docx files.\n---\n\n# docx-a\n\nbody a CHANGED\n`, "utf8");
    const hashes1 = await deriveDiscoverySourceHashes(loadSkillsFromDir({ dir: fixture.rootDir, source: "user" }).skills);
    await runHostLifecycle({
      store,
      sources: {
        installedSkillIds: new Set(hashes1.keys()),
        currentFingerprintFor: (procedure) => currentFingerprintFromSourceHashes(hashes1, procedure),
        trigger: "tool",
      },
    });
    assert.equal((await store.getProcedure(v1.procedureId))!.status, "suspended");

    // v2 failed（previousStableRevision=v1）；current 仍 drift（hashes1 ≠ v1 绑定）⇒ 不恢复。
    const v2Failed = transitionPhase3ProcedureSuspend(
      {
        ...v1,
        procedureRevision: "rev:" + "e".repeat(64),
        previousStableRevision: v1.procedureRevision,
      } as Phase3InvalidatableProcedure,
      { decision: "suspended", reason: "dependency drift: tool", suspendKind: "dependency_drift" },
    );
    const result = await rollbackToPreviousStable({
      store,
      failedProcedure: v2Failed,
      current: currentFingerprintFromSourceHashes(hashes1, v1)!,
      trigger: "tool",
    });
    assert.equal(result.ok, false, "stable 仍 drift 不得恢复");
    if (!result.ok) {
      assert.equal(result.reason, "requires_revalidation");
      assert.equal(result.slowPath, true);
    }
    assert.equal((await store.getProcedure(v1.procedureId))!.status, "suspended", "不被覆盖恢复");
  });

  it("8. no stable ⇒ parent Skill slow path", async () => {
    const store = makeProcedureStore();
    const fixture = makeFixture("docx-a", "Creates and reads Word docx files.", "body a");
    const hashes = await deriveDiscoverySourceHashes(fixture.skills);
    const v1 = await persistActiveForSkill(store, firstSkill(hashes).skillId, firstSkill(hashes).sourceHash);
    // 首次发布无 previousStableRevision。
    const v1Failed = transitionPhase3ProcedureSuspend(
      { ...v1 } as Phase3InvalidatableProcedure,
      { decision: "suspended", reason: "dependency drift: source", suspendKind: "dependency_drift" },
    );
    const result = await rollbackToPreviousStable({
      store,
      failedProcedure: v1Failed,
      current: matchingCurrent(v1),
      trigger: "tool",
    });
    assert.deepEqual(result, { ok: false, reason: "no_stable_version", slowPath: true });
  });

  it("9. store reload ⇒ lifecycle/rollback 状态保持", async () => {
    const store = makeProcedureStore();
    const fixtureA = makeFixture("docx-a", "Creates and reads Word docx files.", "body a");
    const fixtureB = makeFixture("pdf", "Read and merge PDF documents.", "body b");
    const hashesA0 = await deriveDiscoverySourceHashes(fixtureA.skills);
    const hashesB = await deriveDiscoverySourceHashes(fixtureB.skills);
    const procA = await persistActiveForSkill(store, firstSkill(hashesA0).skillId, firstSkill(hashesA0).sourceHash);
    const procB = await persistActiveForSkill(store, firstSkill(hashesB).skillId, firstSkill(hashesB).sourceHash);
    // 真实 source drift（A）+ uninstall（B）后收敛。
    writeFileSync(path.join(fixtureA.rootDir, "SKILL.md"), `---\nname: docx-a\ndescription: Creates and reads Word docx files.\n---\n\n# docx-a\n\nbody a CHANGED\n`, "utf8");
    const hashesA1 = await deriveDiscoverySourceHashes(loadSkillsFromDir({ dir: fixtureA.rootDir, source: "user" }).skills);
    await runHostLifecycle({
      store,
      sources: {
        installedSkillIds: new Set(hashesA1.keys()),
        currentFingerprintFor: (procedure) =>
          currentFingerprintFromSourceHashes(
            procedure.procedureId === procA.procedureId ? hashesA1 : hashesB,
            procedure,
          ),
        trigger: "tool",
      },
    });

    // reload：同一 rootDir 新实例。
    const reloaded = new ProcedureStore({
      rootDir: store.rootDir,
      projectRoot: tempRoot,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    assert.equal((await reloaded.getProcedure(procA.procedureId))!.status, "suspended", "reload 后 drift 状态保持");
    assert.equal((await reloaded.getProcedure(procB.procedureId))!.status, "suspended", "reload 后 uninstall 状态保持");
    const stable = await reloaded.getStableByRevision(procA.procedureRevision);
    assert.ok(stable !== undefined, "reload 后 release/stable lookup 保持");
    assert.equal(stable!.suspendedFrom, "active");
    const events = await reloaded.listEvents(procA.procedureId);
    assert.ok(events.some((e) => e.toStatus === "suspended"), "reload 后审计事件保持");

    // reload 后 rollback 判定仍工作（current 匹配 stable ⇒ 允许）。
    // 模拟 v2（同 procedureId 新 revision，previousStableRevision=v1）作为 current 并失效：
    // 无 revision save seam，直写 current 构造（仿 store 单测）。
    const v2Active = buildPhase3ProcedureDraft({
      parentSkillId: procA.parentSkillId,
      parentSkillRevision: procA.parentSkillRevision,
      skillMdHash: procA.dependencyFingerprint.sourceHash,
      selectedReferenceHash: "44c9fa10a3d439bedea0e11b640bd25bf30dd50f0d9006cf85baf7c3151543fa",
      createdAt: "2026-08-14T00:00:00.000Z",
      evidenceIds: [EVIDENCE_ID],
    });
    const v2Validated = transitionPhase3ProcedureValidation(v2Active, { decision: "validated", validationReportId: VALIDATION_REPORT });
    const v2Canary = transitionPhase3ProcedureCanary(v2Validated, { decision: "canary", canaryReportId: CANARY_REPORT });
    const v2Published = transitionPhase3ProcedureActive(v2Canary, {
      decision: "active",
      activeReportId: ACTIVE_REPORT,
      previousStableRevision: procA.procedureRevision,
    });
    const v2Failed = transitionPhase3ProcedureSuspend(v2Published as Phase3InvalidatableProcedure, {
      decision: "suspended",
      reason: "dependency drift: tool",
      suspendKind: "dependency_drift",
    });
    // 直写 procA 的 current 文件：先移除 procB（其状态断言已完成），保证 current 目录只剩
    // procA 一个文件（无 revision save seam，跨 revision 状态须直写构造）。
    await reloaded.remove(procB.procedureId, { trigger: "tool" });
    const currentDir = path.join(reloaded.tenantDir, "current");
    const currentFile = readdirSync(currentDir).find((f) => f.endsWith(".json"))!;
    writeFileSync(path.join(currentDir, currentFile), JSON.stringify(v2Failed), "utf8");

    const result = await rollbackToPreviousStable({
      store: reloaded,
      failedProcedure: v2Failed,
      current: matchingCurrent(procA),
      trigger: "tool",
    });
    assert.equal(result.ok, true, "reload 后 rollback 判定恢复（current match stable）");
    const restored = await reloaded.getProcedure(procA.procedureId);
    assert.equal(restored!.procedureRevision, procA.procedureRevision, "真正落盘恢复 stable revision");
    assert.equal(restored!.status, "active");
  });
});
