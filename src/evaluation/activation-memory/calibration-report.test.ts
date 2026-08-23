import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ActivationMemoryCalibrationAblationReport } from "./calibration-ablation.ts";
import { ACTIVATION_MEMORY_CALIBRATION_CONFIG_HASH } from "./calibration-config.ts";
import { FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH } from "./cases.ts";

const REPORT_PATH = "docs/reports/2026-08-20-activation-memory-calibration.json";
const REPORT_HASH = "sha256:18853ae73ed77444123e774bb0b24d42d6f64d04ad440a7f44c4858bab9342b0";

test("frozen activation-memory calibration report has intact identity and no held-out cases", async () => {
  const bytes = await readFile(REPORT_PATH);
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, REPORT_HASH);
  const report = JSON.parse(bytes.toString("utf8")) as ActivationMemoryCalibrationAblationReport;
  assert.equal(report.fixtureHash, FROZEN_ACTIVATION_MEMORY_FIXTURE_HASH);
  assert.equal(report.configHash, ACTIVATION_MEMORY_CALIBRATION_CONFIG_HASH);
  assert.equal(report.pointCount, 22);
  assert.ok(report.points.flatMap((point) => point.cases).every((item) => item.caseId.startsWith("AMC")));
  assert.equal(report.negativeControls.allPassed, true);
});

test("calibration report preserves the negative v1 result", async () => {
  const report = JSON.parse(await readFile(REPORT_PATH, "utf8")) as ActivationMemoryCalibrationAblationReport;
  const d2Exposure8 = report.points.find((point) => point.exposure === 8 && point.condition.id === "D2")!;
  assert.equal(d2Exposure8.metrics.overall.goldAvailabilityRecallAtK, 0.85);
  assert.equal(d2Exposure8.metrics.noSkill.noSkillFalsePositiveRate, 1);
  assert.equal(d2Exposure8.metrics.hardConfuser.hardConfuserFalsePositiveRate, 5 / 6);

  for (const exposure of [0, 1, 2, 4, 8]) {
    const m1 = report.points.find((point) => point.exposure === exposure && point.condition.id === "C1")!;
    const m2 = report.points.find((point) => point.exposure === exposure && point.condition.id === "C2")!;
    assert.deepEqual(m2.cases, m1.cases, `M1/M2 unexpectedly differ at exposure ${exposure}`);
  }
});
