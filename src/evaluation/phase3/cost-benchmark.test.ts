/**
 * B6 cost benchmark 离线组件单测（不触发真实 LLM）。
 *
 * 覆盖：
 * - mean/stddev 数学正确性（含 n<2 → stddev=0 的口径）；
 * - measureCompileAndValidation / measureFastPath 离线可跑、均值有限为正；
 * - assembleRealCostEvidence + validateRealCostEvidence 自洽（固定数字 round-trip）；
 * - 分母 ≤ 0 ⇒ 验证如实失败（denominator_not_positive），不得伪造 N_break-even；
 * - slowPathPrompt 冻结模板、parseSlowPathClass 解析；
 * - runCostBenchmark({ slowPath: "skip" }) 返回结构完整、evidence 验证如实反映缺慢路径。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assembleRealCostEvidence,
  deriveFallbackTiming,
  FROZEN_COST_BASIS,
  mean,
  measureCompileAndValidation,
  measureFastPath,
  parseSlowPathClass,
  runCostBenchmark,
  slowPathPrompt,
  stddev,
} from "./cost-benchmark.ts";
import { HELDOUT_CASES } from "./cases.ts";
import { validateRealCostEvidence } from "./metrics.ts";

describe("cost benchmark 统计", () => {
  it("mean / stddev 数学正确", () => {
    assert.equal(mean([2, 4, 6]), 4);
    assert.ok(Math.abs(stddev([2, 4, 6]) - 2) < 1e-9, "样本标准差 (n-1)");
    assert.equal(stddev([5]), 0, "n<2 → 0（无方差证据，不虚构）");
    assert.ok(Number.isNaN(mean([])), "空集 → NaN");
  });

  it("compile+validation 离线可跑：均值有限为正、样本数=冻结重复次数", () => {
    const timing = measureCompileAndValidation(5);
    assert.equal(timing.samples, 5);
    assert.ok(Number.isFinite(timing.meanMs) && timing.meanMs > 0, `compile mean 必须为正，实际 ${timing.meanMs}`);
    assert.ok(Number.isFinite(timing.stddevMs) && timing.stddevMs >= 0);
  });

  it("fast path 离线可跑：逐例均值有限、总体均值有限为正", () => {
    const timing = measureFastPath();
    assert.equal(timing.samples, HELDOUT_CASES.length * FROZEN_COST_BASIS.fastRounds);
    assert.ok(Number.isFinite(timing.meanMs) && timing.meanMs > 0);
    for (const case_ of HELDOUT_CASES) {
      const per = timing.perCase![case_.id]!;
      assert.ok(Number.isFinite(per.meanMs) && per.meanMs >= 0);
      assert.equal(per.samples, FROZEN_COST_BASIS.fastRounds);
    }
  });

  it("慢路径 prompt 冻结模板与输出解析", () => {
    const prompt = slowPathPrompt("SKILL_DIR", "SELECT 1;");
    assert.ok(prompt.includes("SKILL_DIR/SKILL.md"));
    assert.ok(prompt.includes("uses_offset|uses_keyset|no_pagination|abstain"));
    assert.ok(prompt.includes("SELECT 1;"));
    assert.equal(parseSlowPathClass("uses_offset\n"), "uses_offset");
    assert.equal(parseSlowPathClass("I would say abstain because..."), "abstain");
    assert.equal(parseSlowPathClass("no idea"), null);
  });
});

describe("RealCostEvidence 组装与验证", () => {
  it("固定数字 round-trip：nBreakEven 与公式自洽、验证 PASS", () => {
    const evidence = assembleRealCostEvidence(100, 10, 1, 2, 45);
    assert.equal(evidence.nBreakEven, 100 / (10 - 1 - 2));
    assert.deepEqual(validateRealCostEvidence(evidence), { ok: true });
  });

  it("分母 ≤ 0 ⇒ 验证如实失败（denominator_not_positive），不伪造 N_break-even", () => {
    const evidence = assembleRealCostEvidence(100, 5, 2, 4, 45); // 5-2-4 = -1
    const validation = validateRealCostEvidence(evidence);
    assert.equal(validation.ok, false);
    if (!validation.ok) {
      assert.ok(validation.reasons.includes("denominator_not_positive"));
    }
  });

  it("fallback 派生：仅 abstain 案例（H12–H14）计入慢路径", () => {
    const slow = {
      component: "slow_path" as const,
      meanMs: 500,
      stddevMs: 100,
      samples: 45,
      perCase: Object.fromEntries(
        HELDOUT_CASES.map((c) => [
          c.id,
          { meanMs: c.id === "H12" || c.id === "H13" || c.id === "H14" ? 900 : 400, stddevMs: 50, samples: 3 },
        ]),
      ),
    };
    const fallback = deriveFallbackTiming(slow);
    // 3/15 案例 × 900ms / 15 = 180ms
    assert.ok(Math.abs(fallback.meanMs - 180) < 1e-9);
    assert.equal(fallback.perCase!["H01"]!.meanMs, 0, "非 abstain 案例 fallback=0");
    assert.equal(fallback.perCase!["H12"]!.meanMs, 900);
  });
});

describe("runCostBenchmark（slowPath=skip，离线）", () => {
  it("返回结构完整；无慢路径时 evidence 验证如实失败（缺慢路径均值）", async () => {
    const report = await runCostBenchmark({ slowPath: "skip" });
    assert.ok(report.compileValidation.meanMs > 0);
    assert.ok(report.fastPath.meanMs > 0);
    assert.equal(report.slowPath.samples, 0);
    assert.equal(report.fallback.meanMs, 0);
    // slow=0 ⇒ 分母 = 0 - fast - 0 < 0 ⇒ 验证必须如实失败。
    assert.equal(report.evidenceValidation.ok, false);
    if (!report.evidenceValidation.ok) {
      assert.ok(report.evidenceValidation.reasons!.includes("denominator_not_positive"));
    }
    assert.ok(report.frozenBasis.inputSet.includes("HELDOUT_CASES"));
  });
});
