import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSkillCortex } from "../../../src/adapters/pi/index.ts";
import {
  createDiscoverySnapshotSource,
  registerPracticeObserver,
} from "../../../src/adapters/pi/practice-observer.ts";
import { PracticeStore } from "../../../src/practice/store/index.ts";

/**
 * Skill Cortex — Pi 扩展入口（project-local，经 jiti 免编译加载）。
 *
 * 接线顺序（固定，不可颠倒）：
 * 1. `createDiscoverySnapshotSource()`：当次有界候选快照 seam（RouteSnapshotSource）；
 * 2. `registerSkillCortex({ mode: "inject", onDiscovery: (r) => source.push(r) })`：
 *    移除 Pi 原生全量 Skill metadata，注入有界 Top-K；仅在最终 prompt 确定
 *    （exposedToAgent=true）后 push 快照；rewrite/ingest 失败不 push（fail open）；
 * 3. `registerPracticeObserver({ store, projectRoot, routeSnapshotSource: source })`：
 *    在 before_agent_start take 当次快照，经 tool_call/tool_result 观察 load_skill
 *    （details.source_hash 必须严格 sha256），agent_settled 时校验 skillId∈候选 +
 *    revision 精确匹配后，逐条经 policy gate append 到 project-local PracticeStore。
 *
 * 安全边界：
 * - projectRoot = process.cwd()；PracticeStore.rootDir 被 Store 构造强制位于 projectRoot 内
 *   （本入口为 <cwd>/.skill-cortex/practice）；
 * - 不写用户级环境（不写 ~/.pi）、不 appendEntry、不调用 LLM、不启动 Phase 4；
 * - 不配置会回显原始 error/绝对路径的 onError：诊断只走稳定的脱敏类别与 onStatus，
 *   观察/落盘失败 fail open，不阻断主 Agent；
 * - PracticeEvent 只含派生 hash 与受控文本，原始 prompt/路径/正文永不落盘。
 */
export default function skillCortexEntry(pi: ExtensionAPI): void {
  const projectRoot = process.cwd();
  const source = createDiscoverySnapshotSource();

  registerSkillCortex(pi, {
    mode: "inject",
    onDiscovery: (result) => source.push(result),
  });

  registerPracticeObserver(pi, {
    store: new PracticeStore({
      rootDir: path.join(projectRoot, ".skill-cortex", "practice"),
      projectRoot,
    }),
    projectRoot,
    routeSnapshotSource: source,
  });
}
