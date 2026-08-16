/**
 * observer 完整归因 E2E —— 端到端证据链闭环（真实 skill 只读，non-portable）。
 *
 * 与 host-integration.test.ts（docx-a/pdf fixture skill，归因 fail-closed）互补：本测试
 * 把**真实安装的** supabase-postgres-best-practices（只读加载，不复制正文、不写 .agents）
 * 作为 discovery 输入，验证完整证据链：
 *
 *   真实 skill ∈ 候选快照（identity === P3_GATE_FROZEN 冻结值）
 *     → compiled tool 调用（skill_id/revision 匹配，preflight receipt）
 *     → 工具执行 fast_path（detector 纯只读纯函数确定性复现）
 *     → tool_result 经 registerPracticeObserver compiledTool seam 严格解码
 *     → provenance=shadow PracticeEvent 落盘 project-local store
 *     → attribution=verified_skill_effect，policy 校验通过，round-trip 可查。
 *
 * 硬约束：
 * - non-portable：真实 skill 缺席 ⇒ 整个 suite skip（不 fail）；不进入 `npm test` 默认
 *   全量（`node --test` 只匹配 `*.test.*`，本文件为 `*.check.ts`，需显式运行：
 *   `node --test src/evaluation/phase4/attribution-e2e.check.ts`）。
 * - 原 skill 只读：只读取 SKILL.md 字节与路径；不复制正文、不移动、不修改 .agents 下
 *   任何文件（ADR-0010：不需要复制 Skill 正文或示例）。
 * - 不启动 canary/active；executionContext 恒 shadow_replay。
 * - 身份冻结校验：真实 skill 的 skillId/skillRevision/sourceHash 与 P3_GATE_FROZEN 不符
 *   ⇒ 显式 fail（冻结值失效必须报告，不硬推）。
 *
 * 零 I/O 措辞：只断言"detector 为纯只读纯函数、独立复现输出一致"；sideEffectCount=0 仅
 * artifact 自报 + executor safety_stop 门保证（非 0 不进 fast_path），不宣称"已证明零 I/O"。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createEventBus,
  loadSkillsFromDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  createExtensionRuntime,
  loadExtensions,
  ExtensionRunner,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import { buildSystemPrompt } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import { PILOT_TOOL_NAME, type PilotToolDetails } from "../../adapters/pi/execution-adapter.ts";
import { defaultTenantScope } from "../../adapters/pi/practice-observer.ts";
import { PAGINATION_VERIFIER_ID } from "../../adapters/pi/practice-pagination-hook.ts";
import { buildSkillRecord, type SkillPackageInput } from "../../core/registry/index.ts";
import type { PracticeEvent } from "../../core/contracts/index.ts";
import { validatePracticeEvent } from "../../practice/policy/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import { detectPagination } from "../../procedures/phase3/detector.ts";
import { buildCanaryValidatedProcedure } from "./canary.ts";
import { P3_GATE_FROZEN } from "../phase3/p3-gate-runner.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const ENTRY = path.join(PROJECT_ROOT, "src", "evaluation", "phase4", "host-integration-entry.ts");

/** 真实安装路径（inventory 已核验；原 skill 保持只读）。 */
const REAL_SKILL_ROOT = "C:\\Users\\a1324\\.agents\\skills\\supabase-postgres-best-practices";
const REAL_SKILL_MD = path.join(REAL_SKILL_ROOT, "SKILL.md");

const PROCEDURE = buildCanaryValidatedProcedure();
const SKILL_ID = P3_GATE_FROZEN.parentSkillId;
const SKILL_REVISION = P3_GATE_FROZEN.parentSkillRevision;
const SOURCE_HASH = P3_GATE_FROZEN.sourceHash;

const OFFSET_SQL = "SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;";
const KEYSET_SQL = "SELECT * FROM posts WHERE id > $1 ORDER BY id LIMIT 20;";

let fixtureRoot = "";
let originalCwd = "";
let tempDirs: string[] = [];
let runner: ExtensionRunner;
let store: PracticeStore;
let realSkill: Skill;

/** 只读构造真实 skill 的 registry 输入（与 host 侧 mapSkills 同构）。 */
function realSkillPackageInput(): SkillPackageInput {
  return {
    name: "supabase-postgres-best-practices",
    description: "Postgres performance optimization and best practices from Supabase.",
    scope: "user",
    baseDir: REAL_SKILL_ROOT,
    skillMdPath: REAL_SKILL_MD,
    disableModelInvocation: false,
    declaredAliases: [],
    declaredPermissions: [],
    declaredEffects: [],
  };
}

const suite = existsSync(REAL_SKILL_MD) ? describe : describe.skip;

suite("observer 完整归因 E2E（真实 skill 只读，non-portable，显式运行）", () => {
  before(async () => {
    // 身份冻结校验：真实 skill identity 必须与 P3_GATE_FROZEN 完全一致（fail 显式报告）。
    const record = await buildSkillRecord(realSkillPackageInput());
    assert.equal(record.skillId, SKILL_ID, `真实 skill skillId 与冻结值不符（${record.skillId}）`);
    assert.equal(
      record.skillRevision,
      SKILL_REVISION,
      `真实 skill revision 与冻结值不符（${record.skillRevision}）`,
    );
    assert.equal(record.sourceHash, SOURCE_HASH, `真实 skill sourceHash 与冻结值不符（${record.sourceHash}）`);

    // 宿主 loader 加载真实 skill（只读；sourceInfo 真实）。
    const { skills, diagnostics } = loadSkillsFromDir({ dir: REAL_SKILL_ROOT, source: "user" });
    assert.ok(diagnostics.length === 0, `真实 skill 解析不得有诊断错误: ${JSON.stringify(diagnostics)}`);
    const found = skills.find((s) => s.name === "supabase-postgres-best-practices");
    assert.ok(found, "宿主 loader 必须能加载真实 skill");
    realSkill = found!;

    // fixture 隔离（entry 以 process.cwd() 为 projectRoot；chdir 后 loadExtensions）。
    originalCwd = process.cwd();
    const root = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-attrib-e2e-"));
    tempDirs.push(root);
    fixtureRoot = root;
    process.chdir(root);

    const { extensions, errors, runtime } = await loadExtensions([ENTRY], fixtureRoot, createEventBus());
    assert.deepEqual(errors, [], "host-integration-entry 必须能被宿主 loader 无错加载");
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

  /**
   * 完整证据链：before_agent_start（真实 skill 摄入+注入候选）→ preflight 放行 →
   * 工具执行（独立复现 detector 输出）→ tool_result（observer 解码）→ settle（落盘）。
   */
  async function runFullChain(
    toolCallId: string,
    sql: string,
    expectedClass: "uses_offset" | "uses_keyset",
  ): Promise<PilotToolDetails> {
    const basePrompt = buildSystemPrompt({
      cwd: fixtureRoot,
      skills: [realSkill],
      contextFiles: [{ path: "AGENTS.md", content: "project context" }],
    });
    const injectResult = await runner.emitBeforeAgentStart(
      "Detect OFFSET pagination in a Postgres SQL query and return a structured finding",
      undefined,
      basePrompt,
      { cwd: fixtureRoot, skills: [realSkill], contextFiles: [] },
    );
    assert.ok(injectResult && typeof injectResult.systemPrompt === "string", "inject 必须成功");
    assert.ok(
      injectResult.systemPrompt.includes("## Skill Cortex：prompt 外候选（有界 Top-K）"),
      "候选卡必须注入最终 prompt",
    );
    assert.ok(
      injectResult.systemPrompt.includes(SKILL_ID),
      "真实 skill（skill_id 与冻结值一致）必须进入候选卡",
    );

    const params = { sql, skill_id: SKILL_ID, skill_revision: SKILL_REVISION };
    const preflight = await runner.emitToolCall({
      type: "tool_call",
      toolCallId,
      toolName: PILOT_TOOL_NAME,
      input: params,
    });
    assert.equal(preflight, undefined, "身份匹配必须放行");

    const def = runner.getToolDefinition(PILOT_TOOL_NAME)!;
    const result = await def.execute(toolCallId, params as never, undefined, undefined, runner.createContext());
    const details = result.details as PilotToolDetails;
    assert.equal(details.outcome, "fast_path", `case ${expectedClass} 必须 fast_path`);
    assert.equal(details.finding_class, expectedClass);
    // 零 I/O 措辞：detector 纯只读纯函数，独立复现输出必须一致（输出仅由输入决定）。
    assert.equal(details.finding_class, detectPagination(sql).class, "detector 确定性复现必须一致");
    assert.equal(details.decision.execution_context, "shadow_replay", "executionContext 恒 shadow_replay");
    assert.equal(details.source_hash, SOURCE_HASH, "details 必须绑定真实 source hash");
    assert.equal(details.skill_id, SKILL_ID);
    assert.equal(details.skill_revision, SKILL_REVISION);

    await runner.emitToolResult({
      type: "tool_result",
      toolCallId,
      toolName: PILOT_TOOL_NAME,
      input: params,
      content: result.content,
      isError: false,
      details: result.details,
    });
    await runner.emit({ type: "agent_settled" });
    return details;
  }

  /** 单条 shadow 事件的完整归因字段断言。 */
  function assertAttributedEvent(event: PracticeEvent, message: string): void {
    assert.equal(event.provenance, "shadow", `${message}: provenance`);
    assert.equal(event.executionMode, "compiled_procedure", `${message}: executionMode`);
    assert.equal(event.parentSkillId, SKILL_ID, `${message}: 父 skillId 必须绑定真实 skill`);
    assert.equal(event.parentSkillRevision, SKILL_REVISION, `${message}: 父 revision 必须绑定冻结值`);
    assert.equal(event.sourceHash, SOURCE_HASH, `${message}: sourceHash 必须绑定真实 SKILL.md`);
    assert.equal(event.dependencyFingerprint?.sourceHash, SOURCE_HASH, `${message}: 依赖指纹源哈希`);
    assert.equal(event.procedureId, PROCEDURE.procedureId, `${message}: procedureId`);
    assert.ok(event.candidateSkillIds.includes(SKILL_ID), `${message}: 归因必须要求 skill ∈ 当次候选快照`);
    assert.deepEqual(event.selectedSkillIds, [SKILL_ID], `${message}: 选中`);
    assert.deepEqual(
      event.authorizationResults,
      [{ gateId: "pilot_receipt", result: "approved" }],
      `${message}: 授权 receipt gate`,
    );
    assert.ok(event.guardResults.length > 0, `${message}: 必须有 guard 观察`);
    assert.ok(event.guardResults.every((g) => g.result === "pass"), `${message}: guard 全 pass`);
    assert.ok(
      event.verifierResults.some((v) => v.verifierId === PAGINATION_VERIFIER_ID && v.result === "pass"),
      `${message}: 结构化 finding verifier 必须 pass`,
    );
    assert.equal(event.attribution, "verified_skill_effect", `${message}: 归因必须 verified`);
    assert.ok(
      event.stepSummaries.some(
        (s) => s.operationClass === "tool:skill_cortex_pagination_detect" && s.outcome === "ok",
      ),
      `${message}: 宿主工具步骤`,
    );
    assert.ok(
      event.stepSummaries.some(
        (s) => s.operationClass === "detect-offset-pagination" && s.outcome === "ok",
      ),
      `${message}: procedure detect 步骤`,
    );
    assert.equal(validatePracticeEvent(event).ok, true, `${message}: 必须通过 Practice policy 校验`);
    // 脱敏：事件不得泄漏原始 SQL。
    assert.ok(!JSON.stringify(event).includes(OFFSET_SQL) && !JSON.stringify(event).includes(KEYSET_SQL), `${message}: 不得泄漏原始 SQL`);
  }

  it("归因链闭环：真实 skill ∈ 快照 → compiled 调用 → tool_result 解码 → provenance=shadow 事件（offset）", async () => {
    const details = await runFullChain("att-offset", OFFSET_SQL, "uses_offset");
    void details;

    // shadow 事件落 shadow 分区（queryEvidence 只读 real 分区）；用 listProvenance 查询。
    const events = await store.listProvenance(defaultTenantScope(fixtureRoot), "shadow");
    assert.equal(events.length, 1, "一次真实快路径调用必须产生且仅产生 1 个 shadow 事件");
    assertAttributedEvent(events[0]!, "offset");

    // round-trip：按 eventId 可查回（store 持久化，非内存）。
    const roundTrip = await store.getEvent(events[0]!.tenantScope, events[0]!.eventId);
    assert.ok(roundTrip, "round-trip 必须可查回");
    assert.equal(roundTrip!.eventId, events[0]!.eventId);
    assert.equal(roundTrip!.parentSkillId, SKILL_ID);
    assert.equal(roundTrip!.attribution, "verified_skill_effect");
  });

  it("第二条证据链：keyset SQL 独立复现 + 第二条事件 round-trip（同 skill 不同 run 事件唯一）", async () => {
    await runFullChain("att-keyset", KEYSET_SQL, "uses_keyset");

    const events = await store.listProvenance(defaultTenantScope(fixtureRoot), "shadow");
    assert.equal(events.length, 2, "两条独立 run 必须产生 2 个事件");
    assert.equal(events[0]!.eventId !== events[1]!.eventId, true, "同 skill 不同 run 必须事件唯一");
    for (const event of events) assertAttributedEvent(event, "chain");

    // 两条链的 detector 复现（纯只读函数确定性）在 runFullChain 内已断言；
    // 此处补：事件的 step/verifier 均来自当次调用（无跨 run 串扰）。
    const keyset = events[1]!;
    assert.ok(
      keyset.verifierResults.some((v) => v.observedEffect === "structured-finding-valid"),
      "verifier observedEffect 必须来自当次结构化校验",
    );
  });
});
