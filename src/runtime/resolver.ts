/**
 * Phase 4 — Execution Resolver（纯函数，无副作用）。
 *
 * 输入 selectedSkill + procedure + environment，按 ADR-0008 runtime resolution 顺序
 * 输出 ExecutionDecision。确定性：相同输入 ⇒ 相同 decisionId 与结果。
 *
 * 检查顺序（冻结契约，不得重排）：
 *   a. 无选中 Skill            → abstain / no_skill_selected / fallback=abstain
 *   b. 无 procedure            → skill_md / no_procedure / load_parent_skill
 *   c. status 非 validated/canary/active → skill_md / insufficient_evidence / load_parent_skill
 *   d. 父 revision 不匹配      → skill_md / revision_mismatch / load_parent_skill
 *   e. 依赖指纹不匹配          → skill_md / dependency_mismatch / load_parent_skill
 *   f. 前置条件 fail/unknown   → skill_md / precondition_failed / load_parent_skill
 *   g. requestedEffect 越界    → skill_md / unsupported_effect / load_parent_skill
 *   h. authorizationRequired   → compiled_procedure / authorization_required（授权由外部 gate）
 *   i. 全部满足                → compiled_procedure / eligible_procedure
 *
 * 边界与推断（本模块注释，供评审）：
 * - c/g 分支的 fallbackMode 契约未显式给出，按“skill_md 慢路径回退父 Skill”语义取
 *   load_parent_skill；h 分支授权未决时回退父 Skill（授权 gate 快慢路径一致，外部拦截）。
 * - revision/dependency 不匹配时不做前置条件评估（checkedPreconditions=[]，先决条件
 *   不满足无需检查后续）；匹配后才评估 procedure 声明的前置条件（缺结果 ⇒ unknown，
 *   fail-closed ⇒ precondition_failed）。
 * - no_skill_selected 时 skillId/skillRevision 输出空串（合同字段必填、无 Skill 可绑定）。
 */
import { createHash } from "node:crypto";

import type { CompiledProcedure, DependencyFingerprint, ExecutionDecision } from "../core/contracts/index.ts";

export const ELIGIBLE_STATUSES = ["validated", "canary", "active"] as const;

export interface SelectedSkillInput {
  skillId: string;
  skillRevision: string;
}

export interface ResolverEnvironment {
  /** 当前父 Skill revision（来自已验证来源，如 load_skill details）。 */
  currentSkillRevision?: string;
  /** 当前依赖指纹（来自已验证来源；缺失视为无法证明匹配 ⇒ mismatch）。 */
  currentDependencyFingerprint?: DependencyFingerprint;
  /** 调用方已检查的前置条件结果（true=pass；false=“已确认不满足”；unknown=无法判定）。 */
  preconditions: ReadonlyArray<{ predicateId: string; result: boolean | "unknown" }>;
  /** 本次请求的 effect 集合（必须 ⊆ procedure.declaredEffects 才允许快路径）。 */
  requestedEffects: readonly string[];
  /** 外部授权 gate 是否要求本次调用先授权。 */
  authorizationRequired: boolean;
}

export interface ResolverInput {
  selectedSkill?: SelectedSkillInput;
  procedure?: CompiledProcedure;
  environment: ResolverEnvironment;
}

/** 依赖指纹匹配：procedure 绑定的每个字段，environment 必须存在且相等（缺失即 fail-closed）。 */
export function dependencyFingerprintMatches(
  required: DependencyFingerprint,
  current: DependencyFingerprint | undefined,
): boolean {
  if (current === undefined) return false;
  const fields = [
    "sourceHash",
    "toolSchemaHash",
    "permissionPolicyHash",
    "environmentClass",
    "modelId",
    "promptHash",
  ] as const;
  for (const field of fields) {
    const expected = required[field];
    if (expected === undefined) continue; // procedure 未绑定该字段 ⇒ 不构成约束
    if (current[field] !== expected) return false;
  }
  return true;
}

/** 确定性 decisionId：skillId + procedureId + mode + reason 的 SHA-256 前 32 hex。 */
export function deriveDecisionId(input: {
  skillId: string;
  procedureId?: string;
  mode: ExecutionDecision["mode"];
  reason: ExecutionDecision["reason"];
}): string {
  const payload = [input.skillId, input.procedureId ?? "", input.mode, input.reason].join("\u0000");
  return `decision:${createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32)}`;
}

/** 前置条件评估：procedure 声明的每个 predicate 从 environment 取结果；缺失 ⇒ unknown。 */
export function evaluatePreconditions(
  procedure: CompiledProcedure,
  environment: ResolverEnvironment,
): { allPassed: boolean; checked: ExecutionDecision["checkedPreconditions"] } {
  if (procedure.preconditions.length === 0) {
    return { allPassed: true, checked: [] };
  }
  const checked = procedure.preconditions.map((p) => {
    const found = environment.preconditions.find((e) => e.predicateId === p.predicateId);
    return { predicateId: p.predicateId, result: found?.result ?? ("unknown" as const) };
  });
  return { allPassed: checked.every((c) => c.result === true), checked };
}

function decision(
  input: ResolverInput,
  mode: ExecutionDecision["mode"],
  reason: ExecutionDecision["reason"],
  fallbackMode: ExecutionDecision["fallbackMode"],
  checkedPreconditions: ExecutionDecision["checkedPreconditions"],
  authorizationRequired: boolean,
  procedureId?: string,
): ExecutionDecision {
  const skillId = input.selectedSkill?.skillId ?? "";
  const skillRevision = input.selectedSkill?.skillRevision ?? "";
  return {
    decisionId: deriveDecisionId({ skillId, procedureId, mode, reason }),
    skillId,
    skillRevision,
    mode,
    ...(procedureId !== undefined ? { procedureId } : {}),
    checkedPreconditions,
    authorizationRequired,
    reason,
    fallbackMode,
  };
}

/** 主解析入口（纯函数；不改变 procedure 状态，不做授权，不启动任何执行）。 */
export function resolveExecution(input: ResolverInput): ExecutionDecision {
  const env = input.environment;

  // a. 无选中 Skill
  if (input.selectedSkill === undefined) {
    return decision(input, "abstain", "no_skill_selected", "abstain", [], false);
  }
  const procedure = input.procedure;

  // b. 无 procedure → 父 Skill 慢路径
  if (procedure === undefined) {
    return decision(input, "skill_md", "no_procedure", "load_parent_skill", [], false);
  }

  // c. procedure 状态不允许执行
  if (!(ELIGIBLE_STATUSES as readonly string[]).includes(procedure.status)) {
    return decision(
      input,
      "skill_md",
      "insufficient_evidence",
      "load_parent_skill",
      [],
      false,
      procedure.procedureId,
    );
  }

  // d. 父 Skill revision 不匹配
  if (env.currentSkillRevision !== procedure.parentSkillRevision) {
    return decision(
      input,
      "skill_md",
      "revision_mismatch",
      "load_parent_skill",
      [],
      false,
      procedure.procedureId,
    );
  }

  // e. 依赖指纹不匹配
  if (!dependencyFingerprintMatches(procedure.dependencyFingerprint, env.currentDependencyFingerprint)) {
    return decision(
      input,
      "skill_md",
      "dependency_mismatch",
      "load_parent_skill",
      [],
      false,
      procedure.procedureId,
    );
  }

  // 版本/依赖匹配后评估前置条件（f 分支）。
  const precondition = evaluatePreconditions(procedure, env);

  // f. 前置条件 fail/unknown
  if (!precondition.allPassed) {
    return decision(
      input,
      "skill_md",
      "precondition_failed",
      "load_parent_skill",
      precondition.checked,
      false,
      procedure.procedureId,
    );
  }

  // g. requestedEffect 越界（不在 procedure 允许集内）
  const unsupported = env.requestedEffects.some(
    (effect) => !procedure.declaredEffects.includes(effect),
  );
  if (unsupported) {
    return decision(
      input,
      "skill_md",
      "unsupported_effect",
      "load_parent_skill",
      precondition.checked,
      false,
      procedure.procedureId,
    );
  }

  // h. 外部授权 gate 要求先授权（真正授权由外部 gate 完成）
  if (env.authorizationRequired) {
    return decision(
      input,
      "compiled_procedure",
      "authorization_required",
      "load_parent_skill",
      precondition.checked,
      true,
      procedure.procedureId,
    );
  }

  // i. 全部满足 → 快路径
  return decision(
    input,
    "compiled_procedure",
    "eligible_procedure",
    "load_parent_skill",
    precondition.checked,
    false,
    procedure.procedureId,
  );
}
