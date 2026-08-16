import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  Kernel,
  type CreateSessionOptions,
  type KernelOptions,
  type Manifest,
  type Session,
} from "@helios/kernel";
import type { Logger } from "@helios/ports";
import type { WorkspaceCatalog } from "./catalog";
import type { MaterializeOptions, WorkspaceMaterializer } from "./materializer";
import { WorkspacePaths } from "./paths";
import { DEFAULT_GIT_TIMEOUT_MS, ExecaGitRunner, type GitRunner } from "./repositoryService";
import type { SessionCatalog } from "./sessionCatalog";
import type { LocalEditRecordStore } from "./editRecordStore";
import type { LocalMutationCoordinator } from "./mutationCoordinator";
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
    options: RuntimeSessionOptions,
  ): Promise<BoundSession>;
  resumeSession(sessionId: string, options: RuntimeSessionOptions): Promise<BoundSession>;
  release(runtimeId: string, sessionId?: string): Promise<void>;
  scavengeExpiredDrafts(now?: number): Promise<number>;
}

export interface RuntimeSessionOptions extends CreateSessionOptions {
  materialize?: MaterializeOptions;
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
  editRecords?: LocalEditRecordStore;
  mutations?: LocalMutationCoordinator;
  /**
   * Enables the built-in Bash tool for this runtime. Off by default: a shell can write outside
   * the Workspace and its writes cannot be attributed to a toolUseId, so hosts that opt in get
   * their sessions marked audit-incomplete (see README「Workspace Runtime 暂时禁用 Bash」).
   */
  allowShellTool?: boolean;
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
  private readonly allowShellTool: boolean;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly runtimeStarts = new Map<string, Promise<RuntimeEntry>>();
  private readonly runtimeKeysById = new Map<string, string>();
  private readonly drafts = new Map<string, DraftEntry>();
  private readonly editRecords?: LocalEditRecordStore;
  private readonly mutations?: LocalMutationCoordinator;

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
    this.editRecords = options.editRecords;
    this.mutations = options.mutations;
    this.allowShellTool = options.allowShellTool ?? false;
  }

  async createSession(
    request: SessionLaunchRequest,
    options: RuntimeSessionOptions,
  ): Promise<BoundSession> {
    const { materialize: materializeOptions, ...sessionOptions } = options;
    const sessionId = this.idFactory("sess");
    const workspace = await this.resolveLaunchWorkspace(request);
    const binding = this.createBinding(sessionId, request, workspace);
    const materialized = await this.materializeOrUnavailable(
      workspace,
      binding,
      materializeOptions,
    );
    let runtime: RuntimeEntry;
    try {
      runtime = await this.acquireRuntime(workspace, binding, materialized);
    } catch (error) {
      try {
        await this.removeDraftFiles({
          sessionId,
          runtimeId: "",
          workspace,
          binding,
          materialized,
          expiresAt: this.now(),
        });
        if (workspace.kind === "managed-chat") await this.catalog.delete(workspace.id);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `runtime startup failed and workspace cleanup was incomplete: ${workspace.id}`,
        );
      }
      throw error;
    }
    binding.runtimeId = runtime.id;
    const createdAt = this.now();
    const persistedBinding = withoutRuntimeId(binding);

    const session = runtime.kernel.createSession({
      ...sessionOptions,
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
          // A shell can write anywhere, so an audit gap is recorded up front rather than pretending
          // the edit records cover every mutation of this session.
          auditStatus: this.allowShellTool ? "incomplete" : "complete",
          auditGaps: this.allowShellTool
            ? [{ reason: "Bash enabled: shell writes are not attributed", createdAt: this.now() }]
            : [],
        };
        await this.sessions.create(record);
        this.drafts.delete(sessionId);
        await sessionOptions.beforeFirstRun?.(text);
      },
      onRunStateChange: async (state) => {
        await this.sessions.updateState(sessionId, state);
        await sessionOptions.onRunStateChange?.(state);
      },
      ...this.auditOptions(sessionId, workspace, binding, materialized),
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
    options: RuntimeSessionOptions,
  ): Promise<BoundSession> {
    const { materialize: materializeOptions, ...sessionOptions } = options;
    const record = await this.sessions.get(sessionId);
    if (!record) throw new WorkspaceUnavailableError(`session ${sessionId} does not exist`);
    const workspace = await this.catalog.get(record.binding.workspaceId);
    if (!workspace) {
      throw new WorkspaceUnavailableError(
        `workspace ${record.binding.workspaceId} for session ${sessionId} does not exist`,
      );
    }
    const binding = withoutRuntimeId(record.binding);
    const materialized = await this.materializeOrUnavailable(
      workspace,
      binding,
      materializeOptions,
    );
    const runtime = await this.acquireRuntime(workspace, binding, materialized);
    binding.runtimeId = runtime.id;
    try {
      const session = await runtime.kernel.resumeSession(sessionId, {
        ...sessionOptions,
        id: sessionId,
        onRunStateChange: async (state) => {
          await this.sessions.updateState(sessionId, state);
          await sessionOptions.onRunStateChange?.(state);
        },
        ...this.auditOptions(sessionId, workspace, binding, materialized),
      });
      return { kernel: runtime.kernel, session, binding, materialized };
    } catch (error) {
      await this.release(runtime.id);
      throw error;
    }
  }

  async release(runtimeId: string, sessionId?: string): Promise<void> {
    const key = this.runtimeKeysById.get(runtimeId);
    if (!key) return;
    const runtime = this.runtimes.get(key);
    if (!runtime) return;
    runtime.refs -= 1;
    if (runtime.refs === 0) {
      this.runtimes.delete(key);
      this.runtimeKeysById.delete(runtime.id);
      await runtime.kernel.dispose();
    }
    if (sessionId) await this.removeUncommittedDraft(sessionId, runtimeId);
  }

  async scavengeExpiredDrafts(now = this.now()): Promise<number> {
    let removed = 0;
    for (const draft of [...this.drafts.values()]) {
      if (draft.expiresAt > now) continue;
      if (await this.sessions.get(draft.sessionId)) {
        this.drafts.delete(draft.sessionId);
        continue;
      }
      await this.release(draft.runtimeId, draft.sessionId);
      removed += 1;
    }
    return removed;
  }

  private async resolveLaunchWorkspace(request: SessionLaunchRequest): Promise<Workspace> {
    if (request.mode === "chat") {
      if (request.workspaceId || request.roots?.length) {
        throw new Error("Chat mode cannot select an existing workspace or roots");
      }
      return this.catalog.createManagedChat();
    }
    if (!request.workspaceId) throw new Error("Code mode requires a workspaceId");
    const workspace = await this.catalog.get(request.workspaceId);
    if (!workspace) throw new WorkspaceUnavailableError(`workspace ${request.workspaceId} does not exist`);
    if (workspace.kind === "managed-chat") {
      throw new Error("Code mode requires a repository workspace");
    }
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
    options?: MaterializeOptions,
  ): Promise<MaterializedWorkspace> {
    try {
      await this.pinWorktreeRevision(workspace, binding, options);
      return await this.materializer.materialize(workspace, binding, options);
    } catch (error) {
      throw new WorkspaceUnavailableError(
        `workspace ${workspace.id} cannot be materialized: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private async pinWorktreeRevision(
    workspace: Workspace,
    binding: SessionWorkspaceBinding,
    options?: MaterializeOptions,
  ): Promise<void> {
    const rootBinding = binding.roots[0];
    if (!rootBinding || rootBinding.strategy !== "worktree" || rootBinding.revision) return;
    const root = workspace.roots.find((candidate) => candidate.id === rootBinding.rootId);
    if (!root?.git) throw new Error("worktree materialization requires a Git root");
    const reference = rootBinding.branch ?? root.git.defaultBranch ?? "HEAD";
    const result = await this.git.run(["rev-parse", reference], {
      cwd: sourcePath(this.paths, workspace, root),
      signal: options?.signal,
      timeoutMs: options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    });
    rootBinding.revision = result.stdout.trim();
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

    const pending = this.runtimeStarts.get(key);
    if (pending) {
      const runtime = await pending;
      runtime.refs += 1;
      return runtime;
    }

    const start = this.startRuntime(key, runtimeManifest, materialized);
    this.runtimeStarts.set(key, start);
    try {
      return await start;
    } finally {
      if (this.runtimeStarts.get(key) === start) this.runtimeStarts.delete(key);
    }
  }

  private async startRuntime(
    key: string,
    runtimeManifest: Manifest,
    materialized: MaterializedWorkspace,
  ): Promise<RuntimeEntry> {
    const kernel = this.kernelFactory({
      workDir: materialized.primaryDir,
      sessionDataRoot: join(this.paths.dataRoot, "sessions"),
      manifest: runtimeManifest,
      logger: this.logger,
      disabledBuiltinTools: this.allowShellTool ? [] : ["Bash"],
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

  private async removeUncommittedDraft(sessionId: string, runtimeId: string): Promise<void> {
    const draft = this.drafts.get(sessionId);
    if (!draft || draft.runtimeId !== runtimeId) return;
    if (await this.sessions.get(sessionId)) {
      this.drafts.delete(sessionId);
      return;
    }
    await this.removeDraftFiles(draft);
    if (draft.workspace.kind === "managed-chat") {
      await this.catalog.delete(draft.workspace.id);
    }
    this.drafts.delete(sessionId);
  }

  private auditOptions(
    sessionId: string,
    workspace: Workspace,
    binding: SessionWorkspaceBinding,
    materialized: MaterializedWorkspace,
  ): Pick<
    CreateSessionOptions,
    "recordEdit" | "markAuditGap" | "acquireMutationLease" | "rollbackPolicy"
  > {
    const rootBinding = binding.roots[0]!;
    const root = materialized.roots[0]!;
    return {
      rollbackPolicy: "conversation-only",
      recordEdit: this.editRecords
        ? async (edit) => {
            const relativePath = relativeWithin(root.absolutePath, edit.path);
            const record = {
              schemaVersion: 1 as const,
              id: `edit_${randomUUID()}`,
              sessionId,
              workspaceId: workspace.id,
              rootId: root.rootId,
              toolUseId: edit.toolUseId,
              relativePath,
              operation: edit.operation,
              before: edit.before,
              after: edit.after,
              createdAt: this.now(),
            };
            await this.editRecords!.append(record);
            return {
              workspaceId: workspace.id,
              rootId: root.rootId,
              relativePath,
              before: edit.before,
              after: edit.after,
            };
          }
        : undefined,
      markAuditGap: async (gap) => this.sessions.appendAuditGap(sessionId, gap),
      acquireMutationLease:
        this.mutations && rootBinding.strategy === "direct"
          ? (runId) =>
              this.mutations!.acquire({
                workspaceId: workspace.id,
                materializationId: rootBinding.materializationId,
                rootPath: root.absolutePath,
                sessionId,
                runId,
                onExternalModification: async () => {
                  await this.sessions.appendAuditGap(sessionId, {
                    reason: "workspace changed outside Helios before this run",
                    createdAt: this.now(),
                  });
                },
              })
          : undefined,
    };
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
      const gitOptions = { cwd: source, timeoutMs: DEFAULT_GIT_TIMEOUT_MS };
      const cleanupErrors: unknown[] = [];
      await this.git
        .run(["worktree", "remove", "--force", materializedRoot.absolutePath], gitOptions)
        .catch((error) => cleanupErrors.push(error));
      await rm(materializedRoot.absolutePath, { recursive: true, force: true });
      const branch = `helios/${rootBinding.materializationId}`;
      await this.git
        .run(["branch", "-D", branch], gitOptions)
        .catch((error) => cleanupErrors.push(error));
      await this.git
        .run(["worktree", "prune"], gitOptions)
        .catch((error) => cleanupErrors.push(error));
      let verificationError: unknown;
      try {
        const [worktrees, branches] = await Promise.all([
          this.git.run(["worktree", "list", "--porcelain"], gitOptions),
          this.git.run(["branch", "--list", branch], gitOptions),
        ]);
        if (worktrees.stdout.includes(materializedRoot.absolutePath) || branches.stdout.trim()) {
          throw new Error(`worktree cleanup left Git metadata for ${materializedRoot.absolutePath}`);
        }
      } catch (error) {
        cleanupErrors.push(error);
        verificationError = error;
      }
      await rm(dirname(materializedRoot.absolutePath), { recursive: true, force: true });
      if (verificationError !== undefined) {
        throw new AggregateError(cleanupErrors, `failed to fully clean worktree ${branch}`);
      }
    }
    if (draft.workspace.kind === "managed-chat") {
      await rm(this.paths.managedRoot(draft.workspace.id), { recursive: true, force: true });
    }
  }
}

function relativeWithin(root: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const result = relative(resolve(root), absolute);
  if (!result || result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    if (result === "") throw new Error("edit path must identify a file below the workspace root");
    throw new Error(`edit path escapes workspace root: ${path}`);
  }
  return result;
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
