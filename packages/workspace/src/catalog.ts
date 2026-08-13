import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { WorkspacePaths } from "./paths";
import type { Workspace, WorkspaceEnvelope, WorkspaceKind, WorkspaceRoot } from "./types";

export interface WorkspaceCatalog {
  get(id: string): Promise<Workspace | undefined>;
  list(): Promise<Workspace[]>;
  put(workspace: Workspace): Promise<void>;
  createManagedChat(name?: string): Promise<Workspace>;
}

export interface LocalWorkspaceCatalogOptions {
  idFactory?: (prefix: "ws" | "root") => string;
  now?: () => number;
}

export class WorkspaceCatalogError extends Error {
  constructor(
    message: string,
    readonly file: string,
    options?: ErrorOptions,
  ) {
    super(`${message}: ${file}`, options);
    this.name = "WorkspaceCatalogError";
  }
}

export class UnsupportedSchemaVersionError extends WorkspaceCatalogError {
  constructor(
    file: string,
    readonly version: unknown,
  ) {
    super(`unsupported workspace schema version ${String(version)}`, file);
    this.name = "UnsupportedSchemaVersionError";
  }
}

export class LocalWorkspaceCatalog implements WorkspaceCatalog {
  private readonly idFactory: (prefix: "ws" | "root") => string;
  private readonly now: () => number;

  constructor(
    private readonly paths: WorkspacePaths,
    options: LocalWorkspaceCatalogOptions = {},
  ) {
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.now = options.now ?? Date.now;
  }

  async get(id: string): Promise<Workspace | undefined> {
    const file = this.paths.workspaceFile(id);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const workspace = parseWorkspace(raw, file);
    if (workspace.id !== id) {
      throw new WorkspaceCatalogError(
        `workspace id ${JSON.stringify(workspace.id)} does not match filename ${JSON.stringify(id)}`,
        file,
      );
    }
    return workspace;
  }

  async list(): Promise<Workspace[]> {
    let entries: string[];
    try {
      entries = await readdir(this.paths.workspaceDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const workspaces: Workspace[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = basename(entry, ".json");
      const workspace = await this.get(id);
      if (workspace) workspaces.push(workspace);
    }
    return workspaces.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async put(workspace: Workspace): Promise<void> {
    assertWorkspace(workspace, this.paths.workspaceFile(workspace.id));
    const file = this.paths.workspaceFile(workspace.id);
    const envelope: WorkspaceEnvelope = { schemaVersion: 1, workspace };
    await writeJsonAtomic(file, envelope);
  }

  async createManagedChat(name = "New chat"): Promise<Workspace> {
    const workspaceId = this.idFactory("ws");
    const rootId = this.idFactory("root");
    const timestamp = this.now();
    const workspace: Workspace = {
      id: workspaceId,
      name,
      kind: "managed-chat",
      roots: [
        {
          id: rootId,
          displayName: name,
          source: { type: "managed" },
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await mkdir(this.paths.managedRoot(workspaceId), { recursive: true });
    await this.put(workspace);
    return workspace;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseWorkspace(raw: string, file: string): Workspace {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new WorkspaceCatalogError("invalid workspace JSON", file, { cause: error });
  }

  if (isObject(value) && "schemaVersion" in value) {
    if (value.schemaVersion !== 1) {
      throw new UnsupportedSchemaVersionError(file, value.schemaVersion);
    }
    if (!("workspace" in value)) {
      throw new WorkspaceCatalogError("workspace envelope is missing workspace", file);
    }
    return assertWorkspace(value.workspace, file);
  }

  // Legacy v0 stored the Workspace object without an envelope.
  return assertWorkspace(value, file);
}

function assertWorkspace(value: unknown, file: string): Workspace {
  if (!isObject(value)) throw new WorkspaceCatalogError("workspace must be an object", file);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new WorkspaceCatalogError("workspace.id must be a non-empty string", file);
  }
  if (typeof value.name !== "string") {
    throw new WorkspaceCatalogError("workspace.name must be a string", file);
  }
  if (!isWorkspaceKind(value.kind)) {
    throw new WorkspaceCatalogError("workspace.kind is invalid", file);
  }
  if (!Array.isArray(value.roots) || value.roots.length === 0) {
    throw new WorkspaceCatalogError("workspace.roots must be a non-empty array", file);
  }
  for (const root of value.roots) assertRoot(root, file);
  if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") {
    throw new WorkspaceCatalogError("workspace timestamps must be numbers", file);
  }
  return value as unknown as Workspace;
}

function assertRoot(value: unknown, file: string): asserts value is WorkspaceRoot {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.displayName !== "string") {
    throw new WorkspaceCatalogError("workspace root identity is invalid", file);
  }
  if (!isObject(value.source) || typeof value.source.type !== "string") {
    throw new WorkspaceCatalogError("workspace root source is invalid", file);
  }
  switch (value.source.type) {
    case "managed":
      return;
    case "local":
      if (typeof value.source.path === "string") return;
      break;
    case "git":
      if (
        typeof value.source.remoteIdentity === "string" &&
        typeof value.source.repositoryId === "string"
      ) {
        return;
      }
      break;
  }
  throw new WorkspaceCatalogError("workspace root source fields are invalid", file);
}

function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return value === "managed-chat" || value === "local-directory" || value === "git-clone";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
