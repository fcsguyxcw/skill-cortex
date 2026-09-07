import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { ExposureObservation, SkillRecord } from "../../core/contracts/index.ts";
import {
  ACTIVATION_MEMORY_CALIBRATION_CASES,
  ACTIVATION_MEMORY_CATALOG_HASH,
  ACTIVATION_MEMORY_HELDOUT_CASES,
} from "../activation-memory/cases.ts";
import {
  FROZEN_EXPOSURE_POLICY_CONFIG_HASH,
  computeFrozenExposurePolicyConfigHash,
  evaluationPolicyWouldInject,
  runFrozenExposureEvaluation,
} from "./frozen-policy.ts";

const snapshot = JSON.parse(readFileSync(
  "docs/evaluation/2026-08-20-selection-catalog-snapshot.json",
  "utf8",
)) as {
  catalogHash: string;
  entries: Array<Pick<SkillRecord, "skillId" | "skillRevision" | "name" | "description">>;
};
const catalog: SkillRecord[] = snapshot.entries.map((item) => ({
  ...item,
  schemaVersion: 1,
  scope: "user",
  sourceLocator: "fixture://catalog-snapshot",
  sourceHash: `sha256:${"0".repeat(64)}`,
  disableModelInvocation: false,
  declaredAliases: [],
  declaredEffects: [],
  declaredPermissions: [],
  dependencyManifest: [],
  discoveredAt: "2026-08-20T00:00:00.000Z",
}));

function observation(overrides: Partial<ExposureObservation>): ExposureObservation {
  return {
    baselineWouldInject: true,
    candidateCount: 1,
    topMatchFields: ["description"],
    exactDeclaredReference: false,
    topScore: 1,
    ...overrides,
  };
}

describe("G2 frozen Exposure policy（evaluation-only）", () => {
  it("配置 hash 冻结；策略只读取 observation，不含任务分类规则", () => {
    assert.equal(computeFrozenExposurePolicyConfigHash(), FROZEN_EXPOSURE_POLICY_CONFIG_HASH);
    assert.equal(evaluationPolicyWouldInject(observation({ exactDeclaredReference: true })), true);
    assert.equal(evaluationPolicyWouldInject(observation({ candidateCount: 5 })), true);
    assert.equal(evaluationPolicyWouldInject(observation({ topScore: 12 })), true);
    assert.equal(evaluationPolicyWouldInject(observation({ baselineWouldInject: false, topScore: 100 })), false);
    assert.equal(evaluationPolicyWouldInject(observation({ candidateCount: 4, topScore: 11.999 })), false);
  });

  it("calibration：必要候选 exposure 非劣，No-Skill FP 从 2/4 降到 1/4", () => {
    const report = runFrozenExposureEvaluation({
      catalog,
      catalogHash: snapshot.catalogHash,
      cases: ACTIVATION_MEMORY_CALIBRATION_CASES,
      partition: "calibration",
    });
    assert.equal(report.catalogHash, ACTIVATION_MEMORY_CATALOG_HASH);
    assert.equal(report.metrics.caseCount, 24);
    assert.equal(report.metrics.necessaryCandidateCaseCount, 6);
    assert.equal(report.metrics.baselineNecessaryExposureRecall, 1);
    assert.equal(report.metrics.policyNecessaryExposureRecall, 1);
    assert.equal(report.metrics.noSkillCaseCount, 4);
    assert.equal(report.metrics.baselineNoSkillExposureFalsePositiveCount, 2);
    assert.equal(report.metrics.policyNoSkillExposureFalsePositiveCount, 1);
    assert.equal(report.metrics.baselineNoSkillExposureFalsePositiveRate, 0.5);
    assert.equal(report.metrics.policyNoSkillExposureFalsePositiveRate, 0.25);
  });

  it("frozen replay：必要候选 exposure 非劣，No-Skill FP 同样从 2/4 降到 1/4", () => {
    const report = runFrozenExposureEvaluation({
      catalog,
      catalogHash: snapshot.catalogHash,
      cases: ACTIVATION_MEMORY_HELDOUT_CASES,
      partition: "heldout",
    });
    assert.equal(report.metrics.caseCount, 24);
    assert.equal(report.metrics.necessaryCandidateCaseCount, 6);
    assert.equal(report.metrics.baselineNecessaryExposureRecall, 1);
    assert.equal(report.metrics.policyNecessaryExposureRecall, 1);
    assert.equal(report.metrics.noSkillCaseCount, 4);
    assert.equal(report.metrics.baselineNoSkillExposureFalsePositiveCount, 2);
    assert.equal(report.metrics.policyNoSkillExposureFalsePositiveCount, 1);
    assert.equal(report.metrics.exactReferencePreservedCount, report.metrics.exactReferenceCaseCount);
  });

  it("catalog/config/partition drift 均 fail closed", () => {
    assert.throws(() => runFrozenExposureEvaluation({
      catalog,
      catalogHash: `sha256:${"f".repeat(64)}`,
      cases: ACTIVATION_MEMORY_CALIBRATION_CASES,
      partition: "calibration",
    }), /exposure_evaluation_catalog_hash_mismatch/);
    assert.throws(() => runFrozenExposureEvaluation({
      catalog,
      catalogHash: snapshot.catalogHash,
      cases: ACTIVATION_MEMORY_HELDOUT_CASES,
      partition: "calibration",
    }), /exposure_evaluation_partition_mismatch/);
  });
});
