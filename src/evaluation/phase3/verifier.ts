/**
 * Phase 3 独立 deterministic verifier（阈值文档 §5 合同）。
 *
 * 纯函数 `verify(case, finding)`：不读取 procedure 内部、不调用 LLM、不导入候选 detector
 * （src/procedures/phase3/ 由其他 Agent 实现，本模块不引用）。输出二值 pass/fail 与稳定
 * 失败类别，作为 ADR-0008 硬门 2/6 的独立判定基准（oracle = 冻结 case.expected）。
 */

import type { PaginationCase, PaginationClass } from "./cases.ts";

/** finding 的受控形状：class 必填；evidence.matchText 为 unknown（verify 运行时强制 string，缺/非字符串 ⇒ fail）。 */
export interface Finding {
  class?: unknown;
  evidence?: { matchText?: unknown };
}

export const FINDING_CLASSES: readonly PaginationClass[] = [
  "uses_offset",
  "uses_keyset",
  "no_pagination",
  "abstain",
];

export type VerifyCode =
  | "ok"
  | "malformed_finding"
  | "label_mismatch"
  | "evidence_not_in_input"
  | "evidence_keyword_mismatch";

export interface VerifyResult {
  pass: boolean;
  code: VerifyCode;
}

/** 验证 finding.class 是否为受控枚举值（不属合同步骤 1，作结构性兜底）。 */
export function isFindingClass(value: unknown): value is PaginationClass {
  return (
    typeof value === "string" && (FINDING_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * 二值判定（阈值文档 §5）：
 * 1. finding 非对象或缺失/非法 class → fail(malformed_finding)；
 * 2. class 与 case.expected 精确匹配（含 expected=abstain 且输出 abstain 的正确 abstain）
 *    → 走证据校验(3) 后 pass；
 * 3. 证据校验（强制）：finding.evidence 必须存在且 matchText 为 string，否则 fail(malformed_finding)；
 *    - 非空 case.sql 的 matchText 不得为空；case.sql 必须包含 matchText，否则 fail；
 *    - 对 uses_offset，matchText 必须含 "OFFSET"（大小写不敏感），否则 fail(evidence_keyword_mismatch)；
 * 4. 其余（含 expected≠abstain 但输出 abstain 的 unexpected abstain）→ fail(label_mismatch)。
 * 无第三态：abstain 要么正确（pass）要么 unexpected（fail），全 abstain 无法逃过 accuracy。
 */
export function verify(case_: PaginationCase, finding: unknown): VerifyResult {
  if (typeof finding !== "object" || finding === null || !("class" in finding)) {
    return { pass: false, code: "malformed_finding" };
  }
  const cls = (finding as Finding).class;
  if (!isFindingClass(cls)) {
    return { pass: false, code: "malformed_finding" };
  }

  if (cls !== case_.expected) {
    // 含“期望非 abstain 但输出 abstain”的 unexpected abstain
    return { pass: false, code: "label_mismatch" };
  }

  const evidenceCheck = checkEvidence(case_, finding as Finding);
  if (evidenceCheck !== "ok") {
    return { pass: false, code: evidenceCheck };
  }
  return { pass: true, code: "ok" };
}

/** 结构不变量：procedure 声称命中的文本必须真实存在于输入，防“幻觉证据”。 */
function checkEvidence(case_: PaginationCase, finding: Finding): VerifyCode | "ok" {
  const matchText = finding.evidence?.matchText;
  if (typeof matchText !== "string") {
    return "malformed_finding"; // 缺 evidence 对象或 matchText 非字符串 → fail（不扩展枚举）
  }
  // 空输入的 abstain 可如实返回空证据；非空输入不得用空串绕过 evidence 约束。
  if (case_.sql.length > 0 && matchText.length === 0) {
    return "malformed_finding";
  }
  if (!case_.sql.includes(matchText)) {
    return "evidence_not_in_input";
  }
  if (case_.expected === "uses_offset" && !/offset/i.test(matchText)) {
    return "evidence_keyword_mismatch";
  }
  return "ok";
}
