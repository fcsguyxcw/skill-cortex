import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

describe("G7 project-local deployment settings", () => {
  it("真实 Pi resource loader 从 .pi/settings.json 加载唯一 gate-status Skill", async (t) => {
    const agentDir = await mkdtemp(path.join(PROJECT_ROOT, ".tmp-g7-agent-"));
    t.after(() => rm(agentDir, { recursive: true, force: true }));

    const settingsManager = SettingsManager.create(PROJECT_ROOT, agentDir, {
      projectTrusted: true,
    });
    const loader = new DefaultResourceLoader({
      cwd: PROJECT_ROOT,
      agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const matches = loader.getSkills().skills.filter(
      (skill) => skill.name === "skill-cortex-gate-status",
    );
    assert.equal(matches.length, 1);
    assert.equal(
      path.resolve(matches[0]!.filePath),
      path.join(PROJECT_ROOT, "skills", "skill-cortex-gate-status", "SKILL.md"),
    );
  });
});
