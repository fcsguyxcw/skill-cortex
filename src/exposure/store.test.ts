import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExposureObservationRecord } from "../core/contracts/index.ts";
import { ExposureObservationStore } from "./store.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
let temp = "";
before(() => { temp = mkdtempSync(path.join(ROOT, ".tmp-exposure-store-")); });
after(async () => rm(temp, { recursive: true, force: true }));
const record: ExposureObservationRecord = { schemaVersion: 1, routeDecisionId: "route:one",
  tenantScope: "project:a", observedAt: "2026-08-23T00:00:00.000Z", baselineWouldInject: true,
  candidateCount: 2, topScore: 3, secondScore: 1, topMatchFields: ["name"],
  exactDeclaredReference: true, selectedSkillIds: [] };

describe("ExposureObservationStore", () => {
  it("append-only、跨实例读取、tenant 隔离", async () => {
    const rootDir = path.join(temp, "store");
    await new ExposureObservationStore({ rootDir, projectRoot: temp }).append(record);
    const reopened = new ExposureObservationStore({ rootDir, projectRoot: temp });
    assert.deepEqual(await reopened.list("project:a"), [record]);
    assert.deepEqual(await reopened.list("project:b"), []);
    await assert.rejects(reopened.append(record), /exposure_route_already_observed/);
  });
  it("拒绝 project root 逃逸", () => {
    assert.throws(() => new ExposureObservationStore({ rootDir: path.dirname(temp), projectRoot: temp }),
      /exposure_store_root_must_be_inside_project_root/);
  });
  it("损坏的 comparator 形状 fail closed", async () => {
    const store = new ExposureObservationStore({ rootDir: path.join(temp, "invalid"), projectRoot: temp });
    await assert.rejects(store.append({ ...record, routeDecisionId: "route:bad",
      candidateBudget: { variants: [] } } as ExposureObservationRecord), /exposure_store_corrupt/);
  });
});
