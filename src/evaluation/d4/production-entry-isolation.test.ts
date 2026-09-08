import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createEventBus,
} from "@earendil-works/pi-coding-agent";
import {
  loadExtensions,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const ENTRY = path.join(PROJECT_ROOT, ".pi", "extensions", "skill-cortex", "index.ts");
const EXPECTED_TOOLS = [
  "load_skill",
  "search_skills",
  "skill_memory_forget",
  "skill_memory_list",
  "skill_memory_set_learning",
  "skill_memory_status",
] as const;
const EXPECTED_HANDLERS = [
  ["agent_end", 1],
  ["agent_settled", 2],
  ["before_agent_start", 3],
  ["tool_call", 1],
  ["tool_result", 1],
] as const;

const STATIC_SPECIFIER = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu;

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRelativeImport(fromFile: string, specifier: string): Promise<string> {
  const unresolved = path.resolve(path.dirname(fromFile), specifier);
  const candidates = path.extname(unresolved) === ""
    ? [`${unresolved}.ts`, path.join(unresolved, "index.ts")]
    : [unresolved, unresolved.endsWith(".js") ? `${unresolved.slice(0, -3)}.ts` : unresolved];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`unresolved_static_import:${path.relative(PROJECT_ROOT, fromFile)}:${specifier}`);
}

async function reachableProjectModules(entry: string): Promise<Set<string>> {
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const filePath = pending.pop()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    const source = await readFile(filePath, "utf8");
    for (const match of source.matchAll(STATIC_SPECIFIER)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const resolved = await resolveRelativeImport(filePath, specifier);
      if (resolved.startsWith(`${PROJECT_ROOT}${path.sep}`)) pending.push(resolved);
    }
  }
  return visited;
}

describe("D4/G7 production entry frozen-path isolation", () => {
  it("真实入口的静态 import graph 不触达 frozen procedure/runtime 路径", async () => {
    const reachable = await reachableProjectModules(ENTRY);
    const relative = [...reachable].map((filePath) =>
      path.relative(PROJECT_ROOT, filePath).replaceAll(path.sep, "/"),
    );
    const forbidden = relative.filter((filePath) =>
      filePath.startsWith("src/procedures/")
      || filePath.startsWith("src/runtime/")
      || filePath === "src/adapters/pi/execution-adapter.ts",
    );

    assert.deepEqual(forbidden, []);
    assert.ok(relative.includes(".pi/extensions/skill-cortex/index.ts"));
  });

  it("真实 Pi loader 注册面保持 bounded discovery + controls + bounded contribution observer，且 compiled observer 未接线", async () => {
    const { extensions, errors } = await loadExtensions([ENTRY], PROJECT_ROOT, createEventBus());
    assert.deepEqual(errors, []);
    assert.equal(extensions.length, 1);

    const extension = extensions[0]!;
    assert.deepEqual([...extension.tools.keys()].sort(), [...EXPECTED_TOOLS]);
    assert.deepEqual(
      [...extension.handlers.entries()].map(([event, handlers]) => [event, handlers.length]).sort(),
      EXPECTED_HANDLERS,
    );

    const entrySource = await readFile(ENTRY, "utf8");
    assert.equal(entrySource.includes("topK: 5,"), true,
      "生产入口必须显式固定已选择的 K=5 候选预算");
    assert.equal(entrySource.includes("compiledTool:"), false);
    assert.equal(entrySource.includes("overlayProfiles:"), false,
      "ADR-0014 范围内生产入口不得读取 active profiles 改变 discovery");
    assert.equal(entrySource.includes("overlayOptions:"), false,
      "production active overlay 未获授权前不得配置 rerank 参数");
    assert.equal(entrySource.includes("registerContributionAssessmentObserver"), true,
      "有界 gate-status production verifier 必须接入 contribution observer");
  });
});
