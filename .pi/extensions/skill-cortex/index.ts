import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSkillCortex } from "../../../src/adapters/pi/index.ts";

/**
 * Skill Cortex — Pi 扩展入口（project-local，经 jiti 免编译加载）。
 *
 * 仅以默认 shadow 模式注册：
 * - 不修改 systemPrompt、不注入候选卡；
 * - 不写用户级环境（不写 ~/.pi）、不 appendEntry、不创建 PracticeEvent、不调用 LLM；
 * - 摄入/检索失败 fail open，不阻断主 Agent。
 */
export default function skillCortexEntry(pi: ExtensionAPI): void {
  registerSkillCortex(pi);
}
