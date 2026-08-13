import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkspacePaths } from "./paths";
import type { RepositoryService } from "./repositoryService";
import type { SessionCatalog } from "./sessionCatalog";
import type { SessionRecord } from "./types";

export interface LegacySessionMigratorOptions {
  paths: WorkspacePaths;
  repositories: RepositoryService;
  sessions: SessionCatalog;
  legacyRoots: string[];
}

export class AmbiguousLegacySessionError extends Error {
  constructor(
    readonly sessionId: string,
    readonly matches: string[],
  ) {
    super(`legacy session ${sessionId} exists under multiple explicit roots: ${matches.join(", ")}`);
    this.name = "AmbiguousLegacySessionError";
  }
}

export class LegacySessionMigrator {
  private readonly paths: WorkspacePaths;
  private readonly repositories: RepositoryService;
  private readonly sessions: SessionCatalog;
  private readonly legacyRoots: string[];

  constructor(options: LegacySessionMigratorOptions) {
    this.paths = options.paths;
    this.repositories = options.repositories;
    this.sessions = options.sessions;
    this.legacyRoots = options.legacyRoots;
  }

  async migrate(sessionId: string): Promise<SessionRecord | undefined> {
    const existing = await this.sessions.get(sessionId);
    if (existing) return existing;

    const matches: Array<{ root: string; directory: string }> = [];
    for (const root of this.legacyRoots) {
      const directory = join(root, ".helios", "sessions", sessionId);
      if (await exists(join(directory, "meta.json"))) matches.push({ root, directory });
    }
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      throw new AmbiguousLegacySessionError(
        sessionId,
        matches.map((match) => match.root),
      );
    }

    const match = matches[0]!;
    const legacyMeta = parseLegacyMeta(
      await readFile(join(match.directory, "meta.json"), "utf8"),
      sessionId,
    );
    const workspace = await this.repositories.importLocalDirectory(match.root, legacyMeta.title);
    const root = workspace.roots[0]!;
    const binding: SessionRecord["binding"] = {
      sessionId,
      mode: "code",
      workspaceId: workspace.id,
      roots: [
        {
          rootId: root.id,
          strategy: "direct",
          materializationId: `direct-${root.id}`,
        },
      ],
      createdAt: legacyMeta.createdAt,
    };
    const record: SessionRecord = {
      schemaVersion: 1,
      meta: {
        id: sessionId,
        title: legacyMeta.title,
        createdAt: legacyMeta.createdAt,
        updatedAt: legacyMeta.updatedAt,
      },
      binding,
      state: "idle",
      auditStatus: "complete",
      auditGaps: [],
    };

    const destination = this.paths.sessionDir(sessionId);
    const temporary = `${destination}.migrate-${process.pid}-${randomUUID()}`;
    await mkdir(temporary, { recursive: true });
    try {
      await writeFile(
        join(temporary, "kernel-meta.json"),
        `${JSON.stringify({ ...legacyMeta, schemaVersion: 1 }, null, 2)}\n`,
        "utf8",
      );
      await migrateJsonLines(
        join(match.directory, "turns.jsonl"),
        join(temporary, "turns.jsonl"),
      );
      await migrateOptionalJsonLines(
        join(match.directory, "compactions.jsonl"),
        join(temporary, "compactions.jsonl"),
      );

      await mkdir(dirname(destination), { recursive: true });
      await rm(destination, { recursive: true, force: true });
      await rename(temporary, destination);
      await this.sessions.create(record);
      await this.sessions.updateState(sessionId, "idle");
      return await this.sessions.get(sessionId);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (!(await this.sessions.get(sessionId))) {
        await rm(destination, { recursive: true, force: true });
      }
      throw error;
    }
  }
}

interface LegacyMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastRunIndex: number;
  lastTurnIndex: number;
}

function parseLegacyMeta(raw: string, sessionId: string): LegacyMeta {
  const value = JSON.parse(raw) as unknown;
  if (!isObject(value) || value.id !== sessionId) {
    throw new Error(`legacy metadata does not match session ${sessionId}`);
  }
  if ("schemaVersion" in value && value.schemaVersion !== 1) {
    throw new Error(`unsupported legacy metadata schema version ${String(value.schemaVersion)}`);
  }
  if (
    typeof value.title !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    typeof value.lastRunIndex !== "number" ||
    typeof value.lastTurnIndex !== "number"
  ) {
    throw new Error(`invalid legacy metadata for session ${sessionId}`);
  }
  return {
    id: sessionId,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastRunIndex: value.lastRunIndex,
    lastTurnIndex: value.lastTurnIndex,
  };
}

async function migrateJsonLines(source: string, destination: string): Promise<void> {
  const raw = await readFile(source, "utf8");
  const rows = raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => withSchemaVersion(JSON.parse(line) as unknown));
  await writeFile(destination, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

async function migrateOptionalJsonLines(source: string, destination: string): Promise<void> {
  try {
    await migrateJsonLines(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function withSchemaVersion(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("legacy JSONL row must be an object");
  if ("schemaVersion" in value && value.schemaVersion !== 1) {
    throw new Error(`unsupported legacy JSONL schema version ${String(value.schemaVersion)}`);
  }
  return { ...value, schemaVersion: 1 };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
