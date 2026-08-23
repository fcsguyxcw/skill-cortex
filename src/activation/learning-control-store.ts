import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LearningControlState {
  schemaVersion: 1;
  learningEnabled: boolean;
  updatedAt: string;
}

export interface LearningControlStoreOptions {
  rootDir: string;
  projectRoot?: string;
  tenantScope: string;
  now?: () => Date;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

export class LearningControlStore {
  readonly rootDir: string;
  readonly projectRoot: string;
  readonly tenantScope: string;
  #now: () => Date;

  constructor(options: LearningControlStoreOptions) {
    this.projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    this.rootDir = path.resolve(options.rootDir);
    if (!isPathInside(this.projectRoot, this.rootDir)) {
      throw new Error("learning_control_root_must_be_inside_project_root");
    }
    this.tenantScope = options.tenantScope;
    this.#now = options.now ?? (() => new Date());
  }

  #statePath(): string {
    return path.join(this.rootDir, hash(this.tenantScope), "state.json");
  }

  async #ensureInit(): Promise<void> {
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
      throw new Error("learning_control_root_must_be_inside_project_root");
    }
    await mkdir(path.dirname(this.#statePath()), { recursive: true });
    const realRoot = await realpath(this.rootDir);
    if (!isPathInside(realProject, realRoot)) {
      throw new Error("learning_control_root_must_be_inside_project_root");
    }
  }

  async status(): Promise<LearningControlState> {
    await this.#ensureInit();
    const raw = await readFile(this.#statePath(), "utf8").catch((error: unknown) => {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (raw === undefined) {
      return { schemaVersion: 1, learningEnabled: true, updatedAt: "1970-01-01T00:00:00.000Z" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("learning_control_corrupt: json_parse");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      typeof (parsed as { learningEnabled?: unknown }).learningEnabled !== "boolean" ||
      typeof (parsed as { updatedAt?: unknown }).updatedAt !== "string"
    ) {
      throw new Error("learning_control_corrupt: invalid_state");
    }
    return parsed as LearningControlState;
  }

  async setLearning(enabled: boolean): Promise<LearningControlState> {
    if (typeof enabled !== "boolean") throw new Error("learning_control_enabled_must_be_boolean");
    await this.#ensureInit();
    const state: LearningControlState = {
      schemaVersion: 1,
      learningEnabled: enabled,
      updatedAt: this.#now().toISOString(),
    };
    const statePath = this.#statePath();
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(state), { encoding: "utf8", flag: "wx" });
    try {
      await rename(tempPath, statePath);
    } finally {
      await rm(tempPath, { force: true });
    }
    return state;
  }
}
