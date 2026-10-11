/**
 * Phase 6 第一批 —— Activation cue induction 测试（纯函数，project-local）。
 *
 * 覆盖：
 * - verified 事件 ⇒ learnedAliases（作者 alias/name 去重，不覆盖作者原文）+ positiveExamples
 *   （每事件一条，features=当次脱敏特征，evidenceIds 可追溯）；
 * - near-miss（候选未选中）/ boundary failure（条件不满足）⇒ nearMissExamples（只降权，不硬过滤）；
 * - external failure（permission_denied/tool_failure）不产 cue（数据合同 §4.4）；
 * - evaluation/synthetic 事件 fail-closed；父绑定失配 fail-closed；
 * - environmentCues 从 environmentFingerprint 派生，缺失省略；
 * - 脱敏：profile 不落原始用户文本/敏感 marker；受控字符规范化；
 * - 确定性可回放；author vs learned 分栏（SkillRecord 作者字段不动）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ActivationProfile,
  LearningEvidenceAssessment,
  PracticeEvent,
  SkillRecord,
} from "../core/contracts/index.ts";
import { validatePracticeEvent } from "../practice/policy/index.ts";
import { induceActivationProfile } from "./index.ts";

const SKILL_ID = "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2";
const SKILL_REV = "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec";
const SOURCE_HASH = "sha256:8e5a86aa92990a706512a6454e3a6a6345a950b454e75a11d048210d0a2ca830";
const OTHER_SKILL_ID = "skill:" + "f".repeat(64);

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

function makeEvent(id: string, overrides: Partial<PracticeEvent> = {}): PracticeEvent {
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
    redactedTaskFeatures: ["prompt-hash:abc123", "candidate-count:3", "selected-count:1"],
    stepSummaries: [
      { stepId: "s1", actor: "tool", operationClass: "tool:load_skill", outcome: "ok" },
      { stepId: "s2", actor: "procedure", operationClass: "detect-offset-pagination", outcome: "ok" },
    ],
    authorizationResults: [],
    guardResults: [{ predicateId: "g1", phase: "runtime", result: "pass" }],
    verifierResults: [
      { verifierId: "phase3-pagination-structured-finding", result: "pass" },
    ],
    attribution: "verified_skill_effect",
    sensitivity: "none",
    retentionClass: "project_manual",
    ...overrides,
  };
}

function verifiedEvent(id: string, overrides: Partial<PracticeEvent> = {}): PracticeEvent {
  return makeEvent(id, { attribution: "verified_skill_effect", selectedSkillIds: [SKILL_ID], ...overrides });
}

/** 强候选但未选中（near-miss）。 */
function nearMissEvent(id: string, overrides: Partial<PracticeEvent> = {}): PracticeEvent {
  return makeEvent(id, {
    attribution: "unknown",
    selectedSkillIds: [OTHER_SKILL_ID],
    ...overrides,
  });
}

function assessmentFor(event: PracticeEvent): LearningEvidenceAssessment {
  const selected = event.selectedSkillIds.includes(event.parentSkillId);
  const boundary = new Set(["precondition_mismatch", "runtime_guard_failure", "postcondition_failure"])
    .has(event.failureClass ?? "");
  const external = new Set([
    "tool_failure",
    "environment_drift",
    "permission_denied",
    "user_interruption",
    "procedure_error",
  ]).has(event.failureClass ?? "");
  return {
    schemaVersion: 1,
    assessmentId: `assessment:${event.eventId}`,
    eventId: event.eventId,
    tenantScope: event.tenantScope,
    parentSkillId: event.parentSkillId,
    parentSkillRevision: event.parentSkillRevision,
    sourceHash: event.sourceHash,
    taskOutcome: boundary || external ? "verified_failure" : "verified_success",
    skillContribution: selected && !boundary && !external ? "verified" : "disproved",
    evidenceKind: !selected ? "near_miss" : boundary ? "boundary" : external ? "external_failure" : "positive",
    verifier: { kind: "independent_verifier", result: "pass" },
    assessedAt: "2026-08-23T00:01:00.000Z",
  };
}

function assessmentsFor(events: readonly PracticeEvent[]): LearningEvidenceAssessment[] {
  return events.map(assessmentFor);
}

describe("Activation cue induction：verified 事件", () => {
  it("verified 事件 ⇒ draft profile：父绑定 + positiveExamples 每事件一条（features 受控、evidenceIds 可追溯）", () => {
    const events = [
      verifiedEvent("obs-1", { redactedTaskFeatures: ["prompt-hash:aaa", "candidate-count:3", "selected-count:1", "pagination-check"] }),
      verifiedEvent("obs-2", { redactedTaskFeatures: ["prompt-hash:bbb", "candidate-count:5", "selected-count:1", "pagination-check"] }),
    ];
    for (const event of events) {
      assert.equal(validatePracticeEvent(event).ok, true, `${event.eventId} 必须通过 policy`);
    }
    const result = induceActivationProfile({ events, assessments: assessmentsFor(events), parentSkill: parentSkill() });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const profile = result.profile;
    assert.equal(profile.status, "draft");
    assert.equal(profile.parentSkillId, SKILL_ID);
    assert.equal(profile.parentSkillRevision, SKILL_REV);
    assert.match(profile.profileId, /^profile:[0-9a-f]{24}$/);
    // positiveExamples：每 verified 事件一条。
    assert.equal(profile.positiveExamples.length, 2);
    for (const example of profile.positiveExamples) {
      assert.match(example.cueId, /^cue:[0-9a-f]{24}$/);
      assert.equal(example.evidenceIds.length, 2);
      assert.ok(example.features.length > 0);
      assert.ok(example.features.every((f) => f.startsWith("prompt-hash:") || f.startsWith("candidate-count:") || f.startsWith("selected-count:") || f === "pagination-check"));
    }
    // learnedAliases：从受控特征提取 "pagination-check"（排除派生特征与作者原文）。
    assert.deepEqual(
      profile.learnedAliases.map((alias) => alias.text),
      ["pagination-check"],
    );
    assert.deepEqual(
      profile.learnedAliases[0]!.evidenceIds,
      ["assessment:obs-1", "assessment:obs-2", "obs-1", "obs-2"],
      "同文本跨事件聚合 observation 与独立评估证据",
    );
    // 时间戳确定性。
    assert.equal(profile.createdAt, "2026-08-15T00:00:00.000Z");
    assert.equal(profile.updatedAt, profile.createdAt);
  });

  it("author vs learned 分栏：learned alias 与作者 name/declaredAliases 去重（大小写不敏感），不覆盖作者原文", () => {
    const events = [
      verifiedEvent("obs-3", {
        redactedTaskFeatures: ["prompt-hash:ccc", "pagination-check", "POSTGRES-BEST-PRACTICES", "supabase-pg"],
      }),
    ];
    const result = induceActivationProfile({ events, assessments: assessmentsFor(events), parentSkill: parentSkill() });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const profile = result.profile;
    // "POSTGRES-BEST-PRACTICES"（= 作者 name 大写）与 "supabase-pg"（作者 alias）必须被排除。
    assert.deepEqual(
      profile.learnedAliases.map((alias) => alias.text),
      ["pagination-check"],
    );
    // 作者字段不动：SkillRecord 仍为作者声明值。
    assert.equal(parentSkill().name, "supabase-postgres-best-practices");
    assert.deepEqual(parentSkill().declaredAliases, ["postgres-best-practices", "supabase-pg"]);
  });

  it("脱敏：只落受控特征，不落原始用户长文本（policy 已拒完整句段/非法字符）", () => {
    const events = [
      verifiedEvent("obs-4", {
        redactedTaskFeatures: ["prompt-hash:ddd", "分页检测:offset"],
      }),
    ];
    const result = induceActivationProfile({ events, assessments: assessmentsFor(events), parentSkill: parentSkill() });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.profile);
    // 受控特征（中文+冒号）作为 alias 落盘；非受控字符（如 ! ; 换行）不得出现。
    assert.ok(serialized.includes("分页检测:offset"), "受控特征落盘为 alias");
    assert.ok(!/[!;\n\r]/.test(serialized), "非法/分隔字符不得落盘");
    // 不落原始完整用户文本：事件里不含长句，profile 也不得含未经批准的原文。
    assert.ok(!serialized.includes("帮我写"), "不得含未经批准的原始用户文本");
  });
});

describe("Activation cue induction：near-miss / boundary", () => {
  it("强候选未选中 ⇒ nearMissExamples（只作降权证据，features 受控、可追溯）", () => {
    const events = [
      verifiedEvent("obs-5"),
      nearMissEvent("obs-6", { redactedTaskFeatures: ["prompt-hash:eee", "candidate-count:2", "selected-count:0"] }),
    ];
    const result = induceActivationProfile({ events, assessments: assessmentsFor(events), parentSkill: parentSkill() });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const profile = result.profile;
    assert.equal(profile.nearMissExamples.length, 1);
    assert.equal(profile.nearMissExamples[0]!.evidenceIds[0], "obs-6");
    assert.deepEqual(profile.nearMissExamples[0]!.features, ["prompt-hash:eee", "candidate-count:2", "selected-count:0"]);
    assert.equal(result.summary.nearMissCount, 1);
  });

  it("boundary failure（条件不满足，选中但失败）⇒ near-miss 证据；external failure 不产 cue", () => {
    const boundary = makeEvent("obs-7", {
      attribution: "mixed",
      failureClass: "precondition_mismatch",
      verifierResults: [{ verifierId: "v1", result: "fail" }],
    });
    const external = makeEvent("obs-8", {
      attribution: "mixed",
      failureClass: "permission_denied", // external：不能归因给 Skill
      verifierResults: [{ verifierId: "v1", result: "fail" }],
    });
    const events = [boundary, external];
    const result = induceActivationProfile({ events, assessments: assessmentsFor(events), parentSkill: parentSkill() });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // 无 verified ⇒ 只有 near-miss 也可生成 profile（降权证据）。
    assert.equal(result.summary.nearMissCount, 1, "boundary 事件计入 near-miss");
    assert.equal(result.summary.ignoredCount, 1, "external failure 跳过不产 cue");
    assert.equal(result.profile.nearMissExamples.length, 1);
    assert.equal(result.profile.nearMissExamples[0]!.evidenceIds[0], "obs-7");
    assert.ok(
      !result.profile.nearMissExamples.some((n) => n.evidenceIds.includes("obs-8")),
      "external failure 不得成为 cue",
    );
  });

  it("non-boundary 失败类别（tool_failure）不产 near-miss cue", () => {
    const events = [
      makeEvent("obs-9", {
        attribution: "mixed",
        failureClass: "tool_failure",
        verifierResults: [{ verifierId: "v1", result: "fail" }],
      }),
    ];
    const result = induceActivationProfile({ events, assessments: assessmentsFor(events), parentSkill: parentSkill() });
    assert.equal(result.ok, false, "无 verified 且无 near-miss ⇒ no_eligible_events");
    if (!result.ok) assert.equal(result.reason, "no_eligible_events");
  });
});

describe("Activation cue induction：environmentCues 与 fail-closed", () => {
  it("environmentFingerprint 存在 ⇒ valueClass 派生；缺失 ⇒ 省略不伪造", () => {
    const events = [
      verifiedEvent("obs-10", { environmentFingerprint: "os:win32 runtime:node24" }),
      verifiedEvent("obs-11", { environmentFingerprint: "os:win32 runtime:node24" }),
      verifiedEvent("obs-12"), // 无 fingerprint
    ];
    const result = induceActivationProfile({ events, assessments: assessmentsFor(events), parentSkill: parentSkill() });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.profile.environmentCues.length, 1, "同 fingerprint 聚合为一条 cue");
    assert.equal(result.profile.environmentCues[0]!.key, "environment");
    assert.equal(result.profile.environmentCues[0]!.valueClass, "os:win32 runtime:node24");
    assert.deepEqual(
      result.profile.environmentCues[0]!.evidenceIds,
      ["assessment:obs-10", "assessment:obs-11", "obs-10", "obs-11"],
    );
  });

  it("evaluation/synthetic 事件禁止混入 ⇒ fail practice_event_not_real", () => {
    const events = [
      verifiedEvent("obs-13"),
      { ...verifiedEvent("eval-1"), provenance: "evaluation" as const },
    ];
    const result = induceActivationProfile({ events, assessments: assessmentsFor(events), parentSkill: parentSkill() });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "practice_event_not_real");
  });

  it("父绑定失配（不同 parentSkillRevision/skillId）⇒ fail parent_binding_mismatch", () => {
    const events = [
      verifiedEvent("obs-14"),
      { ...verifiedEvent("obs-15"), parentSkillId: OTHER_SKILL_ID },
    ];
    const result = induceActivationProfile({ events, assessments: assessmentsFor(events), parentSkill: parentSkill() });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "parent_binding_mismatch");
  });

  it("policy 非法事件 ⇒ fail practice_event_policy_invalid", () => {
    const events = [
      { ...verifiedEvent("obs-16"), redactedTaskFeatures: ["contains absolute path C:\\Users\\x"] as string[] },
    ];
    // 该事件本身 policy 非法（绝对路径特征）。
    assert.equal(validatePracticeEvent(events[0]!).ok, false);
    const result = induceActivationProfile({ events, assessments: assessmentsFor(events), parentSkill: parentSkill() });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "practice_event_policy_invalid");
  });

  it("确定性：同输入两次运行深度相等（可回放）", () => {
    const events = [
      verifiedEvent("obs-17", { redactedTaskFeatures: ["prompt-hash:fff", "pagination-check"] }),
      nearMissEvent("obs-18"),
      makeEvent("obs-19", { attribution: "mixed", failureClass: "environment_drift", verifierResults: [{ verifierId: "v1", result: "fail" }] }),
    ];
    const assessments = assessmentsFor(events);
    const first = induceActivationProfile({ events, assessments, parentSkill: parentSkill() });
    const second = induceActivationProfile({ events: [...events].reverse(), assessments: [...assessments].reverse(), parentSkill: parentSkill() });
    assert.equal(first.ok, true);
    assert.ok(second.ok);
    assert.deepEqual(second, first, "输入顺序不影响输出");
  });
});
