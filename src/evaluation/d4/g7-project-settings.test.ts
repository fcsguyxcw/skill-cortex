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
  it("真实 Pi resource loader 从 .pi/settings.json 各加载唯一的有界 production Skill", async (t) => {
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

    for (const name of ["skill-cortex-gate-status", "markdown-relative-link-audit"]) {
      const matches = loader.getSkills().skills.filter((skill) => skill.name === name);
      assert.equal(matches.length, 1);
      assert.equal(
        path.resolve(matches[0]!.filePath),
        path.join(PROJECT_ROOT, "skills", name, "SKILL.md"),
      );
    }
  });
});
