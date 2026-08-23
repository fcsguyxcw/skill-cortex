/**
 * D1 Learning assessment append-only store（project-local）。
 *
 * - assessment 与 PracticeEvent 分开持久化；
 * - tenantScope 只用于 hash 目录，不进入路径；
 * - assessmentId 与 eventId 在 tenant 内均不可覆盖；
 * - append 只绑定已存在于 Practice Store 的 real skill_md event；
 * - 读取损坏时 fail closed，不回显内容或绝对路径。
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LearningEvidenceAssessment, PracticeEvent } from "../core/contracts/index.ts";
import { validatePracticeEvent } from "../practice/policy/index.ts";
import { isLearningEvidenceAssessment } from "./admission.ts";

export interface LearningAssessmentEventSource {
  getEvent(tenantScope: string, eventId: string): Promise<PracticeEvent | undefined>;
}

export interface LearningAssessmentReader {
  getAssessment(
    tenantScope: string,
    eventId: string,
  ): Promise<LearningEvidenceAssessment | undefined>;
}

export interface LearningAssessmentStoreOptions {
  rootDir: string;
  projectRoot?: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function tenantDir(rootDir: string, tenantScope: string): string {
  return path.join(rootDir, hash(tenantScope));
}

function recordPath(rootDir: string, tenantScope: string, eventId: string): string {
  return path.join(tenantDir(rootDir, tenantScope), "records", `${hash(eventId)}.json`);
}

function claimPath(rootDir: string, tenantScope: string, assessmentId: string): string {
  return path.join(tenantDir(rootDir, tenantScope), "claims", `${hash(assessmentId)}.json`);
}

function tombstonePath(rootDir: string, tenantScope: string, eventId: string): string {
  return path.join(tenantDir(rootDir, tenantScope), "tombstones", `${hash(eventId)}.json`);
}

async function exists(filePath: string): Promise<boolean> {
  return lstat(filePath).then((stat) => stat.isFile()).catch((error: unknown) => {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  });
}

function toStoredAssessment(assessment: LearningEvidenceAssessment): LearningEvidenceAssessment {
  return {
    schemaVersion: 1,
    assessmentId: assessment.assessmentId,
    eventId: assessment.eventId,
    tenantScope: assessment.tenantScope,
    parentSkillId: assessment.parentSkillId,
    parentSkillRevision: assessment.parentSkillRevision,
    sourceHash: assessment.sourceHash,
    taskOutcome: assessment.taskOutcome,
    skillContribution: assessment.skillContribution,
    evidenceKind: assessment.evidenceKind,
    verifier: {
      kind: assessment.verifier.kind,
      result: assessment.verifier.result,
    },
    assessedAt: assessment.assessedAt,
  };
}

function corrupt(code: string): never {
  throw new Error(`learning_assessment_store_corrupt: ${code}`);
}

function parseStoredAssessment(
  raw: string,
  tenantScope: string,
  expectedEventHash: string,
): LearningEvidenceAssessment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    corrupt("json_parse");
  }
  if (!isLearningEvidenceAssessment(parsed)) corrupt("assessment_invalid");
  if (parsed.tenantScope !== tenantScope) corrupt("tenant_scope_mismatch");
  if (hash(parsed.eventId) !== expectedEventHash) corrupt("event_id_mismatch");
  return toStoredAssessment(parsed);
}

function assertEventBinding(event: PracticeEvent, assessment: LearningEvidenceAssessment): void {
  const policy = validatePracticeEvent(event);
  if (!policy.ok) throw new Error("learning_assessment_event_policy_invalid");
  if (event.provenance !== "real") throw new Error("learning_assessment_event_not_real");
  if (event.executionMode !== "skill_md") throw new Error("learning_assessment_frozen_procedure_event");
  if (
    event.eventId !== assessment.eventId ||
    event.tenantScope !== assessment.tenantScope ||
    event.parentSkillId !== assessment.parentSkillId ||
    event.parentSkillRevision !== assessment.parentSkillRevision ||
    event.sourceHash !== assessment.sourceHash
  ) {
    throw new Error("learning_assessment_event_binding_mismatch");
  }
}

export class LearningAssessmentStore {
  readonly rootDir: string;
  readonly projectRoot: string;
  #initPromise?: Promise<void>;

  constructor(options: LearningAssessmentStoreOptions) {
    this.projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    this.rootDir = path.resolve(options.rootDir);
    if (!isPathInside(this.projectRoot, this.rootDir)) {
      throw new Error("learning_assessment_store_root_must_be_inside_project_root");
    }
  }

  #ensureInit(): Promise<void> {
    this.#initPromise ??= this.#init();
    return this.#initPromise;
  }

  async #init(): Promise<void> {
    const realProject = await realpath(this.projectRoot);
    let probe = this.rootDir;
    let existingReal: string | undefined;
    while (existingReal === undefined) {
      try {
        await lstat(probe);
        existingReal = await realpath(probe);
      } catch (error) {
        if (!isErrnoCode(error, "ENOENT")) throw error;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    if (existingReal !== undefined && !isPathInside(realProject, existingReal)) {
      throw new Error("learning_assessment_store_root_must_be_inside_project_root");
    }
    await mkdir(this.rootDir, { recursive: true });
    const realRoot = await realpath(this.rootDir);
    if (!isPathInside(realProject, realRoot)) {
      throw new Error("learning_assessment_store_root_must_be_inside_project_root");
    }
  }

  async append(
    assessment: LearningEvidenceAssessment,
    eventSource: LearningAssessmentEventSource,
  ): Promise<void> {
    if (!isLearningEvidenceAssessment(assessment)) {
      throw new Error("learning_assessment_rejected: assessment_invalid");
    }
    const event = await eventSource.getEvent(assessment.tenantScope, assessment.eventId);
    if (event === undefined) throw new Error("learning_assessment_event_missing");
    assertEventBinding(event, assessment);
    const persisted = toStoredAssessment(assessment);
    await this.#ensureInit();

    const claim = claimPath(this.rootDir, persisted.tenantScope, persisted.assessmentId);
    await mkdir(path.dirname(claim), { recursive: true });
    try {
      await writeFile(
        claim,
        JSON.stringify({ assessmentId: persisted.assessmentId, eventId: persisted.eventId }),
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      if (isErrnoCode(error, "EEXIST")) throw new Error("learning_assessment_id_already_exists");
      throw error;
    }

    const record = recordPath(this.rootDir, persisted.tenantScope, persisted.eventId);
    await mkdir(path.dirname(record), { recursive: true });
    try {
      await writeFile(record, JSON.stringify(persisted), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      try {
        await rm(claim, { force: true });
      } catch {
        throw new Error("learning_assessment_claim_rollback_failed");
      }
      if (isErrnoCode(error, "EEXIST")) throw new Error("learning_assessment_event_already_assessed");
      throw error;
    }
  }

  async getAssessment(
    tenantScope: string,
    eventId: string,
  ): Promise<LearningEvidenceAssessment | undefined> {
    await this.#ensureInit();
    if (await exists(tombstonePath(this.rootDir, tenantScope, eventId))) return undefined;
    const filePath = recordPath(this.rootDir, tenantScope, eventId);
    const raw = await readFile(filePath, "utf8").catch((error: unknown) => {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (raw === undefined) return undefined;
    return parseStoredAssessment(raw, tenantScope, hash(eventId));
  }

  async list(tenantScope: string): Promise<LearningEvidenceAssessment[]> {
    await this.#ensureInit();
    const dir = path.join(tenantDir(this.rootDir, tenantScope), "records");
    const names = await readdir(dir).catch((error: unknown) => {
      if (isErrnoCode(error, "ENOENT")) return [] as string[];
      throw error;
    });
    const assessments: LearningEvidenceAssessment[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      if (await exists(path.join(tenantDir(this.rootDir, tenantScope), "tombstones", name))) continue;
      const filePath = path.join(dir, name);
      const stat = await lstat(filePath);
      if (!stat.isFile()) continue;
      const raw = await readFile(filePath, "utf8");
      assessments.push(parseStoredAssessment(raw, tenantScope, name.slice(0, -5)));
    }
    return assessments.sort((a, b) => a.eventId.localeCompare(b.eventId));
  }

  async invalidate(tenantScope: string, evidenceIds: readonly string[]): Promise<{ invalidatedEventIds: string[] }> {
    await this.#ensureInit();
    const invalidatedEventIds: string[] = [];
    for (const evidenceId of [...new Set(evidenceIds)]) {
      let eventId = evidenceId;
      let resolvedByAssessmentClaim = false;
      if (!(await exists(recordPath(this.rootDir, tenantScope, eventId))) &&
          !(await exists(tombstonePath(this.rootDir, tenantScope, eventId)))) {
        const rawClaim = await readFile(claimPath(this.rootDir, tenantScope, evidenceId), "utf8").catch(
          (error: unknown) => {
            if (isErrnoCode(error, "ENOENT")) return undefined;
            throw error;
          },
        );
        if (rawClaim === undefined) continue;
        let claim: unknown;
        try {
          claim = JSON.parse(rawClaim);
        } catch {
          throw new Error("learning_assessment_corrupt: claim_json_parse");
        }
        if (
          typeof claim !== "object" || claim === null ||
          (claim as { assessmentId?: unknown }).assessmentId !== evidenceId ||
          typeof (claim as { eventId?: unknown }).eventId !== "string"
        ) {
          throw new Error("learning_assessment_corrupt: invalid_claim");
        }
        eventId = (claim as { eventId: string }).eventId;
        resolvedByAssessmentClaim = true;
      }
      const record = recordPath(this.rootDir, tenantScope, eventId);
      const tombstone = tombstonePath(this.rootDir, tenantScope, eventId);
      const alreadyDeleted = await exists(tombstone);
      if (!alreadyDeleted && !(await exists(record))) continue;
      if (resolvedByAssessmentClaim) {
        if (alreadyDeleted) continue;
        const rawRecord = await readFile(record, "utf8");
        const stored = parseStoredAssessment(rawRecord, tenantScope, hash(eventId));
        if (stored.assessmentId !== evidenceId) continue;
      }
      if (!alreadyDeleted) {
        await mkdir(path.dirname(tombstone), { recursive: true });
        await writeFile(
          tombstone,
          JSON.stringify({ eventId, invalidatedAt: new Date().toISOString(), reason: "explicit_delete" }),
          { encoding: "utf8", flag: "wx" },
        );
      }
      await rm(record, { force: true });
      invalidatedEventIds.push(evidenceId);
    }
    return { invalidatedEventIds };
  }
}
