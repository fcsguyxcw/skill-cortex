import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACTIVATION_MEMORY_CALIBRATION_CASES,
  ACTIVATION_MEMORY_EXPERIENCE_CASES,
  ACTIVATION_MEMORY_HELDOUT_CASES,
} from "./cases.ts";
import {
  ACTIVATION_MEMORY_EXPERIMENT_CONDITIONS,
  ACTIVATION_MEMORY_EVIDENCE_CLASS_CONTRACTS,
  ACTIVATION_MEMORY_FORMATION_CONTRACT_HASH,
  ACTIVATION_MEMORY_LEARNING_CURVE_POINTS,
  ACTIVATION_MEMORY_QUERY_LEAKAGE_POLICY,
  formationArtifactContract,
  computeActivationMemoryFormationContractHash,
  measureQueryLeakage,
} from "./formation-contract.ts";

describe("activation-memory formation contract", () => {
  it("freezes six identifiable conditions and nested learning-curve points", () => {
    assert.deepEqual(ACTIVATION_MEMORY_EXPERIMENT_CONDITIONS, [
      { id: "A", retriever: "bm25", producer: "none", role: "baseline" },
      { id: "B", retriever: "bm25_qe", producer: "none", role: "baseline" },
      { id: "C1", retriever: "bm25", producer: "naive", role: "naive_control" },
      { id: "C2", retriever: "bm25", producer: "verified", role: "treatment" },
      { id: "D1", retriever: "bm25_qe", producer: "naive", role: "naive_control" },
      { id: "D2", retriever: "bm25_qe", producer: "verified", role: "treatment" },
    ]);
    assert.deepEqual(ACTIVATION_MEMORY_LEARNING_CURVE_POINTS, [0, 1, 2, 4, 8]);
    assert.equal(computeActivationMemoryFormationContractHash(), ACTIVATION_MEMORY_FORMATION_CONTRACT_HASH);
  });

  it("keeps naive and evaluation artifacts outside production persistence", () => {
    assert.equal(formationArtifactContract("none", "evaluation_fixture", "skill:x", "rev:x", []).persistenceEligibility, "none");
    assert.equal(formationArtifactContract("naive", "evaluation_fixture", "skill:x", "rev:x", ["e1"]).persistenceEligibility, "never");
    assert.equal(formationArtifactContract("naive", "formal_real_store", "skill:x", "rev:x", ["e1"]).persistenceEligibility, "never");
    assert.equal(formationArtifactContract("verified", "evaluation_fixture", "skill:x", "rev:x", ["e1"]).persistenceEligibility, "never");
    assert.equal(formationArtifactContract("verified", "formal_real_store", "skill:x", "rev:x", ["e1"]).persistenceEligibility, "production_gate_required");
  });

  it("separates verified, boundary, near-miss, external, and unverified evidence", () => {
    assert.deepEqual(ACTIVATION_MEMORY_EVIDENCE_CLASS_CONTRACTS, [
      { evidenceClass: "verified_positive", formationDisposition: "positive_cue", requiresIndependentVerifier: true },
      { evidenceClass: "near_miss", formationDisposition: "soft_negative_cue", requiresIndependentVerifier: false },
      { evidenceClass: "boundary", formationDisposition: "proposal_only", requiresIndependentVerifier: true },
      { evidenceClass: "external_failure", formationDisposition: "ignore", requiresIndependentVerifier: false },
      { evidenceClass: "unverified_success", formationDisposition: "reject", requiresIndependentVerifier: true },
    ]);
  });

  it("detects exact and high-containment leakage without returning raw text", () => {
    const report = measureQueryLeakage(
      [{ id: "experience-1", text: "Generate an API migration guide" }],
      [
        { id: "heldout-exact", text: "generate an api migration guide!" },
        { id: "heldout-contained", text: "API migration guide" },
      ],
    );
    assert.equal(report.passed, false);
    assert.equal(report.violations.length, 2);
    assert.ok(report.violations[0]!.reasons.includes("exact_normalized_match"));
    assert.ok(report.violations[1]!.reasons.includes("evaluation_containment_above_threshold"));
    assert.equal(JSON.stringify(report).includes("Generate an API"), false);
  });

  it("does not flag a benign shared topic token", () => {
    const report = measureQueryLeakage(
      [{ id: "experience", text: "Audit the payment webhook for replay attacks" }],
      [{ id: "evaluation", text: "Explain what a webhook is" }],
    );
    assert.equal(report.passed, true);
    assert.equal(report.violations.length, 0);
  });

  it("passes the pre-run query-level leakage audit for calibration and held-out", () => {
    const references = ACTIVATION_MEMORY_EXPERIENCE_CASES.map((item) => ({ id: item.id, text: item.query }));
    const evaluationCases = [...ACTIVATION_MEMORY_CALIBRATION_CASES, ...ACTIVATION_MEMORY_HELDOUT_CASES]
      .map((item) => ({ id: item.id, text: item.query }));
    const report = measureQueryLeakage(references, evaluationCases);
    assert.equal(report.passed, true, JSON.stringify(report.violations));
    assert.equal(report.referenceCount, 64);
    assert.equal(report.evaluationCount, 48);
    assert.equal(report.comparedPairCount, 3_072);
    assert.equal(ACTIVATION_MEMORY_QUERY_LEAKAGE_POLICY.maxJaccard, 0.5);
    assert.equal(ACTIVATION_MEMORY_QUERY_LEAKAGE_POLICY.maxEvaluationContainment, 0.8);
  });
});
