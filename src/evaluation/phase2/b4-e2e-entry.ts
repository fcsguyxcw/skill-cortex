/**
 * B4 E2E harness 入口（仅验收用，非生产入口；通过 `pi -e` 显式加载）。
 *
 * 与生产入口（.pi/extensions/skill-cortex/index.ts）的区别仅在于额外注入
 * `evidenceHook: createPaginationEvidenceHook()`——真实宿主会话中主 Agent 选中 Skill、
 * 调用 load_skill 后，observer 在 agent_settled 时对该会话 prompt 中出现的 SQL 做
 * 确定性 pagination 检测与结构化验证，产生带 verifier 的真实 PracticeEvent。
 *
 * 命令（项目根）：
 *   pi --no-session -ne -e ./src/evaluation/phase2/b4-e2e-entry.ts --print "<只读任务>"
 *
 * 不写用户环境、不写工作区外路径；store 落在 <cwd>/.skill-cortex/practice（project-local）。
 */
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSkillCortex } from "../../adapters/pi/index.ts";
import {
  createDiscoverySnapshotSource,
  registerPracticeObserver,
} from "../../adapters/pi/practice-observer.ts";
import { createPaginationEvidenceHook } from "../../adapters/pi/practice-pagination-hook.ts";
import { PracticeStore } from "../../practice/store/index.ts";

export default function b4E2EEntry(pi: ExtensionAPI): void {
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
    evidenceHook: createPaginationEvidenceHook(),
  });
}
