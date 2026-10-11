import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { replayHeldoutPagination } from "./replay.ts";

describe("phase3 held-out detector replay", () => {
  it("passes every frozen oracle and keeps abstention bounded", () => {
    const { findings, report } = replayHeldoutPagination();

    assert.equal(findings.size, 15);
    assert.equal(report.metrics.accuracy, 1);
    assert.equal(report.metrics.offsetRecall, 1);
    assert.equal(report.metrics.offsetFpr, 0);
    assert.equal(report.metrics.expectedAbstainRecall, 1);
    assert.equal(report.metrics.abstainRate, 0.2);
    assert.equal(report.metrics.unexpectedAbstainRate, 0);
    assert.equal(report.metrics.counts.passed, 15);
  });

  it("returns evidence copied from each input", () => {
    const { findings, report } = replayHeldoutPagination();

    for (const result of report.perCase) {
      assert.equal(result.outcome.pass, true, result.caseId);
      const finding = findings.get(result.caseId);
      assert.ok(finding);
      assert.equal(typeof finding.evidence.matchText, "string");
    }
  });
});
