/**
 * pilot 专用 shadow adapter 单测（Phase 4 host 接线，project-local）。
 *
 * 覆盖：
 * - preflight：仅本工具；身份匹配 ⇒ 生成一次性 receipt；失配 ⇒ block(受控码, terminate)；
 * - receipt 生命周期：execute 必须消费；无 receipt / 重放 ⇒ executor auth denied（绝不无条件 approved）；
 *   finally 清 receipt；
 * - fast path（uses_offset）/ abstain（procedure_abstained 回退，仅指示 load_skill 不冒充已加载）；
 * - guard fail（非法输入）⇒ fallback；
 * - 注入点（cc HIGH 1）：currentSkillRevision/currentDependencyFingerprint/guardObservations
 *   注入时 resolver revision/dependency 双重校验真实生效（mismatch ⇒ slow_path/load_parent_skill，
 *   不得 fast_path）；未注入回退 procedure 自身值（self-match）行为不变；
 * - details 严格有界：无原始 SQL/路径/error 原文；decodeExecutionToolDetails 严格 fail-closed；
 * - 注册冒烟：fake pi 上注册工具 + tool_call handler。
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  BLOCK_REASON_SKILL_IDENTITY_MISMATCH,
  PILOT_TOOL_NAME,
  createReceiptStore,
  decodeExecutionToolDetails,
  executePaginationDetect,
  preflightPaginationTool,
  registerSkillCortexPaginationShadow,
  type PilotToolDetails,
} from "./execution-adapter.ts";
import { buildCanaryValidatedProcedure } from "../../evaluation/phase4/canary.ts";
import { PAGINATION_VERIFIER_ID } from "./practice-pagination-hook.ts";

const PROCEDURE = buildCanaryValidatedProcedure();
const SKILL_ID = PROCEDURE.parentSkillId;
const SKILL_REVISION = PROCEDURE.parentSkillRevision;
const SOURCE_HASH = PROCEDURE.sourceBindings.skillMdHash;

const FAST_SQL = "SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;";
/** 有界输出探针：details/内容绝不得含该 marker（原始 SQL 泄漏检测）。 */
const SECRET_MARKER = "SECRET_MARKER_xyz";
const MARKED_SQL = `SELECT ${SECRET_MARKER} FROM t ORDER BY id OFFSET 5 LIMIT 3;`;
const ABSTAIN_SQL = "SELECT * FROM logs OFFSET";

function baseParams(overrides: Partial<{ sql: string; skill_id: string; skill_revision: string }> = {}) {
  return {
    sql: FAST_SQL,
    skill_id: SKILL_ID,
    skill_revision: SKILL_REVISION,
    ...overrides,
  };
}

function preflight(toolCallId: string, input: Record<string, unknown>) {
  return preflightPaginationTool({
    toolCallId,
    toolName: PILOT_TOOL_NAME,
    input,
    procedure: PROCEDURE,
    store,
  });
}

let store: ReturnType<typeof createReceiptStore>;

describe("execution adapter：preflight 与 receipt", () => {
  beforeEach(() => {
    store = createReceiptStore();
  });

  it("身份匹配 ⇒ 生成一次性 receipt，返回 undefined（放行）", () => {
    const result = preflight("tc-1", baseParams());
    assert.equal(result, undefined);
    assert.equal(store.has("tc-1"), true);
  });

  it("身份失配（skill_id 或 skill_revision 任一不符）⇒ block(受控码, terminate)，无 receipt", () => {
    for (const params of [
      baseParams({ skill_id: `skill:${"f".repeat(64)}` }),
      baseParams({ skill_revision: `rev:${"f".repeat(64)}` }),
    ]) {
      const result = preflight(`tc-${Math.random()}`, params);
      assert.deepEqual(result, {
        block: true,
        reason: BLOCK_REASON_SKILL_IDENTITY_MISMATCH,
        terminate: true,
      });
    }
    assert.equal(store.size, 0, "失配不得留下 receipt");
  });

  it("非本工具 ⇒ 不处理（undefined），无 receipt", () => {
    const result = preflightPaginationTool({
      toolCallId: "tc-other",
      toolName: "load_skill",
      input: {},
      procedure: PROCEDURE,
      store,
    });
    assert.equal(result, undefined);
    assert.equal(store.has("tc-other"), false);
  });
});

describe("execution adapter：execute 与 receipt 消费", () => {
  beforeEach(() => {
    store = createReceiptStore();
  });

  it("无 receipt 直接 execute ⇒ executor auth denied（绝不无条件 approved）", async () => {
    const result = await executePaginationDetect({
      toolCallId: "tc-noreceipt",
      params: baseParams(),
      store,
      procedure: PROCEDURE,
    });
    assert.equal(result.details.outcome, "denied");
    assert.equal(result.details.failure, "authorization_missing_or_replayed");
    assert.deepEqual(result.details.authorization_results, [
      { gate_id: "pilot_receipt", result: "denied" },
    ]);
    assert.equal(store.has("tc-noreceipt"), false);
  });

  it("消费 receipt ⇒ fast path（uses_offset）；finally 清 receipt", async () => {
    preflight("tc-fast", baseParams());
    const result = await executePaginationDetect({
      toolCallId: "tc-fast",
      params: baseParams(),
      store,
      procedure: PROCEDURE,
    });
    assert.equal(result.details.outcome, "fast_path");
    assert.equal(result.details.finding_class, "uses_offset");
    assert.deepEqual(result.details.authorization_results, [
      { gate_id: "pilot_receipt", result: "approved" },
    ]);
    assert.equal(result.details.verifier_results[0]!.verifier_id, PAGINATION_VERIFIER_ID);
    assert.equal(result.details.verifier_results[0]!.result, "pass");
    assert.equal(store.has("tc-fast"), false, "finally 必须清 receipt");
  });

  it("重放：同一 toolCallId 第二次 execute ⇒ denied（receipt 已消费）", async () => {
    preflight("tc-replay", baseParams());
    await executePaginationDetect({ toolCallId: "tc-replay", params: baseParams(), store, procedure: PROCEDURE });
    const replay = await executePaginationDetect({ toolCallId: "tc-replay", params: baseParams(), store, procedure: PROCEDURE });
    assert.equal(replay.details.outcome, "denied");
    assert.equal(replay.details.failure, "authorization_missing_or_replayed");
  });

  it("伪造 receipt（skillId/revision 任一不符）⇒ executor auth denied", async () => {
    store.put("tc-forged-a", { skillId: SKILL_ID, skillRevision: `rev:${'f'.repeat(64)}` });
    const forgedA = await executePaginationDetect({
      toolCallId: "tc-forged-a",
      params: baseParams(),
      store,
      procedure: PROCEDURE,
    });
    assert.equal(forgedA.details.outcome, "denied", "revision 伪造必须 denied");

    store.put("tc-forged-b", { skillId: `skill:${'f'.repeat(64)}`, skillRevision: SKILL_REVISION });
    const forgedB = await executePaginationDetect({
      toolCallId: "tc-forged-b",
      params: baseParams(),
      store,
      procedure: PROCEDURE,
    });
    assert.equal(forgedB.details.outcome, "denied", "skillId 伪造必须 denied");

    // procedureId/claims 核对为纵深防御：request 由 executor 按 procedure 精确复制，
    // 正常流程恒一致；此处断言正常 receipt 通过时 claims 与声明精确一致。
    preflight("tc-genuine", baseParams());
    const genuine = await executePaginationDetect({
      toolCallId: "tc-genuine",
      params: baseParams(),
      store,
      procedure: PROCEDURE,
    });
    assert.equal(genuine.details.outcome, "fast_path");
  });
});

describe("execution adapter：执行语义", () => {
  beforeEach(() => {
    store = createReceiptStore();
  });

  it("abstain：procedure_abstained 回退，仅指示 load_skill，不冒充已加载", async () => {
    preflight("tc-abstain", baseParams({ sql: ABSTAIN_SQL }));
    const result = await executePaginationDetect({
      toolCallId: "tc-abstain",
      params: baseParams({ sql: ABSTAIN_SQL }),
      store,
      procedure: PROCEDURE,
    });
    assert.equal(result.details.outcome, "abstain");
    assert.equal(result.details.finding_class, "abstain");
    assert.equal(result.details.fallback?.mode, "load_parent_skill");
    assert.equal(result.details.fallback?.load_skill_indicated, true);
    // 不冒充已加载：details 不含任何 loaded=true 语义。
    assert.ok(!JSON.stringify(result.details).includes('"loaded"'));
    assert.deepEqual(result.details.verifier_results, [], "abstain 跳过 verifier");
    // artifact 已执行（guard 通过、disposition=abstained）：固定 detect step 如实记录，不写空。
    assert.equal(result.details.step_summaries.length, 1, "abstain 案例须记录已执行的 detect step");
    assert.deepEqual(result.details.step_summaries[0], {
      step_id: "detect-offset-pagination",
      actor: "procedure",
      operation_class: "detect-offset-pagination",
      outcome: "ok",
    });
  });

  it("非法输入（空 sql）⇒ guard fail ⇒ fallback(guard_failure)，无 find 结果", async () => {
    preflight("tc-guard", baseParams({ sql: "" }));
    const result = await executePaginationDetect({
      toolCallId: "tc-guard",
      params: baseParams({ sql: "" }),
      store,
      procedure: PROCEDURE,
    });
    assert.equal(result.details.outcome, "fallback");
    assert.equal(result.details.failure, "guard_failure");
    assert.equal(result.details.step_summaries.length, 0, "guard 失败不执行 artifact");
    assert.equal(result.details.verifier_results.length, 0);
  });

  it("超长 sql（> 16_384）⇒ guard fail（bounded-supported-sql）", async () => {
    const long = `SELECT * FROM t ORDER BY id OFFSET ${"0".repeat(20_000)};`;
    preflight("tc-long", baseParams({ sql: long }));
    const result = await executePaginationDetect({
      toolCallId: "tc-long",
      params: baseParams({ sql: long }),
      store,
      procedure: PROCEDURE,
    });
    assert.equal(result.details.outcome, "fallback");
    assert.equal(result.details.failure, "guard_failure");
  });
});

describe("execution adapter：注入 current 值 ⇒ revision/dependency 校验真实生效（cc HIGH 1）", () => {
  beforeEach(() => {
    store = createReceiptStore();
  });

  it("注入 currentSkillRevision ≠ procedure revision ⇒ revision_mismatch ⇒ slow_path/load_parent_skill（不得 fast_path）", async () => {
    preflight("tc-rev-drift", baseParams());
    const result = await executePaginationDetect({
      toolCallId: "tc-rev-drift",
      params: baseParams(),
      store,
      procedure: PROCEDURE,
      currentSkillRevision: "rev:" + "f".repeat(64),
    });
    assert.equal(result.details.outcome, "slow_path");
    assert.equal(result.details.decision.mode, "skill_md");
    assert.equal(result.details.decision.reason, "revision_mismatch");
    assert.equal(result.details.fallback?.mode, "load_parent_skill");
    assert.equal(result.details.fallback?.load_skill_indicated, true);
    // 未走快路径：不调授权 gate、不评估 guard、不执行 artifact（无 step）。
    assert.deepEqual(result.details.authorization_results, []);
    assert.deepEqual(result.details.guard_results, []);
    assert.deepEqual(result.details.step_summaries, []);
    assert.equal(store.has("tc-rev-drift"), false, "finally 必须清 receipt");
  });

  it("注入 currentDependencyFingerprint ≠ procedure fingerprint ⇒ dependency_mismatch ⇒ slow_path/load_parent_skill（不得 fast_path）", async () => {
    preflight("tc-dep-drift", baseParams());
    const result = await executePaginationDetect({
      toolCallId: "tc-dep-drift",
      params: baseParams(),
      store,
      procedure: PROCEDURE,
      currentDependencyFingerprint: { sourceHash: "0".repeat(64) },
    });
    assert.equal(result.details.outcome, "slow_path");
    assert.equal(result.details.decision.mode, "skill_md");
    assert.equal(result.details.decision.reason, "dependency_mismatch");
    assert.equal(result.details.fallback?.mode, "load_parent_skill");
    assert.equal(result.details.fallback?.load_skill_indicated, true);
    assert.deepEqual(result.details.authorization_results, []);
    assert.equal(store.has("tc-dep-drift"), false);
  });

  it("未注入时回退 procedure 自身值（self-match）：revision/dependency 恒通过 ⇒ fast_path 保持", async () => {
    preflight("tc-selfmatch", baseParams());
    const result = await executePaginationDetect({
      toolCallId: "tc-selfmatch",
      params: baseParams(),
      store,
      procedure: PROCEDURE,
    });
    assert.equal(result.details.outcome, "fast_path");
    assert.equal(result.details.decision.reason, "eligible_procedure");
  });

  it("注入 guardObservations（source-and-dependency-match=false）⇒ guard_failure ⇒ fallback，不执行 artifact", async () => {
    preflight("tc-guard-drift", baseParams());
    const result = await executePaginationDetect({
      toolCallId: "tc-guard-drift",
      params: baseParams(),
      store,
      procedure: PROCEDURE,
      guardObservations: [
        { predicateId: "bounded-supported-sql", phase: "runtime", result: true },
        { predicateId: "source-and-dependency-match", phase: "runtime", result: false },
      ],
    });
    assert.equal(result.details.outcome, "fallback");
    assert.equal(result.details.failure, "guard_failure");
    assert.equal(result.details.fallback?.mode, "load_parent_skill");
    assert.equal(result.details.step_summaries.length, 0, "guard 失败不执行 artifact");
    assert.deepEqual(
      result.details.guard_results.find((g) => g.predicate_id === "source-and-dependency-match"),
      { predicate_id: "source-and-dependency-match", phase: "runtime", result: "fail" },
    );
  });

  it("注册层注入点：registerSkillCortexPaginationShadow(options) 透传 current 值至工具执行", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const tools: Array<{ name: string; execute?: (tc: string, params: unknown) => Promise<{ details: PilotToolDetails }> }> = [];
    const fakePi = {
      on: (event: string, handler: (event: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      registerTool: (tool: { name: string; execute?: (tc: string, params: unknown) => Promise<{ details: PilotToolDetails }> }) => {
        tools.push(tool);
      },
    };
    registerSkillCortexPaginationShadow(fakePi as never, {
      currentSkillRevision: "rev:" + "f".repeat(64),
      currentDependencyFingerprint: { sourceHash: "0".repeat(64) },
      guardObservations: [
        { predicateId: "bounded-supported-sql", phase: "runtime", result: true },
        { predicateId: "source-and-dependency-match", phase: "runtime", result: true },
      ],
    });

    const handler = handlers.get("tool_call")!;
    const pass = await handler({
      type: "tool_call",
      toolCallId: "tc-reg-drift",
      toolName: PILOT_TOOL_NAME,
      input: baseParams(),
    });
    assert.equal(pass, undefined, "preflight 身份匹配放行（注入值只在 executor 层生效）");

    const tool = tools.find((t) => t.name === PILOT_TOOL_NAME)!;
    const result = await tool.execute!("tc-reg-drift", baseParams());
    assert.equal(result.details.outcome, "slow_path");
    assert.equal(result.details.decision.reason, "revision_mismatch");
    assert.equal(result.details.decision.mode, "skill_md");
  });
});

describe("execution adapter：有界输出与严格解码", () => {
  beforeEach(() => {
    store = createReceiptStore();
  });

  it("details 严格有界：无原始 SQL/路径/error 原文", async () => {
    preflight("tc-bound", baseParams({ sql: MARKED_SQL }));
    const result = await executePaginationDetect({
      toolCallId: "tc-bound",
      params: baseParams({ sql: MARKED_SQL }),
      store,
      procedure: PROCEDURE,
    });
    assert.equal(result.details.outcome, "fast_path");
    const serialized = JSON.stringify(result.details);
    assert.ok(!serialized.includes(SECRET_MARKER), "不得泄漏原始 SQL");
    assert.ok(!/^[a-zA-Z]:[\\/]/.test(serialized), "不得含 Windows 绝对路径");
    assert.ok(!serialized.includes("node_modules"), "不得含路径片段");
    assert.ok(!serialized.includes("Error:"), "不得泄漏 error message 原文");

    // content（模型可见）同样受控。
    const contentText = JSON.stringify(result.content);
    assert.ok(!contentText.includes(SECRET_MARKER));
  });

  it("decodeExecutionToolDetails：合法 details ⇒ ok 且字段齐全（observer 可解码）", async () => {
    preflight("tc-decode", baseParams());
    const result = await executePaginationDetect({
      toolCallId: "tc-decode",
      params: baseParams(),
      store,
      procedure: PROCEDURE,
    });
    const decoded = decodeExecutionToolDetails(result.details);
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      const details: PilotToolDetails = decoded.details;
      assert.equal(details.schema_version, 1);
      assert.equal(details.skill_id, SKILL_ID);
      assert.equal(details.skill_revision, SKILL_REVISION);
      assert.equal(details.source_hash, SOURCE_HASH);
      assert.ok(details.procedure_id.startsWith("procedure:"));
      assert.equal(details.dependency_fingerprint.source_hash, SOURCE_HASH);
      assert.ok(details.guard_results.length > 0);
      assert.ok(details.step_summaries.length > 0);
      assert.equal(details.decision.execution_context, "shadow_replay");
    }
  });

  it("decodeExecutionToolDetails：extra key / 敏感 key / 类型错 ⇒ fail-closed", () => {
    preflight("tc-strict", baseParams());
    const base = executePaginationDetect({
      toolCallId: "tc-strict",
      params: baseParams(),
      store,
      procedure: PROCEDURE,
    });

    return base.then((result) => {
      const details = result.details as unknown as Record<string, unknown>;
      const extra = decodeExecutionToolDetails({ ...details, extra_field: 1 });
      assert.equal(extra.ok, false);
      if (!extra.ok) assert.ok(extra.reasons.some((r) => r.includes("keys_mismatch")));

      const sensitive = decodeExecutionToolDetails({ ...details, sql: "SELECT 1" });
      assert.equal(sensitive.ok, false);
      if (!sensitive.ok) assert.ok(sensitive.reasons.some((r) => r.includes("sensitive_key")));

      const wrongType = decodeExecutionToolDetails({ ...details, schema_version: "1" });
      assert.equal(wrongType.ok, false);
      if (!wrongType.ok) assert.ok(wrongType.reasons.some((r) => r.includes("schema_version")));

      const notObject = decodeExecutionToolDetails("nope");
      assert.equal(notObject.ok, false);
    });
  });
});

describe("execution adapter：注册冒烟（fake pi）", () => {
  it("注册工具 + tool_call handler；preflight 经 handler 生效", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const tools: Array<{ name: string }> = [];
    const fakePi = {
      on: (event: string, handler: (event: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      registerTool: (tool: { name: string }) => {
        tools.push(tool);
      },
    };
    registerSkillCortexPaginationShadow(fakePi as never);

    assert.equal(tools.some((t) => t.name === PILOT_TOOL_NAME), true, "必须注册本工具");
    assert.equal(handlers.has("tool_call"), true);

    const handler = handlers.get("tool_call")!;
    const store2 = createReceiptStore();
    // 直接经 handler 验证身份失配 block（注册层闭包 store 不可见；验证 block 语义经 handler 生效）。
    const blocked = await handler({
      type: "tool_call",
      toolCallId: "tc-h1",
      toolName: PILOT_TOOL_NAME,
      input: baseParams({ skill_id: `skill:${"f".repeat(64)}` }),
    });
    assert.deepEqual(blocked, {
      block: true,
      reason: BLOCK_REASON_SKILL_IDENTITY_MISMATCH,
      terminate: true,
    });

    const pass = await handler({
      type: "tool_call",
      toolCallId: "tc-h2",
      toolName: PILOT_TOOL_NAME,
      input: baseParams(),
    });
    assert.equal(pass, undefined);
    void store2;
  });
});
