import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runSmoke, TOP_K } from "./smoke.ts";

describe("phase1 discovery smoke", () => {
  it("satisfies functional gates and emits a report", () => {
    const report = runSmoke();

    // Structural invariant: no router LLM, bounded candidate injection.
    assert.equal(report.routerLlmCalls, 0);
    assert.ok(report.maxRetrievedCount <= TOP_K);
    assert.ok(report.maxRetrievedCount <= report.catalogSize);

    // Functional gates over the hand-labelled smoke cases.
    assert.equal(report.noSkillAccuracy, 1, "no-skill cases must return empty");
    assert.equal(report.recallAtK, 1, "all gold skills must rank in top-K");
    assert.equal(report.setRecall, 1, "full set recall over top-K");

    // Report is a smoke signal, not a statistical claim.
    console.log(
      "\n[phase1-smoke-report]\n" + JSON.stringify(report, null, 2) + "\n",
    );
  });
});
