/**
 * Drift E2E —— 真实 ExtensionRunner 下 current 来源失配的 resolver drift 验证（cc HIGH 1 + HIGH 2）。
 *
 * 与 host-integration.test.ts（fixture 候选，fast_path）互补：本测试用真实 runner 加载
 * 临时 entry，该 entry 注入 per-call current provider（模拟当次 discovery 候选卡失配），
 * 验证：
 *
 *   a. 注入失配 currentSkillRevision（≠ procedure revision）⇒ resolver e 分支
 *      revision_mismatch ⇒ slow_path（decision.mode=skill_md），不得 fast_path；
 *   b. 注入失配 currentDependencyFingerprint（≠ procedure fingerprint）⇒ resolver f 分支
 *      dependency_mismatch ⇒ slow_path；
 *   c. 对照：provider 返回匹配 current 值 ⇒ fast_path 仍可落盘（注入链路本身可用，
 *      非整体失效）；
 *   d. Point B：provider 注册但候选缺失（drift-miss- 前缀 ⇒ provider 返回 undefined）
 *      ⇒ fail-closed slow_path（不 self-match）⇒ 不落 verified 事件。
 *
 * HIGH 2：slow_path 属 pre-execution 拒绝（compiled procedure 未执行），
 * decodePilotDetailsToEvidence fail-closed 返回 undefined ⇒ observer 不产生
 * compiled 事件 ⇒ 即使候选快照身份匹配（P3_GATE_FROZEN ∈ 快照、preflight 放行），
 * settle 后 store 也无 shadow/verified 事件。
 *
 * 隔离：真实 runner 用 --no-session 等价隔离（ExtensionRunner 内存 runner + fixture）；
 * store 落在 <fixture>/.skill-cortex/practice（project-local），不写用户环境。
 * 候选快照由 entry 内模拟 push（exposedToAgent=true），不依赖真实 skill（可移植，
 * 进 npm test 默认全量）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createEventBus,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  createExtensionRuntime,
  loadExtensions,
  ExtensionRunner,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import { buildSystemPrompt } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import {
  PILOT_TOOL_NAME,
  type PilotToolDetails,
} from "../../adapters/pi/execution-adapter.ts";
import { defaultTenantScope } from "../../adapters/pi/practice-observer.ts";
import { decodePilotDetailsToEvidence } from "./host-integration-entry.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import { buildCanaryValidatedProcedure } from "./canary.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const PROCEDURE = buildCanaryValidatedProcedure();
const SKILL_ID = PROCEDURE.parentSkillId;
const SKILL_REVISION = PROCEDURE.parentSkillRevision;
const DRIFT_REVISION = "rev:" + "f".repeat(64);
const DRIFT_SOURCE_HASH = "0".repeat(64);

const OFFSET_SQL = "SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;";

let fixtureRoot = "";
let originalCwd = "";
let tempDirs: string[] = [];
let runner: ExtensionRunner;
let store: PracticeStore;

function pilotParams(sql: string): Record<string, unknown> {
  return { sql, skill_id: SKILL_ID, skill_revision: SKILL_REVISION };
}

/** 临时 entry：模拟当次候选快照（含 SKILL_ID）+ 注入失配 current provider。 */
function driftEntrySource(): string {
  return `
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createDiscoverySnapshotSource,
  registerPracticeObserver,
} from "../src/adapters/pi/practice-observer.ts";
import {
  PILOT_TOOL_NAME,
  registerSkillCortexPaginationShadow,
  type PilotCurrentProvider,
} from "../src/adapters/pi/execution-adapter.ts";
import { decodePilotDetailsToEvidence } from "../src/evaluation/phase4/host-integration-entry.ts";
import { PracticeStore } from "../src/practice/store/index.ts";

const SKILL_ID = ${JSON.stringify(SKILL_ID)};
const SKILL_REVISION = ${JSON.stringify(SKILL_REVISION)};
const DRIFT_REVISION = ${JSON.stringify(DRIFT_REVISION)};
const DRIFT_SOURCE_HASH = ${JSON.stringify(DRIFT_SOURCE_HASH)};

export default function driftEntry(pi: ExtensionAPI): void {
  const projectRoot = process.cwd();
  const source = createDiscoverySnapshotSource();

  // 模拟当次 discovery 快照：候选含目标 skill（身份匹配）；先于 observer 注册 push。
  // push 消费 DiscoveryResult 形状（candidates: SkillCandidate[]；内部只映射 id/revision）。
  pi.on("before_agent_start", async () => {
    source.push({
      exposedToAgent: true,
      deliveryMode: "inject",
      candidates: [{ skillId: SKILL_ID, skillRevision: SKILL_REVISION }],
      recordCount: 1,
      durationMs: 0,
      topK: 1,
    });
  });

  registerPracticeObserver(pi, {
    store: new PracticeStore({
      rootDir: path.join(projectRoot, ".skill-cortex", "practice"),
      projectRoot,
    }),
    projectRoot,
    routeSnapshotSource: source,
    compiledTool: { toolName: PILOT_TOOL_NAME, decode: decodePilotDetailsToEvidence },
  });

  // per-call current provider：按 toolCallId 注入失配/匹配 current 值（模拟失配候选卡）。
  const provider: PilotCurrentProvider = ({ toolCallId, procedure }) => {
    if (toolCallId.startsWith("drift-rev-")) {
      return {
        currentSkillRevision: DRIFT_REVISION,
        currentDependencyFingerprint: { ...procedure.dependencyFingerprint },
        guardObservations: [
          { predicateId: "source-and-dependency-match", phase: "runtime", result: true },
        ],
      };
    }
    if (toolCallId.startsWith("drift-dep-")) {
      return {
        currentSkillRevision: procedure.parentSkillRevision,
        currentDependencyFingerprint: { sourceHash: DRIFT_SOURCE_HASH },
        guardObservations: [
          { predicateId: "source-and-dependency-match", phase: "runtime", result: true },
        ],
      };
    }
    if (toolCallId.startsWith("drift-ok-")) {
      return {
        currentSkillRevision: procedure.parentSkillRevision,
        currentDependencyFingerprint: { ...procedure.dependencyFingerprint },
        guardObservations: [
          { predicateId: "source-and-dependency-match", phase: "runtime", result: true },
        ],
      };
    }
    return undefined;
  };

  registerSkillCortexPaginationShadow(pi, { currentProvider: provider });
}
`;
}

before(async () => {
  originalCwd = process.cwd();
  const root = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-drift-e2e-"));
  tempDirs.push(root);
  fixtureRoot = root;
  // entry 以 process.cwd() 为 projectRoot；测试隔离到 fixture 根。
  process.chdir(root);

  const entry = path.join(root, "drift-entry.ts");
  writeFileSync(entry, driftEntrySource());

  const { extensions, errors, runtime } = await loadExtensions(
    [entry],
    fixtureRoot,
    createEventBus(),
  );
  assert.deepEqual(errors, [], "drift entry 必须能被宿主 loader 无错加载");
  assert.equal(extensions.length, 1);

  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
    modelsPath: null,
    authPath: path.join(fixtureRoot, "auth.json"),
  });
  const sessionManager = SessionManager.inMemory(fixtureRoot);
  runner = new ExtensionRunner(
    extensions,
    runtime,
    fixtureRoot,
    sessionManager,
    new ModelRegistry(modelRuntime),
  );
  store = new PracticeStore({
    rootDir: path.join(fixtureRoot, ".skill-cortex", "practice"),
    projectRoot: fixtureRoot,
  });
});

after(async () => {
  process.chdir(originalCwd);
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

/** 一次 before_agent_start：entry 模拟 push 候选快照 + observer 建 run（cortex 未接线 ⇒ 不修改 prompt）。 */
async function startRun(): Promise<void> {
  const basePrompt = buildSystemPrompt({ cwd: fixtureRoot, skills: [], contextFiles: [] });
  // 本 entry 不注册 cortex（无需修改 systemPrompt）；observer/快照 handler 经事件广播生效。
  await runner.emitBeforeAgentStart(
    "drift probe task",
    undefined,
    basePrompt,
    { cwd: fixtureRoot, skills: [], contextFiles: [] },
  );
}

/** preflight 放行 + 工具执行 + tool_result（observer 采集）；返回 details。 */
async function driftCall(toolCallId: string): Promise<PilotToolDetails> {
  const params = pilotParams(OFFSET_SQL);
  const preflight = await runner.emitToolCall({
    type: "tool_call",
    toolCallId,
    toolName: PILOT_TOOL_NAME,
    input: params,
  });
  assert.equal(preflight, undefined, "身份匹配必须放行（drift 在 execute 层注入）");

  const def = runner.getToolDefinition(PILOT_TOOL_NAME)!;
  const result = await def.execute(
    toolCallId,
    params as never,
    undefined,
    undefined,
    runner.createContext(),
  );
  await runner.emitToolResult({
    type: "tool_result",
    toolCallId,
    toolName: PILOT_TOOL_NAME,
    input: params,
    content: result.content,
    isError: false,
    details: result.details,
  });
  return result.details as PilotToolDetails;
}

describe("drift E2E：注入失配候选 current 值 ⇒ resolver drift ⇒ slow_path 且不落 verified 事件", () => {
  it("a. revision 失配 ⇒ slow_path（reason=revision_mismatch）；HIGH 2 排除 ⇒ 无 shadow 事件", async () => {
    await startRun();
    const details = await driftCall("drift-rev-1");
    assert.equal(details.outcome, "slow_path");
    assert.equal(details.decision.mode, "skill_md");
    assert.equal(details.decision.reason, "revision_mismatch");
    assert.equal(details.fallback?.mode, "load_parent_skill");
    assert.deepEqual(details.authorization_results, [], "resolver 拒绝 ⇒ 不调授权 gate");
    assert.deepEqual(details.step_summaries, [], "未执行 artifact");

    await runner.emit({ type: "agent_settled" });
    const events = await store.listProvenance(defaultTenantScope(fixtureRoot), "shadow");
    assert.equal(events.length, 0, "pre-execution 拒绝不得产生 compiled/verified 事件");

    // HIGH 2 单测：slow_path details 必须被 decoder fail-closed 排除。
    assert.equal(decodePilotDetailsToEvidence(details), undefined, "slow_path 不得解码为 CompiledExecutionEvidence");
  });

  it("b. fingerprint 失配 ⇒ slow_path（reason=dependency_mismatch）；HIGH 2 排除 ⇒ 无 shadow 事件", async () => {
    await startRun();
    const details = await driftCall("drift-dep-1");
    assert.equal(details.outcome, "slow_path");
    assert.equal(details.decision.mode, "skill_md");
    assert.equal(details.decision.reason, "dependency_mismatch");
    assert.equal(details.fallback?.mode, "load_parent_skill");
    assert.deepEqual(details.authorization_results, []);

    await runner.emit({ type: "agent_settled" });
    const events = await store.listProvenance(defaultTenantScope(fixtureRoot), "shadow");
    assert.equal(events.length, 0, "依赖指纹失配不得产生 compiled/verified 事件");
    assert.equal(decodePilotDetailsToEvidence(details), undefined);
  });

  it("d. Point B：provider 注册但候选缺失（drift-miss- 前缀）⇒ fail-closed slow_path（不 self-match）⇒ 0 事件", async () => {
    await startRun();
    const details = await driftCall("drift-miss-1");
    // 候选缺失 ⇒ provider 返回 undefined ⇒ adapter fail-closed（不得回退 procedure self-match）。
    assert.equal(details.outcome, "slow_path");
    assert.equal(details.decision.mode, "skill_md");
    assert.equal(details.decision.reason, "revision_mismatch", "current source 缺失 ⇒ resolver e 分支 fail-closed");
    assert.equal(details.fallback?.mode, "load_parent_skill");
    assert.deepEqual(details.step_summaries, [], "未执行 artifact");

    await runner.emit({ type: "agent_settled" });
    const events = await store.listProvenance(defaultTenantScope(fixtureRoot), "shadow");
    assert.equal(events.length, 0, "候选缺失不得产生 compiled/verified 事件");
    assert.equal(decodePilotDetailsToEvidence(details), undefined);
  });

  it("c. 对照：provider 返回匹配 current 值 ⇒ fast_path 仍可落盘（注入链路可用）", async () => {
    await startRun();
    const details = await driftCall("drift-ok-1");
    assert.equal(details.outcome, "fast_path");
    assert.equal(details.decision.reason, "eligible_procedure");

    await runner.emit({ type: "agent_settled" });
    const events = await store.listProvenance(defaultTenantScope(fixtureRoot), "shadow");
    assert.equal(events.length, 1, "匹配 current 值必须落 1 个 shadow 事件");
    assert.equal(events[0]!.parentSkillId, SKILL_ID);
    assert.equal(events[0]!.executionMode, "compiled_procedure");
    assert.equal(events[0]!.attribution, "verified_skill_effect");
    // fast_path 属真正执行 ⇒ decoder 必须放行。
    assert.ok(decodePilotDetailsToEvidence(details) !== undefined, "fast_path 必须可解码");
  });
});
