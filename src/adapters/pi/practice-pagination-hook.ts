/**
 * B4 — pagination 证据钩子（observer evidenceHook 的实例）。
 *
 * 通用 observer（practice-observer.ts）不硬编码任何 verifier/operationClass；本文件把
 * Phase 3 pagination 检测作为可选钩子注入：
 *
 * 1. 从真实会话的用户 prompt（内存，不落盘）中确定性提取 SQL；
 * 2. 用项目独立 detector（procedures/phase3，只读、确定性、幂等）复算
 *    `detectPagination(sql)`；
 * 3. 用结构化验证（独立于 LLM 自评）：finding.class 是受控枚举、evidence.matchText 真实
 *    存在于输入 SQL（防幻觉证据）、uses_offset 时 matchText 含 OFFSET；
 * 4. 验证通过 ⇒ 注入 step `detect-offset-pagination`（outcome=ok）+ verifier
 *    `phase3-pagination-structured-finding`（result=pass），policy 据此把 attribution
 *    计算为 verified_skill_effect；验证失败 ⇒ 注入 failed step + fail verifier；
 * 5. prompt 中无 SQL（非 pagination 会话）⇒ 返回 undefined，事件保持无 verifier。
 *
 * 边界：不把 evaluation/synthetic 案例改标 real——本钩子只消费真实宿主会话中出现的
 * SQL（任务由用户/验收方提供，项目原创形态），detector 与结构化验证均为确定性复算，
 * 不是 LLM 自评，也不读取任何 oracle 标签（label 正确性不在本钩子职责内）。
 */
import { detectPagination, MAX_SQL_LENGTH } from "../../procedures/phase3/index.ts";
import type {
  AttributableSelection,
  EvidenceHook,
  HookEvidence,
  RunCollector,
} from "./practice-observer.ts";

/** 冻结的 pagination 检测步骤 operationClass（resolvePracticeEvidence 验收门）。 */
export const PAGINATION_OPERATION_CLASS = "detect-offset-pagination";
/** 冻结的结构化 finding verifierId（resolvePracticeEvidence 验收门）。 */
export const PAGINATION_VERIFIER_ID = "phase3-pagination-structured-finding";

/** 受控枚举（与 verifier.ts FINDING_CLASSES 一致；独立声明避免跨模块耦合改动）。 */
const FINDING_CLASSES = ["uses_offset", "uses_keyset", "no_pagination", "abstain"] as const;

/** 提取 prompt 中第一段 SQL（SELECT/WITH 开头至分号；有界）。无 SQL 返回 undefined。 */
const SQL_RE = /\b(?:SELECT|WITH)[\s\S]*?;/i;
export function extractSqlFromPrompt(prompt: string): string | undefined {
  if (typeof prompt !== "string") return undefined;
  const match = SQL_RE.exec(prompt);
  if (match === null) return undefined;
  const sql = match[0].trim();
  if (sql === "" || sql.length > MAX_SQL_LENGTH) return undefined;
  return sql;
}

/** 结构化验证（独立于 LLM 与 oracle 标签）：class 受控 + 证据真实存在于输入 + OFFSET 关键字。 */
export function verifyStructuredFinding(sql: string, finding: unknown): boolean {
  if (typeof finding !== "object" || finding === null) return false;
  const record = finding as { class?: unknown; evidence?: { matchText?: unknown } };
  if (typeof record.class !== "string") return false;
  if (!(FINDING_CLASSES as readonly string[]).includes(record.class)) return false;
  const matchText = record.evidence?.matchText;
  if (typeof matchText !== "string") return false; // 真实结构化 finding 必须带证据
  if (!sql.includes(matchText)) return false; // 防幻觉证据：声称命中必须真实存在于输入
  if (record.class === "uses_offset" && !/offset/i.test(matchText)) return false;
  return true;
}

/** 创建 pagination 证据钩子（B4 harness 注入到 observer 的 evidenceHook）。 */
export function createPaginationEvidenceHook(): EvidenceHook {
  return {
    async collect(
      run: RunCollector,
      _selection: AttributableSelection,
    ): Promise<HookEvidence | undefined> {
      const sql = extractSqlFromPrompt(run.prompt);
      if (sql === undefined) return undefined; // 非 pagination 会话 ⇒ 不注入
      const finding = detectPagination(sql);
      if (!verifyStructuredFinding(sql, finding)) {
        return {
          steps: [
            { actor: "procedure", operationClass: PAGINATION_OPERATION_CLASS, outcome: "failed" },
          ],
          verifierResults: [
            { verifierId: PAGINATION_VERIFIER_ID, result: "fail", observedEffect: "structured-finding-invalid" },
          ],
        };
      }
      return {
        steps: [
          { actor: "procedure", operationClass: PAGINATION_OPERATION_CLASS, outcome: "ok" },
        ],
        verifierResults: [
          { verifierId: PAGINATION_VERIFIER_ID, result: "pass", observedEffect: "structured-finding-valid" },
        ],
      };
    },
  };
}
