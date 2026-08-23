import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExposureMatchField, ExposureObservationRecord } from "../core/contracts/index.ts";

const FIELDS: readonly ExposureMatchField[] = ["name", "description", "alias", "learned_cue"];

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function errno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}
function assertRecord(value: unknown): asserts value is ExposureObservationRecord {
  if (typeof value !== "object" || value === null) throw new Error("exposure_store_corrupt: not_object");
  const v = value as Record<string, unknown>;
  const scoresValid = [v.topScore, v.secondScore].every((score) => score === undefined ||
    (typeof score === "number" && Number.isFinite(score)));
  const budgetVariants = typeof v.candidateBudget === "object" && v.candidateBudget !== null
    ? (v.candidateBudget as { variants?: unknown }).variants : undefined;
  const budgetValid = v.candidateBudget === undefined || (Array.isArray(budgetVariants) &&
    budgetVariants.length === 4 && budgetVariants.every((variant, index) => {
      if (typeof variant !== "object" || variant === null) return false;
      const budget = [1, 2, 3, 5][index]!;
      const ids = (variant as { candidateSkillIds?: unknown }).candidateSkillIds;
      return (variant as { budget?: unknown }).budget === budget && Array.isArray(ids) && ids.length <= budget &&
        ids.every((id) => typeof id === "string") && new Set(ids).size === ids.length;
    }));
  const cardVariants = typeof v.cardProjection === "object" && v.cardProjection !== null
    ? (v.cardProjection as { variants?: unknown }).variants : undefined;
  const baselineChars = typeof v.cardProjection === "object" && v.cardProjection !== null
    ? (v.cardProjection as { baselineDescriptionChars?: unknown }).baselineDescriptionChars : undefined;
  const cardValid = v.cardProjection === undefined || (
    Number.isInteger(baselineChars) && (baselineChars as number) >= 0 && Array.isArray(cardVariants) &&
    cardVariants.length === 3 && cardVariants.every((variant, index) => {
      if (typeof variant !== "object" || variant === null) return false;
      const total = (variant as { totalDescriptionChars?: unknown }).totalDescriptionChars;
      const truncated = (variant as { truncatedCandidateCount?: unknown }).truncatedCandidateCount;
      return (variant as { maxDescriptionChars?: unknown }).maxDescriptionChars === [120, 240, 480][index] &&
        Number.isInteger(total) && (total as number) >= 0 && (total as number) <= (baselineChars as number) &&
        Number.isInteger(truncated) && (truncated as number) >= 0 && (truncated as number) <= (v.candidateCount as number);
    })
  );
  if (v.schemaVersion !== 1 || typeof v.routeDecisionId !== "string" || v.routeDecisionId === "" ||
      typeof v.tenantScope !== "string" || v.tenantScope === "" || typeof v.observedAt !== "string" ||
      typeof v.baselineWouldInject !== "boolean" || !Number.isInteger(v.candidateCount) ||
      (v.candidateCount as number) < 0 || !scoresValid || typeof v.exactDeclaredReference !== "boolean" ||
      !Array.isArray(v.topMatchFields) || !v.topMatchFields.every((field) => FIELDS.includes(field as ExposureMatchField)) ||
      !Array.isArray(v.selectedSkillIds) || !v.selectedSkillIds.every((id) => typeof id === "string") ||
      !budgetValid || !cardValid) {
    throw new Error("exposure_store_corrupt: invalid_record");
  }
}

export class ExposureObservationStore {
  readonly rootDir: string;
  readonly projectRoot: string;
  constructor(options: { rootDir: string; projectRoot?: string }) {
    this.projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    this.rootDir = path.resolve(options.rootDir);
    if (!inside(this.projectRoot, this.rootDir)) throw new Error("exposure_store_root_must_be_inside_project_root");
  }
  #dir(tenantScope: string): string { return path.join(this.rootDir, hash(tenantScope)); }
  #file(record: Pick<ExposureObservationRecord, "tenantScope" | "routeDecisionId">): string {
    return path.join(this.#dir(record.tenantScope), `${hash(record.routeDecisionId)}.json`);
  }
  async #init(): Promise<void> {
    const realProject = await realpath(this.projectRoot);
    let probe = this.rootDir;
    while (true) {
      try {
        const realProbe = await realpath(probe);
        if (!inside(realProject, realProbe)) throw new Error("exposure_store_root_must_be_inside_project_root");
        break;
      } catch (error) {
        if (!errno(error, "ENOENT")) throw error;
        const parent = path.dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      }
    }
    await mkdir(this.rootDir, { recursive: true });
    if (!inside(realProject, await realpath(this.rootDir))) throw new Error("exposure_store_root_must_be_inside_project_root");
  }
  async append(record: ExposureObservationRecord): Promise<void> {
    assertRecord(record);
    await this.#init();
    const file = this.#file(record);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(record), { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
      if (errno(error, "EEXIST")) throw new Error("exposure_route_already_observed");
      throw error;
    });
  }
  async list(tenantScope: string): Promise<ExposureObservationRecord[]> {
    await this.#init();
    const names = await readdir(this.#dir(tenantScope)).catch((error: unknown) => {
      if (errno(error, "ENOENT")) return [] as string[];
      throw error;
    });
    const records: ExposureObservationRecord[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.#dir(tenantScope), name);
      if (!(await lstat(file)).isFile()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(file, "utf8")); }
      catch { throw new Error("exposure_store_corrupt: json_parse"); }
      assertRecord(parsed);
      if (parsed.tenantScope !== tenantScope || hash(parsed.routeDecisionId) !== name.slice(0, -5)) {
        throw new Error("exposure_store_corrupt: binding_mismatch");
      }
      records.push(parsed);
    }
    return records.sort((a, b) => a.routeDecisionId.localeCompare(b.routeDecisionId));
  }
}
