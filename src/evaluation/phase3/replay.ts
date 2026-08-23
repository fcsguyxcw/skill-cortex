/**
 * Cross-module Phase 3 replay. The oracle and verifier remain independent of
 * the detector; this harness joins them only after the evaluation contract is
 * frozen.
 */
import { detectPagination, type PaginationFinding } from "../../procedures/phase3/index.ts";
import { HELDOUT_CASES } from "./cases.ts";
import { evaluate, type EvaluationReport } from "./metrics.ts";

export interface PaginationReplay {
  findings: ReadonlyMap<string, PaginationFinding>;
  report: EvaluationReport;
}

export function replayHeldoutPagination(): PaginationReplay {
  const findings = new Map(
    HELDOUT_CASES.map((case_) => [case_.id, detectPagination(case_.sql)]),
  );
  return {
    findings,
    report: evaluate(HELDOUT_CASES, findings),
  };
}
