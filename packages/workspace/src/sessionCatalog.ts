import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rm, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkspacePaths } from "./paths";
import type { SessionRecord, SessionState } from "./types";

export interface SessionCatalog {
  list(): Promise<SessionRecord[]>;
  get(sessionId: string): Promise<SessionRecord | undefined>;
  create(record: SessionRecord): Promise<void>;
  updateState(sessionId: string, state: SessionState): Promise<void>;
  appendAuditGap(sessionId: string, gap: SessionRecord["auditGaps"][number]): Promise<void>;
  reconcileInterrupted(): Promise<number>;
}

export interface LocalSessionCatalogOptions {
  now?: () => number;
}

export class SessionCatalogError extends Error {
  constructor(
    message: string,
    readonly file: string,
    options?: ErrorOptions,
  ) {
    super(`${message}: ${file}`, options);
    this.name = "SessionCatalogError";
  }
}

export class SessionBindingConflictError extends SessionCatalogError {
  constructor(file: string) {
    super("session already exists with a different workspace binding", file);
    this.name = "SessionBindingConflictError";
  }
}

export class LocalSessionCatalog implements SessionCatalog {
  private readonly now: () => number;
  private readonly mutationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly paths: WorkspacePaths,
    options: LocalSessionCatalogOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async list(): Promise<SessionRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(join(this.paths.dataRoot, "sessions"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: SessionRecord[] = [];
    for (const id of entries) {
      const record = await this.get(id);
      if (record) records.push(record);
    }
    return records.sort((left, right) => right.meta.updatedAt - left.meta.updatedAt);
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    const file = this.paths.sessionRecord(sessionId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return parseSessionRecord(raw, file, sessionId);
  }

  async create(record: SessionRecord): Promise<void> {
    const file = this.paths.sessionRecord(record.meta.id);
    const normalized: SessionRecord = { ...record, state: "starting" };
    assertSessionRecord(normalized, file, record.meta.id);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeNewFile(temporary, normalized);
      try {
        await link(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.get(record.meta.id);
        if (!existing || !sameBinding(existing, normalized)) {
          throw new SessionBindingConflictError(file);
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async updateState(sessionId: string, state: SessionState): Promise<void> {
    await this.mutate(sessionId, (record) => ({ ...record, state }));
  }

  async appendAuditGap(
    sessionId: string,
    gap: SessionRecord["auditGaps"][number],
  ): Promise<void> {
    await this.mutate(sessionId, (record) => ({
      ...record,
      auditStatus: "incomplete",
      auditGaps: [...record.auditGaps, gap],
    }));
  }

  async reconcileInterrupted(): Promise<number> {
    const records = await this.list();
    let count = 0;
    for (const record of records) {
      if (record.state !== "starting" && record.state !== "running") continue;
      await this.mutate(record.meta.id, (current) => ({
        ...current,
        state: "interrupted",
        auditStatus: "incomplete",
        auditGaps: [
          ...current.auditGaps,
          { reason: "ungraceful-shutdown", createdAt: this.now() },
        ],
      }));
      count += 1;
    }
    return count;
  }

  private async mutate(
    sessionId: string,
    update: (record: SessionRecord) => SessionRecord,
  ): Promise<void> {
    await this.withMutationLock(sessionId, async () => {
      const existing = await this.get(sessionId);
      if (!existing) throw new SessionCatalogError("session does not exist", this.paths.sessionRecord(sessionId));
      const next = update(existing);
      assertSessionRecord(next, this.paths.sessionRecord(sessionId), sessionId);
      await writeJsonAtomic(this.paths.sessionRecord(sessionId), next);
    });
  }

  private async withMutationLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const barrier = previous.catch(() => undefined).then(() => current);
    this.mutationLocks.set(sessionId, barrier);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationLocks.get(sessionId) === barrier) this.mutationLocks.delete(sessionId);
    }
  }
}

async function writeNewFile(file: string, value: unknown): Promise<void> {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeNewFile(temporary, value);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseSessionRecord(raw: string, file: string, expectedId: string): SessionRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SessionCatalogError("invalid session JSON", file, { cause: error });
  }
  return assertSessionRecord(value, file, expectedId);
}

function assertSessionRecord(value: unknown, file: string, expectedId: string): SessionRecord {
  if (!isObject(value)) throw new SessionCatalogError("session must be an object", file);
  if (value.schemaVersion !== 1) {
    throw new SessionCatalogError(
      `unsupported session schema version ${String(value.schemaVersion)}`,
      file,
    );
  }
  if (!isObject(value.meta) || value.meta.id !== expectedId) {
    throw new SessionCatalogError("session metadata id does not match its directory", file);
  }
  if (!isObject(value.binding) || value.binding.sessionId !== expectedId) {
    throw new SessionCatalogError("session binding id does not match its directory", file);
  }
  if (!Array.isArray(value.binding.roots) || value.binding.roots.length === 0) {
    throw new SessionCatalogError("session binding roots are invalid", file);
  }
  if (!isSessionState(value.state)) throw new SessionCatalogError("session state is invalid", file);
  if (value.auditStatus !== "complete" && value.auditStatus !== "incomplete") {
    throw new SessionCatalogError("session audit status is invalid", file);
  }
  if (!Array.isArray(value.auditGaps)) {
    throw new SessionCatalogError("session audit gaps are invalid", file);
  }
  return value as unknown as SessionRecord;
}

function sameBinding(left: SessionRecord, right: SessionRecord): boolean {
  return JSON.stringify(left.binding) === JSON.stringify(right.binding);
}

function isSessionState(value: unknown): value is SessionState {
  return value === "starting" || value === "running" || value === "idle" || value === "interrupted";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
