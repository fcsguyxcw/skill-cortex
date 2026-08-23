/**
 * Phase 5 收尾 —— conditional fingerprint binding invariant validator（纯函数，project-local）。
 *
 * 数据合同 §3.2 + ADR-0011：依赖指纹的**条件化绑定**：
 * - 含 `llm_holes` 的 procedure 必须绑定相关 model 与 prompt（`modelId`/`promptHash`）；
 * - 任一 `declaredEffects` 或 `requiredPermissions` 非空 ⇒ `permissionPolicyHash` 必填，
 *   且必须是真实 policy 指纹（缺失/格式非法/已知旧占位 ⇒ fail-closed）；
 * - effectless/permissionless（两者皆空）⇒ `permissionPolicyHash` 必须显式省略；
 * - 纯确定性 artifact（无 llm hole）不因无关模型变化失效 ⇒ 不强制绑定 model/prompt
 *   （绑定了也不构成错误，字段存在即约束，diff 语义不变）。
 *
 * 目的：缺省/畸形必填绑定不得因 diff 的「字段未绑定 ⇒ 不构成约束」语义被静默忽略
 * （否则 malformed procedure 的失效会被绕过）。validator 在 diffProcedureDependencies
 * 入口调用，违反 invariant ⇒ throw 受控错误（fail-closed）。
 */
import type { CompiledProcedure } from "../../core/contracts/index.ts";
import { LEGACY_PLACEHOLDER_POLICY_HASH } from "./draft.ts";

export interface FingerprintBindingIssue {
  code: string;
  message: string;
}

export type FingerprintBindingValidation =
  | { ok: true }
  | { ok: false; issues: readonly FingerprintBindingIssue[] };

/** sha256 形状（可选 "sha256:" 前缀；规范化后带前缀）。 */
const SHA256_PATTERN = /^(?:sha256:)?([0-9a-fA-F]{64})$/u;

function normalizeSha256(value: string): string | undefined {
  const match = SHA256_PATTERN.exec(value);
  return match === null ? undefined : `sha256:${match[1]!.toLowerCase()}`;
}

/** 非空字符串（trim 后非空）。 */
function isNonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/**
 * fail-closed 指纹绑定 invariant 校验：
 * - 返回 issues 列表（不 throw）；调用方（diff 入口）发现 ok=false 时抛受控错误。
 */
export function validateFingerprintBindings(
  procedure: CompiledProcedure,
): FingerprintBindingValidation {
  const issues: FingerprintBindingIssue[] = [];
  const fp = procedure.dependencyFingerprint;
  const hasLlmHoles = procedure.llmHoles.length > 0;
  const hasDeclaredPermissions =
    procedure.declaredEffects.length > 0 || procedure.requiredPermissions.length > 0;

  // 规则 1：含 LLM hole ⇒ modelId + promptHash 必须存在且合法非空。
  if (hasLlmHoles) {
    if (!isNonEmpty(fp.modelId)) {
      issues.push({
        code: "llm_holes_require_model_id",
        message: "procedure 含 llmHoles 但 dependencyFingerprint.modelId 缺失或为空",
      });
    }
    if (!isNonEmpty(fp.promptHash)) {
      issues.push({
        code: "llm_holes_require_prompt_hash",
        message: "procedure 含 llmHoles 但 dependencyFingerprint.promptHash 缺失或为空",
      });
    }
  }

  // 规则 2/3：permissionPolicyHash 的必填/省略语义（ADR-0011）。
  if (hasDeclaredPermissions) {
    const normalized = fp.permissionPolicyHash === undefined
      ? undefined
      : normalizeSha256(fp.permissionPolicyHash);
    if (normalized === undefined) {
      issues.push({
        code: "declared_permissions_require_policy_hash",
        message: "声明了 effects/permissions 但 permissionPolicyHash 缺失或格式非法",
      });
    } else if (normalized === LEGACY_PLACEHOLDER_POLICY_HASH) {
      // ADR-0011：旧占位 `sha256:4f…` 是合法形状但非真实 policy 指纹，不得作为 binding evidence。
      issues.push({
        code: "permission_policy_hash_is_placeholder",
        message: "permissionPolicyHash 是已知旧占位符（sha256:4f…），不是真实 policy 指纹",
      });
    }
  } else if (fp.permissionPolicyHash !== undefined) {
    issues.push({
      code: "effectless_must_omit_policy_hash",
      message: "effectless/permissionless procedure 必须显式省略 permissionPolicyHash",
    });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** 入口断言：违反 invariant 时抛受控错误（fail-closed，携带 issue codes）。 */
export function assertFingerprintBindings(procedure: CompiledProcedure): void {
  const validation = validateFingerprintBindings(procedure);
  if (!validation.ok) {
    const codes = validation.issues.map((issue) => issue.code).join(",");
    throw new Error(`fingerprint_binding_invariant: ${codes}`);
  }
}
