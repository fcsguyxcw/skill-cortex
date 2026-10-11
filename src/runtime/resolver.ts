/**
 * Phase 4 — Execution Resolver（纯函数，无副作用）。
 *
 * 输入 selectedSkill + procedure + environment，按 ADR-0008/ADR-0012 runtime resolution
 * 顺序输出 ExecutionDecision。确定性：相同输入 ⇒ 相同 decisionId 与结果。
 *
 * 检查顺序（冻结契约，不得重排）：
 *   a. 无选中 Skill            → abstain / no_skill_selected / fallback=abstain
 *   b. 无 procedure            → skill_md / no_procedure / load_parent_skill
 *   c. 父 Skill 身份不匹配     → skill_md / parent_skill_mismatch / load_parent_skill
 *   d. 上下文×状态矩阵不通过   → skill_md / insufficient_evidence / load_parent_skill
 *   e. 父 revision 双重失配    → skill_md / revision_mismatch / load_parent_skill
 *   f. 依赖指纹不匹配          → skill_md / dependency_mismatch / load_parent_skill
 *   g. 前置条件 fail/unknown   → skill_md / precondition_failed / load_parent_skill
 *   h. effects 集合不精确相等  → skill_md / unsupported_effect / load_parent_skill
 *   i. authorizationRequired   → compiled_procedure / authorization_required（授权由外部 gate）
 *   j. 全部满足                → compiled_procedure / eligible_procedure
 *
 * 语义与边界（ADR-0012 / leader 冻结决策）：
 * - executionContext：ResolverEnvironment.executionContext 为 unknown 类型；缺失/非法运行期
 *   值规范化为 "unknown"（绝不伪造为 shadow_replay/canary/active）；unknown ⇒ 任何状态都不
 *   eligible ⇒ fail closed（D1：沿用 insufficient_evidence）。
 * - 上下文×状态矩阵：shadow_replay ∈ {validated,canary,active}；canary ∈ {canary}；
 *   active ∈ {active}（ADR-0012 §2）。
 * - c 分支先于 d/e：身份不一致时无需比较状态与版本（ADR-0012 §3）。
 * - e 分支双重 fail-closed（D2）：selectedSkill.skillRevision（快照）与 env.currentSkillRevision
 *   （验证来源）任一 ≠ procedure.parentSkillRevision ⇒ revision_mismatch。
 * - f 分支含 ADR-0011 fail-closed：procedure 声明了 effects/permissions 但 fingerprint
 *   省略 permissionPolicyHash ⇒ dependency_mismatch；effectless 省略仍不构成约束。
 * - h 分支集合精确相等（D4）：requestedEffects 与 declaredEffects 按集合比较（顺序不敏感）；
 *   子集/超集/空请求对非空声明均 ⇒ unsupported_effect。
 * - decisionId 纳入规范化后的 executionContext，同输入同 ID。
 * - revision/dependency 不匹配时不评估前置条件（checkedPreconditions=[]）。
 * - no_skill_selected 时 skillId/skillRevision 输出空串（合同字段必填、无 Skill 可绑定）；
 *   executionContext 仍如实输出（合法三态或 unknown，不伪造）。
 */
import { createHash } from "node:crypto";

import type {
  CompiledProcedure,
  DecisionExecutionContext,
  DependencyFingerprint,
  ExecutionDecision,
} from "../core/contracts/index.ts";

export interface SelectedSkillInput {
  skillId: string;
  skillRevision: string;
}

export interface ResolverEnvironment {
  /** 当前父 Skill revision（来自已验证来源，如 load_skill details）。 */
  currentSkillRevision?: string;
  /** 当前依赖指纹（来自已验证来源；缺失视为无法证明匹配 ⇒ mismatch）。 */
  currentDependencyFingerprint?: DependencyFingerprint;
  /**
   * 释放门控上下文（ADR-0012 §1）。类型 unknown 以容纳缺失/非法运行期值；
   * 经 normalizeExecutionContext 规范化为 "unknown" 并 fail closed，绝不伪造合法三态。
   */
  executionContext?: unknown;
  /** 调用方已检查的前置条件结果（true=pass；false=“已确认不满足”；unknown=无法判定）。 */
  preconditions: ReadonlyArray<{ predicateId: string; result: boolean | "unknown" }>;
  /** 本次请求的 effect 集合（必须与 procedure.declaredEffects 集合精确相等才允许快路径，D4）。 */
  requestedEffects: readonly string[];
  /** 外部授权 gate 是否要求本次调用先授权。 */
  authorizationRequired: boolean;
}

export interface ResolverInput {
  selectedSkill?: SelectedSkillInput;
  procedure?: CompiledProcedure;
  environment: ResolverEnvironment;
}

/** 规范化执行上下文：合法三态保留；缺失/非法 ⇒ "unknown"（不伪造合法值，ADR-0012 §1）。 */
export function normalizeExecutionContext(value: unknown): DecisionExecutionContext {
  return value === "shadow_replay" || value === "canary" || value === "active"
    ? value
    : "unknown";
}

/** 上下文×状态矩阵（ADR-0012 §2）：unknown ⇒ 任何状态都不 eligible（fail closed）。 */
export function isStatusEligibleInContext(
  status: CompiledProcedure["status"],
  context: DecisionExecutionContext,
): boolean {
  switch (context) {
    case "shadow_replay":
      return status === "validated" || status === "canary" || status === "active";
    case "canary":
      return status === "canary";
    case "active":
      return status === "active";
    default:
      return false;
  }
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

/** 确定性 decisionId：skillId + procedureId + mode + reason + executionContext 的 SHA-256 前 32 hex。 */
export function deriveDecisionId(input: {
  skillId: string;
  procedureId?: string;
  mode: ExecutionDecision["mode"];
  reason: ExecutionDecision["reason"];
  executionContext: DecisionExecutionContext;
}): string {
  const payload = [
    input.skillId,
    input.procedureId ?? "",
    input.mode,
    input.reason,
    input.executionContext,
  ].join("\u0000");
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

/** effects 集合精确相等（D4：长度 + 成员；顺序不敏感；重复按集合处理）。 */
export function effectsSetEqual(requested: readonly string[], declared: readonly string[]): boolean {
  if (requested.length !== declared.length) return false;
  const requestedSet = new Set(requested);
  const declaredSet = new Set(declared);
  if (requestedSet.size !== declaredSet.size) return false;
  return [...requestedSet].every((effect) => declaredSet.has(effect));
}

function decision(
  input: ResolverInput,
  mode: ExecutionDecision["mode"],
  reason: ExecutionDecision["reason"],
  fallbackMode: ExecutionDecision["fallbackMode"],
  checkedPreconditions: ExecutionDecision["checkedPreconditions"],
  authorizationRequired: boolean,
  procedureId: string | undefined,
  executionContext: DecisionExecutionContext,
): ExecutionDecision {
  const skillId = input.selectedSkill?.skillId ?? "";
  const skillRevision = input.selectedSkill?.skillRevision ?? "";
  return {
    decisionId: deriveDecisionId({ skillId, procedureId, mode, reason, executionContext }),
    skillId,
    skillRevision,
    executionContext,
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
  const executionContext = normalizeExecutionContext(env.executionContext);

  // a. 无选中 Skill
  if (input.selectedSkill === undefined) {
    return decision(input, "abstain", "no_skill_selected", "abstain", [], false, undefined, executionContext);
  }
  const procedure = input.procedure;

  // b. 无 procedure → 父 Skill 慢路径
  if (procedure === undefined) {
    return decision(input, "skill_md", "no_procedure", "load_parent_skill", [], false, undefined, executionContext);
  }

  // c. 父 Skill 身份不匹配（先于状态与版本；ADR-0012 §3）
  if (input.selectedSkill.skillId !== procedure.parentSkillId) {
    return decision(
      input,
      "skill_md",
      "parent_skill_mismatch",
      "load_parent_skill",
      [],
      false,
      procedure.procedureId,
      executionContext,
    );
  }

  // d. 上下文×状态矩阵（unknown ⇒ fail closed，D1）
  if (!isStatusEligibleInContext(procedure.status, executionContext)) {
    return decision(
      input,
      "skill_md",
      "insufficient_evidence",
      "load_parent_skill",
      [],
      false,
      procedure.procedureId,
      executionContext,
    );
  }

  // e. 父 revision 双重 fail-closed（D2）：快照与验证来源任一不等即失配
  if (
    input.selectedSkill.skillRevision !== procedure.parentSkillRevision ||
    env.currentSkillRevision !== procedure.parentSkillRevision
  ) {
    return decision(
      input,
      "skill_md",
      "revision_mismatch",
      "load_parent_skill",
      [],
      false,
      procedure.procedureId,
      executionContext,
    );
  }

  // f. 依赖指纹（含 ADR-0011 fail-closed：声明了权限但 fingerprint 缺 permissionPolicyHash）
  const permissionBound =
    procedure.declaredEffects.length > 0 || procedure.requiredPermissions.length > 0;
  if (permissionBound && procedure.dependencyFingerprint.permissionPolicyHash === undefined) {
    return decision(
      input,
      "skill_md",
      "dependency_mismatch",
      "load_parent_skill",
      [],
      false,
      procedure.procedureId,
      executionContext,
    );
  }
  if (!dependencyFingerprintMatches(procedure.dependencyFingerprint, env.currentDependencyFingerprint)) {
    return decision(
      input,
      "skill_md",
      "dependency_mismatch",
      "load_parent_skill",
      [],
      false,
      procedure.procedureId,
      executionContext,
    );
  }

  // 版本/依赖匹配后评估前置条件（g 分支）。
  const precondition = evaluatePreconditions(procedure, env);

  // g. 前置条件 fail/unknown
  if (!precondition.allPassed) {
    return decision(
      input,
      "skill_md",
      "precondition_failed",
      "load_parent_skill",
      precondition.checked,
      false,
      procedure.procedureId,
      executionContext,
    );
  }

  // h. effects 集合精确相等（D4）
  if (!effectsSetEqual(env.requestedEffects, procedure.declaredEffects)) {
    return decision(
      input,
      "skill_md",
      "unsupported_effect",
      "load_parent_skill",
      precondition.checked,
      false,
      procedure.procedureId,
      executionContext,
    );
  }

  // i. 外部授权 gate 要求先授权（真正授权由外部 gate 完成）
  if (env.authorizationRequired) {
    return decision(
      input,
      "compiled_procedure",
      "authorization_required",
      "load_parent_skill",
      precondition.checked,
      true,
      procedure.procedureId,
      executionContext,
    );
  }

  // j. 全部满足 → 快路径
  return decision(
    input,
    "compiled_procedure",
    "eligible_procedure",
    "load_parent_skill",
    precondition.checked,
    false,
    procedure.procedureId,
    executionContext,
  );
}
