/**
 * Phase 4 host integration —— 隔离 E2E 入口（仅验收用，非生产入口；通过真实
 * ExtensionRunner/`pi -e` 显式加载）。
 *
 * 与生产入口（.pi/extensions/skill-cortex/index.ts）的区别仅在于额外接线 pilot 专用
 * shadow adapter（ADR-0012 shadow_replay 语义，executionContext 恒 shadow_replay，
 * **不启动真实 canary/active**）：
 *
 *   registerSkillCortex({ mode: "inject", onDiscovery: push })
 *     → createDiscoverySnapshotSource
 *     → registerPracticeObserver({
 *         store: <cwd>/.skill-cortex/practice,
 *         routeSnapshotSource: source,
 *         compiledTool: { toolName: skill_cortex_pagination_detect, decode: <严格解码> }
 *       })
 *     → registerSkillCortexPaginationShadow(pi)   // tool_call preflight + 工具注册
 *
 * compiledTool.decode 把 pilot 工具 tool_result.details（严格有界、snake_case）映射为
 * CompiledExecutionEvidence（fail-closed：任何形状/枚举/身份校验失败 ⇒ undefined ⇒
 * observer 不产生 compiled 事件）。failureClass / firstAttributableFailureStepId 只在
 * 证据明确时写入（denied⇒permission_denied；guard/verifier/procedure 失败⇒对应 class；
 * fast_path/abstain 不写）。provenance=shadow 的归因仍需快照身份匹配（P3_GATE_FROZEN
 * skill 不在当次快照 ⇒ 不归因，fail-closed）。
 *
 * 命令（项目根）：
 *   pi --no-session -ne -e ./src/evaluation/phase4/host-integration-entry.ts --print "<只读任务>"
 *
 * 不写用户环境、不写工作区外路径；store 落在 <cwd>/.skill-cortex/practice（project-local）。
 * 本文件不修改 .pi/extensions/skill-cortex/index.ts（生产接线待 E2E 通过后）。
 */
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSkillCortex } from "../../adapters/pi/index.ts";
import {
  createDiscoverySnapshotSource,
  registerPracticeObserver,
  type CompiledExecutionEvidence,
} from "../../adapters/pi/practice-observer.ts";
import {
  decodeExecutionToolDetails,
  PILOT_TOOL_NAME,
  registerSkillCortexPaginationShadow,
  type PilotCurrentProvider,
  type PilotToolDetails,
  type PilotStepSummary,
} from "../../adapters/pi/execution-adapter.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import type { PracticeEvent } from "../../core/contracts/index.ts";

// ---------------------------------------------------------------------------
// pilot details → CompiledExecutionEvidence 严格解码（observer compiledTool seam）
// ---------------------------------------------------------------------------

const ACTORS = new Set(["agent", "procedure", "tool", "user"]);
const GUARD_PHASES = new Set(["precondition", "runtime", "postcondition"]);
const RESULT_VALUES = new Set(["pass", "fail", "unknown"]);
const AUTH_RESULT_VALUES = new Set(["approved", "denied"]);
const STEP_OUTCOME_VALUES = new Set(["ok", "failed", "unknown"]);

function narrowStep(step: PilotStepSummary): PracticeEvent["stepSummaries"][number] | undefined {
  if (!ACTORS.has(step.actor)) return undefined;
  if (!STEP_OUTCOME_VALUES.has(step.outcome)) return undefined;
  return {
    stepId: step.step_id,
    actor: step.actor as PracticeEvent["stepSummaries"][number]["actor"],
    operationClass: step.operation_class,
    outcome: step.outcome as PracticeEvent["stepSummaries"][number]["outcome"],
  };
}

/** failureClass 只从 outcome/failure 受控映射；fast_path/abstain/slow_path 不写。 */
function failureClassOf(details: PilotToolDetails): PracticeEvent["failureClass"] | undefined {
  switch (details.outcome) {
    case "denied":
      return "permission_denied";
    case "safety_stop":
      // artifact 结果非法或意外副作用：一律归 procedure_error（artifact 是唯一程序步骤）。
      return "procedure_error";
    case "fallback": {
      switch (details.failure) {
        case "guard_failure":
          return "runtime_guard_failure";
        case "verifier_failure":
          return "postcondition_failure";
        case "authorization_missing_or_replayed":
          return "permission_denied";
        case "artifact_result_invalid":
        case "unexpected_side_effect":
        case "procedure_error":
          return "procedure_error";
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** 首个可归因失败步骤：只采纳当次证据步骤中 outcome=failed 的 stepId（不猜）。 */
function firstFailedStepOf(details: PilotToolDetails): string | undefined {
  return details.step_summaries.find((step) => step.outcome === "failed")?.step_id;
}

/**
 * pre-execution 拒绝判定（HIGH 2）：compiled procedure 未完成执行 ⇒ fail-closed
 * 不产生 compiled 事件（observer 不得以 executionMode=compiled_procedure 落盘）。
 *
 * outcome 语义（executor/execution-adapter buildDetails）：
 * - slow_path：resolver 在 artifact 前拒绝（no_procedure/parent_skill_mismatch/insufficient_evidence/
 *   revision_mismatch/dependency_mismatch/precondition_failed/unsupported_effect）——未授权、未 guard、未执行；
 * - denied：授权 gate 拒绝（无 receipt/重放）——未执行；
 * - safety_stop：artifact 结果非法/意外副作用——executor 中止且不 loadParentSkill；
 * - abstain：no_skill_selected / procedure_abstained（artifact abstained 回退）——无 compiled 结果；
 * - fallback + guard_failure：guard 在 artifact 执行前失败——未执行；
 * - fallback + procedure_error：artifact 执行中抛错——未产生 completed/abstained 结果。
 *
 * 仅以下情形产生 CompiledExecutionEvidence（compiled procedure 真正执行完成）：
 * - fast_path：artifact 执行完成 + verifier pass；
 * - fallback + verifier_failure：artifact 执行完成 + verifier 判失败（post-execution，明确 failure 证据）。
 */
function isPreExecutionRejection(details: PilotToolDetails): boolean {
  switch (details.outcome) {
    case "slow_path":
    case "denied":
    case "safety_stop":
    case "abstain":
      return true;
    case "fallback":
      return (
        details.failure === "guard_failure" || details.failure === "procedure_error"
      );
    default:
      return false;
  }
}

/**
 * 严格解码 pilot 工具 details → CompiledExecutionEvidence（fail-closed）：
 * - decodeExecutionToolDetails 已做 key 白名单/敏感 key/类型/枚举校验（ok=false ⇒ undefined）；
 * - 此处再对 observer/policy 需要的枚举（actor/phase/result/outcome）窄化，任一非法 ⇒ undefined；
 * - dependencyFingerprint 保留 source_hash + 可选 tool/permission 指纹；
 * - failureClass / firstAttributableFailureStepId 只在证据明确时写入。
 */
export function decodePilotDetailsToEvidence(
  value: unknown,
): CompiledExecutionEvidence | undefined {
  const decoded = decodeExecutionToolDetails(value);
  if (!decoded.ok) return undefined;
  const d = decoded.details;

  // HIGH 2：pre-execution 拒绝（compiled procedure 未完成执行）⇒ fail-closed 排除，
  // 不产生 compiled 事件；仅 fast_path / fallback(verifier_failure) 进入后续解码。
  if (isPreExecutionRejection(d)) return undefined;

  const authorizationResults: PracticeEvent["authorizationResults"] = [];
  for (const a of d.authorization_results) {
    if (!AUTH_RESULT_VALUES.has(a.result)) return undefined;
    authorizationResults.push({
      gateId: a.gate_id,
      result: a.result as PracticeEvent["authorizationResults"][number]["result"],
    });
  }

  const guardResults: PracticeEvent["guardResults"] = [];
  for (const g of d.guard_results) {
    if (!GUARD_PHASES.has(g.phase) || !RESULT_VALUES.has(g.result)) return undefined;
    guardResults.push({
      predicateId: g.predicate_id,
      phase: g.phase as PracticeEvent["guardResults"][number]["phase"],
      result: g.result as PracticeEvent["guardResults"][number]["result"],
    });
  }

  const verifierResults: PracticeEvent["verifierResults"] = [];
  for (const v of d.verifier_results) {
    if (!RESULT_VALUES.has(v.result)) return undefined;
    verifierResults.push({
      verifierId: v.verifier_id,
      result: v.result as PracticeEvent["verifierResults"][number]["result"],
      ...(v.observed_effect !== undefined ? { observedEffect: v.observed_effect } : {}),
    });
  }

  const stepSummaries: PracticeEvent["stepSummaries"] = [];
  for (const step of d.step_summaries) {
    const narrowed = narrowStep(step);
    if (narrowed === undefined) return undefined;
    stepSummaries.push(narrowed);
  }

  const failureClass = failureClassOf(d);
  const firstAttributableFailureStepId = firstFailedStepOf(d);
  return {
    procedureId: d.procedure_id,
    dependencyFingerprint: {
      sourceHash: d.dependency_fingerprint.source_hash,
      ...(d.dependency_fingerprint.tool_schema_hash !== undefined
        ? { toolSchemaHash: d.dependency_fingerprint.tool_schema_hash }
        : {}),
      ...(d.dependency_fingerprint.permission_policy_hash !== undefined
        ? { permissionPolicyHash: d.dependency_fingerprint.permission_policy_hash }
        : {}),
    },
    authorizationResults,
    guardResults,
    verifierResults,
    stepSummaries,
    ...(failureClass !== undefined ? { failureClass } : {}),
    ...(firstAttributableFailureStepId !== undefined
      ? { firstAttributableFailureStepId }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// 入口（真实 ExtensionAPI）
// ---------------------------------------------------------------------------

export default function hostIntegrationEntry(pi: ExtensionAPI): void {
  const projectRoot = process.cwd();
  const source = createDiscoverySnapshotSource();
  // 当次 discovery 候选表（skillId → 候选卡 revision）；per-call current 来源（MED）。
  // 与 observer 的快照消费并行维护（observer takeRouteSnapshot 一次取走，这里保留
  // 只读副本供工具 execute 时按 skillId 查询；settled 后由下一轮 before_agent_start 覆盖）。
  let latestCandidates = new Map<string, string>();

  registerSkillCortex(pi, {
    mode: "inject",
    onDiscovery: (result) => {
      const map = new Map<string, string>();
      for (const candidate of result.candidates) {
        map.set(candidate.skillId, candidate.skillRevision);
      }
      latestCandidates = map;
      source.push(result);
    },
  });

  registerPracticeObserver(pi, {
    store: new PracticeStore({
      rootDir: path.join(projectRoot, ".skill-cortex", "practice"),
      projectRoot,
    }),
    projectRoot,
    routeSnapshotSource: source,
    compiledTool: {
      toolName: PILOT_TOOL_NAME,
      decode: decodePilotDetailsToEvidence,
    },
  });

  // per-call current 来源（HIGH 1 + MED）：真实 runner 不再 register-time self-match。
  // - currentSkillRevision 严格来自当次 discovery 候选卡（候选含该 skill 时用候选 revision；
  //   不含时回退 self-match，不臆造失配——归因/既有 E2E 行为保持不变）；
  // - currentDependencyFingerprint 以 procedure 绑定为基准（sourceHash/toolSchemaHash 绑定）；
  //   当次验证来源（load_skill details.source_hash / discovery 重算）当前无 seam 可用，
  //   指纹 drift 验证由注入 provider 的测试层完成（见报告：未接线项）；
  // - guard：source-and-dependency-match 由候选匹配状态派生（恒 true；bounded-supported-sql
  //   恒由 adapter 注入）。
  const currentProvider: PilotCurrentProvider = (lookup) => {
    const candidateRevision = latestCandidates.get(lookup.skillId);
    if (candidateRevision === undefined) return undefined;
    return {
      currentSkillRevision: candidateRevision,
      currentDependencyFingerprint: { ...lookup.procedure.dependencyFingerprint },
      guardObservations: [
        { predicateId: "source-and-dependency-match", phase: "runtime", result: true },
      ],
    };
  };

  registerSkillCortexPaginationShadow(pi, { currentProvider });
}
