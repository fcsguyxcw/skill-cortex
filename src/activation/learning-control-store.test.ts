import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { LearningControlStore } from "./learning-control-store.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
let tempRoot = "";

before(() => {
  tempRoot = mkdtempSync(path.join(PROJECT_ROOT, ".tmp-learning-control-"));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function store(tenantScope = "project:a", now = "2026-08-23T01:00:00.000Z"): LearningControlStore {
  return new LearningControlStore({
    rootDir: path.join(tempRoot, "control"),
    projectRoot: tempRoot,
    tenantScope,
    now: () => new Date(now),
  });
}

describe("LearningControlStore", () => {
  it("默认 enabled；pause/resume 跨实例持久化", async () => {
    assert.equal((await store().status()).learningEnabled, true);
    await store().setLearning(false);
    assert.deepEqual(await store().status(), {
      schemaVersion: 1,
      learningEnabled: false,
      updatedAt: "2026-08-23T01:00:00.000Z",
    });
    await store("project:a", "2026-08-23T02:00:00.000Z").setLearning(true);
    assert.equal((await store().status()).learningEnabled, true);
  });

  it("tenant 状态隔离", async () => {
    await store("project:a").setLearning(false);
    assert.equal((await store("project:a").status()).learningEnabled, false);
    assert.equal((await store("project:b").status()).learningEnabled, true);
  });

  it("rootDir 逃逸拒绝", () => {
    assert.throws(
      () => new LearningControlStore({
        rootDir: path.resolve(tempRoot, "..", "outside-control"),
        projectRoot: tempRoot,
        tenantScope: "project:a",
      }),
      /learning_control_root_must_be_inside_project_root/,
    );
  });
});
