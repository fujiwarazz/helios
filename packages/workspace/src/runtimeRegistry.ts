import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  Kernel,
  type CreateSessionOptions,
  type KernelOptions,
  type Manifest,
  type Session,
} from "@helios/kernel";
import type { Logger } from "@helios/ports";
import type { WorkspaceCatalog } from "./catalog";
import type { WorkspaceMaterializer } from "./materializer";
import { WorkspacePaths } from "./paths";
import { ExecaGitRunner, type GitRunner } from "./repositoryService";
import type { SessionCatalog } from "./sessionCatalog";
import type {
  MaterializedWorkspace,
  SessionLaunchRequest,
  SessionRecord,
  SessionWorkspaceBinding,
  Workspace,
} from "./types";

export interface BoundSession {
  kernel: Kernel;
  session: Session;
  binding: SessionWorkspaceBinding;
  materialized: MaterializedWorkspace;
}

export interface RuntimeRegistry {
  createSession(
    request: SessionLaunchRequest,
    options: CreateSessionOptions,
  ): Promise<BoundSession>;
  resumeSession(sessionId: string, options: CreateSessionOptions): Promise<BoundSession>;
  release(runtimeId: string): Promise<void>;
  scavengeExpiredDrafts(now?: number): Promise<number>;
}

export interface LocalRuntimeRegistryOptions {
  paths: WorkspacePaths;
  catalog: WorkspaceCatalog;
  sessions: SessionCatalog;
  materializer: WorkspaceMaterializer;
  manifest: Manifest;
  logger?: Logger;
  git?: GitRunner;
  now?: () => number;
  draftTtlMs?: number;
  idFactory?: (prefix: "sess" | "mat" | "runtime") => string;
  kernelFactory?: (options: KernelOptions) => Kernel;
}

interface RuntimeEntry {
  id: string;
  key: string;
  kernel: Kernel;
  refs: number;
}

interface DraftEntry {
  sessionId: string;
  runtimeId: string;
  workspace: Workspace;
  binding: SessionWorkspaceBinding;
  materialized: MaterializedWorkspace;
  expiresAt: number;
}

export class WorkspaceUnavailableError extends Error {
  readonly code = "WORKSPACE_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceUnavailableError";
  }
}

export class LocalRuntimeRegistry implements RuntimeRegistry {
  private readonly paths: WorkspacePaths;
  private readonly catalog: WorkspaceCatalog;
  private readonly sessions: SessionCatalog;
  private readonly materializer: WorkspaceMaterializer;
  private readonly manifest: Manifest;
  private readonly logger?: Logger;
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly draftTtlMs: number;
  private readonly idFactory: (prefix: "sess" | "mat" | "runtime") => string;
  private readonly kernelFactory: (options: KernelOptions) => Kernel;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly runtimeKeysById = new Map<string, string>();
  private readonly drafts = new Map<string, DraftEntry>();

  constructor(options: LocalRuntimeRegistryOptions) {
    this.paths = options.paths;
    this.catalog = options.catalog;
    this.sessions = options.sessions;
    this.materializer = options.materializer;
    this.manifest = options.manifest;
    this.logger = options.logger;
    this.git = options.git ?? new ExecaGitRunner();
    this.now = options.now ?? Date.now;
    this.draftTtlMs = options.draftTtlMs ?? 15 * 60_000;
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.kernelFactory = options.kernelFactory ?? ((kernelOptions) => new Kernel(kernelOptions));
  }

  async createSession(
    request: SessionLaunchRequest,
    options: CreateSessionOptions,
  ): Promise<BoundSession> {
    const sessionId = this.idFactory("sess");
    const workspace = await this.resolveLaunchWorkspace(request);
    const binding = this.createBinding(sessionId, request, workspace);
    const materialized = await this.materializeOrUnavailable(workspace, binding);
    const runtime = await this.acquireRuntime(workspace, binding, materialized);
    binding.runtimeId = runtime.id;
    const createdAt = this.now();
    const persistedBinding = withoutRuntimeId(binding);

    const session = runtime.kernel.createSession({
      ...options,
      id: sessionId,
      beforeFirstRun: async (text) => {
        const record: SessionRecord = {
          schemaVersion: 1,
          meta: {
            id: sessionId,
            title: text.slice(0, 60),
            createdAt,
            updatedAt: this.now(),
          },
          binding: persistedBinding,
          state: "starting",
          auditStatus: "complete",
          auditGaps: [],
        };
        await this.sessions.create(record);
        this.drafts.delete(sessionId);
        await options.beforeFirstRun?.(text);
      },
      onRunStateChange: async (state) => {
        await this.sessions.updateState(sessionId, state);
        await options.onRunStateChange?.(state);
      },
    });
    this.drafts.set(sessionId, {
      sessionId,
      runtimeId: runtime.id,
      workspace,
      binding,
      materialized,
      expiresAt: this.now() + this.draftTtlMs,
    });
    return { kernel: runtime.kernel, session, binding, materialized };
  }

  async resumeSession(
    sessionId: string,
    options: CreateSessionOptions,
  ): Promise<BoundSession> {
    const record = await this.sessions.get(sessionId);
    if (!record) throw new WorkspaceUnavailableError(`session ${sessionId} does not exist`);
    const workspace = await this.catalog.get(record.binding.workspaceId);
    if (!workspace) {
      throw new WorkspaceUnavailableError(
        `workspace ${record.binding.workspaceId} for session ${sessionId} does not exist`,
      );
    }
    const binding = withoutRuntimeId(record.binding);
    const materialized = await this.materializeOrUnavailable(workspace, binding);
    const runtime = await this.acquireRuntime(workspace, binding, materialized);
    binding.runtimeId = runtime.id;
    try {
      const session = await runtime.kernel.resumeSession(sessionId, {
        ...options,
        id: sessionId,
        onRunStateChange: async (state) => {
          await this.sessions.updateState(sessionId, state);
          await options.onRunStateChange?.(state);
        },
      });
      return { kernel: runtime.kernel, session, binding, materialized };
    } catch (error) {
      await this.release(runtime.id);
      throw error;
    }
  }

  async release(runtimeId: string): Promise<void> {
    const key = this.runtimeKeysById.get(runtimeId);
    if (!key) return;
    const runtime = this.runtimes.get(key);
    if (!runtime) return;
    runtime.refs -= 1;
    if (runtime.refs > 0) return;
    this.runtimes.delete(key);
    this.runtimeKeysById.delete(runtime.id);
    await runtime.kernel.dispose();
  }

  async scavengeExpiredDrafts(now = this.now()): Promise<number> {
    let removed = 0;
    for (const draft of [...this.drafts.values()]) {
      if (draft.expiresAt > now) continue;
      if (await this.sessions.get(draft.sessionId)) {
        this.drafts.delete(draft.sessionId);
        continue;
      }
      await this.release(draft.runtimeId);
      await this.removeDraftFiles(draft);
      this.drafts.delete(draft.sessionId);
      removed += 1;
    }
    return removed;
  }

  private async resolveLaunchWorkspace(request: SessionLaunchRequest): Promise<Workspace> {
    if (request.mode === "chat" && !request.workspaceId) {
      return this.catalog.createManagedChat();
    }
    if (!request.workspaceId) throw new Error("Code mode requires a workspaceId");
    const workspace = await this.catalog.get(request.workspaceId);
    if (!workspace) throw new WorkspaceUnavailableError(`workspace ${request.workspaceId} does not exist`);
    return workspace;
  }

  private createBinding(
    sessionId: string,
    request: SessionLaunchRequest,
    workspace: Workspace,
  ): SessionWorkspaceBinding {
    if (workspace.roots.length !== 1) throw new Error("single-root workspace required");
    const root = workspace.roots[0]!;
    const selection = request.roots?.[0] ?? { rootId: root.id, strategy: "direct" as const };
    if (request.roots && request.roots.length !== 1) throw new Error("single-root selection required");
    if (selection.rootId !== root.id) throw new Error("selected root does not belong to workspace");
    return {
      sessionId,
      mode: request.mode,
      workspaceId: workspace.id,
      roots: [
        {
          ...selection,
          materializationId:
            selection.strategy === "direct" ? `direct-${root.id}` : this.idFactory("mat"),
        },
      ],
      createdAt: this.now(),
    };
  }

  private async materializeOrUnavailable(
    workspace: Workspace,
    binding: SessionWorkspaceBinding,
  ): Promise<MaterializedWorkspace> {
    try {
      return await this.materializer.materialize(workspace, binding);
    } catch (error) {
      throw new WorkspaceUnavailableError(
        `workspace ${workspace.id} cannot be materialized: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private async acquireRuntime(
    workspace: Workspace,
    binding: SessionWorkspaceBinding,
    materialized: MaterializedWorkspace,
  ): Promise<RuntimeEntry> {
    const runtimeManifest = manifestForWorkspace(
      this.manifest,
      this.paths.memoryDir(workspace.id),
    );
    const key = JSON.stringify({
      workspaceId: workspace.id,
      roots: binding.roots,
      materialized,
      manifest: runtimeManifest,
    });
    const existing = this.runtimes.get(key);
    if (existing) {
      existing.refs += 1;
      return existing;
    }

    const kernel = this.kernelFactory({
      workDir: materialized.primaryDir,
      sessionDataRoot: join(this.paths.dataRoot, "sessions"),
      manifest: runtimeManifest,
      logger: this.logger,
    });
    await kernel.start();
    const runtime: RuntimeEntry = {
      id: this.idFactory("runtime"),
      key,
      kernel,
      refs: 1,
    };
    this.runtimes.set(key, runtime);
    this.runtimeKeysById.set(runtime.id, key);
    return runtime;
  }

  private async removeDraftFiles(draft: DraftEntry): Promise<void> {
    for (const rootBinding of draft.binding.roots) {
      if (rootBinding.strategy !== "worktree") continue;
      const materializedRoot = draft.materialized.roots.find(
        (root) => root.rootId === rootBinding.rootId,
      );
      const workspaceRoot = draft.workspace.roots.find((root) => root.id === rootBinding.rootId);
      if (!materializedRoot || !workspaceRoot) continue;
      const source = sourcePath(this.paths, draft.workspace, workspaceRoot);
      try {
        await this.git.run(["worktree", "remove", "--force", materializedRoot.absolutePath], {
          cwd: source,
        });
      } catch {
        await rm(materializedRoot.absolutePath, { recursive: true, force: true });
      }
    }
    if (draft.workspace.kind === "managed-chat") {
      await rm(this.paths.managedRoot(draft.workspace.id), { recursive: true, force: true });
    }
  }
}

function manifestForWorkspace(manifest: Manifest, storageDir: string): Manifest {
  return {
    plugins: manifest.plugins.map((entry) =>
      entry.port === "MemoryPort"
        ? { ...entry, options: { ...entry.options, storageDir } }
        : { ...entry, options: entry.options ? { ...entry.options } : undefined },
    ),
  };
}

function withoutRuntimeId(binding: SessionWorkspaceBinding): SessionWorkspaceBinding {
  const { runtimeId: _runtimeId, ...persisted } = binding;
  return {
    ...persisted,
    roots: binding.roots.map((root) => ({ ...root })),
  };
}

function sourcePath(
  paths: WorkspacePaths,
  workspace: Workspace,
  root: Workspace["roots"][number],
): string {
  switch (root.source.type) {
    case "managed":
      return paths.managedRoot(workspace.id);
    case "local":
      return root.source.path;
    case "git":
      return paths.repositorySource(root.source.repositoryId);
  }
}
