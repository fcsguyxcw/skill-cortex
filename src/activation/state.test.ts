/**
 * Phase 6 第三批 —— ActivationProfile 状态机测试（纯函数，仿 Phase 5 范式）。
 *
 * 合法边（数据合同 §6.1）：
 *   draft|active|suspended → shadow；shadow → active；draft|shadow|active → suspended；
 *   active|suspended → retired（终态）。
 * 非法边（其余全部 fail-closed）：draft→active（跳 shadow）、shadow→retired、
 *   suspended→active（直接复活）、retired→*（复活）、shadow→shadow 等。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActivationProfile } from "../core/contracts/index.ts";
import {
  transitionProfileToActive,
  transitionProfileToRetired,
  transitionProfileToShadow,
  transitionProfileToSuspended,
} from "./index.ts";

const SKILL_ID = "skill:670b8f65dca2ceda3de0d70e92ccd8b5cb832e7c4fd2e5d845b58b19e230cbe2";
const SKILL_REV = "rev:ce271d3393e3f1ee836ab48419f33e4337098ecf809e936b969a8ea8af2a8dec";
const SHADOW_REPORT = "shadow:phase6-shadow-replay-001";
const PROMOTION_REPORT = "promotion:phase6-gate-p6-001";
const REASON = "overlay degraded on held-out";

type Status = ActivationProfile["status"];

function profileOf(status: Status, overrides: Partial<ActivationProfile> = {}): ActivationProfile {
  return {
    schemaVersion: 1,
    profileId: "profile:test123",
    parentSkillId: SKILL_ID,
    parentSkillRevision: SKILL_REV,
    status,
    learnedAliases: [{ cueId: "cue:a1", text: "offset-check", evidenceIds: ["obs-1"] }],
    positiveExamples: [{ cueId: "cue:p1", features: ["offset-page-query"], evidenceIds: ["obs-1"] }],
    nearMissExamples: [{ cueId: "cue:n1", features: ["cursor-query"], evidenceIds: ["obs-2"] }],
    environmentCues: [{ key: "environment", valueClass: "os:win32", evidenceIds: ["obs-1"] }],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

function instanceOf(status: Status): ActivationProfile {
  return profileOf(status);
}

/** 按目标状态 dispatch（非法 from 会被对应 transition 拒绝）。 */
function dispatch(from: Status, to: Status, instance: ActivationProfile): ActivationProfile {
  switch (to) {
    case "shadow":
      return transitionProfileToShadow(instance as never, {
        decision: "shadow",
        shadowReportId: SHADOW_REPORT,
      });
    case "active":
      return transitionProfileToActive(instance as never, {
        decision: "active",
        promotionReportId: PROMOTION_REPORT,
      });
    case "suspended":
      return transitionProfileToSuspended(instance as never, {
        decision: "suspended",
        reason: REASON,
      });
    case "retired":
      return transitionProfileToRetired(instance as never, {
        decision: "retired",
        reason: REASON,
      });
    default:
      throw new Error(`no transition dispatch for ${to}`);
  }
}

const STATUSES: readonly Status[] = ["draft", "shadow", "active", "suspended", "retired"];

/** 合法边（8 条）；其余 25 条非法。 */
const LEGAL_EDGES = new Set<string>([
  "draft->shadow",
  "active->shadow",
  "suspended->shadow",
  "shadow->active",
  "draft->suspended",
  "shadow->suspended",
  "active->suspended",
  "active->retired",
  "suspended->retired",
]);

describe("ActivationProfile 状态机：合法转换", () => {
  it("完整生命周期链：draft→shadow→active→suspended→retired", () => {
    const chain = [
      dispatch("draft", "shadow", instanceOf("draft")),
      dispatch("shadow", "active", instanceOf("shadow")),
      dispatch("active", "suspended", instanceOf("active")),
      dispatch("suspended", "retired", instanceOf("suspended")),
    ];
    assert.deepEqual(
      chain.map((p) => p.status),
      ["shadow", "active", "suspended", "retired"],
    );
    // 不可变：输入实例不变。
    const draft = instanceOf("draft");
    const shadowed = dispatch("draft", "shadow", draft);
    assert.equal(draft.status, "draft");
    assert.equal(shadowed.status, "shadow");
  });

  it("重新验证后可回 shadow：active|suspended → shadow（合同 §6.1）", () => {
    for (const from of ["active", "suspended"] as const) {
      const result = dispatch(from, "shadow", instanceOf(from));
      assert.equal(result.status, "shadow", `${from}→shadow 合法`);
    }
  });

  it("transition 不可变：cue 数据与父绑定原样保留", () => {
    const draft = instanceOf("draft");
    const shadow = dispatch("draft", "shadow", draft);
    assert.deepEqual(shadow.learnedAliases, draft.learnedAliases);
    assert.deepEqual(shadow.positiveExamples, draft.positiveExamples);
    assert.deepEqual(shadow.nearMissExamples, draft.nearMissExamples);
    assert.deepEqual(shadow.environmentCues, draft.environmentCues);
    assert.equal(shadow.parentSkillId, SKILL_ID);
    assert.equal(shadow.parentSkillRevision, SKILL_REV);
  });
});

describe("ActivationProfile 状态机：非法转换矩阵", () => {
  it("每条非法边 throw，每条合法边成功", () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const edge = `${from}->${to}`;
        if (LEGAL_EDGES.has(edge)) {
          const result = dispatch(from, to, instanceOf(from));
          assert.equal(result.status, to, `${edge} 必须成功`);
        } else {
          assert.throws(
            () => dispatch(from, to, instanceOf(from)),
            /.*/,
            `${edge} 必须被拒绝（fail-closed）`,
          );
        }
      }
    }
  });

  it("关键非法边显式核验（消息可读）", () => {
    // draft 直接 active（跳 shadow）。
    assert.throws(
      () =>
        transitionProfileToActive(instanceOf("draft") as never, {
          decision: "active",
          promotionReportId: PROMOTION_REPORT,
        }),
      /active_transition_requires_shadow_profile/,
    );
    // shadow 直接 retired。
    assert.throws(
      () =>
        transitionProfileToRetired(instanceOf("shadow") as never, {
          decision: "retired",
          reason: REASON,
        }),
      /retire_transition_requires_active_or_suspended_profile/,
    );
    // suspended 直接 active（复活）。
    assert.throws(
      () =>
        transitionProfileToActive(instanceOf("suspended") as never, {
          decision: "active",
          promotionReportId: PROMOTION_REPORT,
        }),
      /active_transition_requires_shadow_profile/,
    );
    // retired 复活：任何出口都拒绝。
    assert.throws(
      () =>
        transitionProfileToShadow(instanceOf("retired") as never, {
          decision: "shadow",
          shadowReportId: SHADOW_REPORT,
        }),
      /shadow_transition_requires_draft_active_or_suspended_profile/,
    );
    assert.throws(
      () =>
        transitionProfileToSuspended(instanceOf("retired") as never, {
          decision: "suspended",
          reason: REASON,
        }),
      /suspend_transition_requires_non_terminal_profile/,
    );
  });
});

describe("ActivationProfile 状态机：decision/报告/reason 校验", () => {
  it("decision 错 / 报告 ID 非法 / reason 空 ⇒ 拒绝", () => {
    const draft = instanceOf("draft");
    assert.throws(
      () => transitionProfileToShadow(draft as never, { decision: "active", shadowReportId: SHADOW_REPORT } as never),
      /shadow_transition_requires_shadow_decision/,
    );
    for (const bad of ["", "canary:phase6-001", "promotion-x"]) {
      assert.throws(
        () => transitionProfileToShadow(draft as never, { decision: "shadow", shadowReportId: bad }),
        /profile_report_id_invalid/,
        `report=${JSON.stringify(bad)} 必须拒绝`,
      );
    }
    assert.throws(
      () =>
        transitionProfileToSuspended(instanceOf("active") as never, {
          decision: "suspended",
          reason: "   ",
        }),
      /profile_lifecycle_reason_/,
    );
    assert.throws(
      () =>
        transitionProfileToRetired(instanceOf("active") as never, {
          decision: "retired",
          reason: "x".repeat(201),
        }),
      /profile_lifecycle_reason_/,
    );
  });
});
