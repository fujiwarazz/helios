import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CreateSessionOptions, Manifest } from "@helios/kernel";
import type { Logger } from "@helios/ports";
import {
  LocalDataRootLease,
  LocalEditRecordStore,
  LocalMutationCoordinator,
  LocalRepositoryService,
  LocalRuntimeRegistry,
  LocalSessionCatalog,
  LocalWorkspaceCatalog,
  LocalWorkspaceMaterializer,
  WorkspacePaths,
  type BoundSession,
  type SessionLaunchRequest,
  type Workspace,
} from "@helios/workspace";
import type { CliOptions } from "./options";

export interface OpenCliWorkspaceOptions {
  cli: CliOptions;
  cwd: string;
  dataRoot: string;
  manifest: Manifest;
  askQuestion: CreateSessionOptions["askQuestion"];
  signal?: AbortSignal;
  gitTimeoutMs?: number;
  /** Kernel/plugin log sink; the TUI passes one that never writes to stdout. */
  logger?: Logger;
}

export interface CliWorkspaceRuntime {
  readonly bound: BoundSession;
  /**
   * Replaces the active persisted session in this process: preflight the target, release the
   * current runtime, then resume the requested session with its own workspace binding.
   */
  resumeSession(sessionId: string): Promise<BoundSession>;
  close(): Promise<void>;
}

export async function openCliWorkspace(
  options: OpenCliWorkspaceOptions,
): Promise<CliWorkspaceRuntime> {
  const lease = await LocalDataRootLease.acquire(options.dataRoot);
  let registry: LocalRuntimeRegistry | undefined;
  let bound: BoundSession | undefined;
  try {
    const paths = new WorkspacePaths(options.dataRoot);
    const catalog = new LocalWorkspaceCatalog(paths);
    const sessions = new LocalSessionCatalog(paths);
    const legacyRoot = resolve(options.cwd, options.cli.legacyWorkDir ?? ".");
    // Default launch is Code mode on the repository the CLI was started in (pi/codex semantics),
    // so that root must be allowed even when no --code flag is present.
    const codeRoot = options.cli.chat
      ? undefined
      : resolve(options.cwd, options.cli.codePath ?? findRepositoryRoot(options.cwd));
    const allowedRoots = [codeRoot, options.cli.resume ? legacyRoot : undefined].filter(
      (path): path is string => path !== undefined,
    );
    const repositories = new LocalRepositoryService({ catalog, paths, allowedRoots });
    const materializer = new LocalWorkspaceMaterializer({ paths });
    registry = new LocalRuntimeRegistry({
      paths,
      catalog,
      sessions,
      materializer,
      manifest: options.manifest,
      logger: options.logger,
      editRecords: new LocalEditRecordStore(paths),
      mutations: new LocalMutationCoordinator(paths),
      // Local terminal on the user's own machine: the shell is expected, and every session it
      // starts is recorded as audit-incomplete because shell writes are not attributed.
      allowShellTool: true,
    });
    await sessions.reconcileInterrupted();
    await registry.scavengeExpiredDrafts();

    if (options.cli.resume) {
      // 旧格式（pre-Workspace 的裸 .helios/sessions/<id>）不再自动导入：其 turn 日志格式已不被
      // kernel 支持，迁移过来也打不开。直接按"不存在"处理。
      if (!(await sessions.get(options.cli.resume))) {
        throw new Error(`session ${options.cli.resume} does not exist`);
      }
      bound = await registry.resumeSession(options.cli.resume, {
        askQuestion: options.askQuestion,
        materialize: { signal: options.signal, timeoutMs: options.gitTimeoutMs },
      });
    } else {
      const launch = await createLaunchRequest(options, repositories, catalog);
      bound = await registry.createSession(launch, {
        askQuestion: options.askQuestion,
        materialize: { signal: options.signal, timeoutMs: options.gitTimeoutMs },
      });
    }

    let closed = false;
    let current = bound;
    /** True while no live runtime is held: a failed replacement must not be released twice. */
    let released = false;
    const activeRegistry = registry;
    const sessionOptions = {
      askQuestion: options.askQuestion,
      materialize: { signal: options.signal, timeoutMs: options.gitTimeoutMs },
    };
    const releaseCurrent = async (): Promise<void> => {
      if (released) return;
      released = true;
      current.session.cancel();
      await current.session.dispose();
      if (current.binding.runtimeId) {
        await activeRegistry.release(current.binding.runtimeId, current.session.id);
      }
    };
    return {
      get bound() {
        return current;
      },
      resumeSession: async (sessionId: string) => {
        if (closed) throw new Error("runtime 已关闭");
        if (sessionId === current.session.id) throw new Error("该会话已经是当前会话");
        if (!(await sessions.get(sessionId))) {
          throw new Error(`session ${sessionId} does not exist`);
        }
        await releaseCurrent();
        current = await activeRegistry.resumeSession(sessionId, sessionOptions);
        released = false;
        return current;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await releaseCurrent();
        await lease.dispose();
      },
    };
  } catch (error) {
    bound?.session.cancel();
    await bound?.session.dispose().catch(() => undefined);
    if (bound?.binding.runtimeId) {
      await registry?.release(bound.binding.runtimeId, bound.session.id).catch(() => undefined);
    }
    await lease.dispose();
    throw error;
  }
}

async function createLaunchRequest(
  options: OpenCliWorkspaceOptions,
  repositories: LocalRepositoryService,
  catalog: LocalWorkspaceCatalog,
): Promise<SessionLaunchRequest> {
  if (options.cli.chat) return { mode: "chat" };

  const workspace = options.cli.cloneUrl
    ? await repositories.cloneRepository(options.cli.cloneUrl, {
        signal: options.signal,
        timeoutMs: options.gitTimeoutMs,
      })
    : options.cli.workspaceId
      ? undefined
      : await openLocalWorkspace(
          repositories,
          catalog,
          resolve(options.cwd, options.cli.codePath ?? findRepositoryRoot(options.cwd)),
        );
  const workspaceId = workspace?.id ?? options.cli.workspaceId!;
  const selectedWorkspace = workspace ?? (await catalog.get(workspaceId));
  const rootId = selectedWorkspace?.roots[0]?.id;
  return {
    mode: "code",
    workspaceId,
    roots: rootId
      ? [{ rootId, strategy: options.cli.worktree ? "worktree" : "direct" }]
      : undefined,
  };
}

/**
 * Reuses the catalog entry for this directory instead of registering a new Workspace on every
 * launch, so repeated `helios` runs in one repository share memory, sessions, and edit records.
 */
async function openLocalWorkspace(
  repositories: LocalRepositoryService,
  catalog: LocalWorkspaceCatalog,
  path: string,
): Promise<Workspace> {
  const rootPath = await realpath(path);
  const existing = (await catalog.list()).find(
    (candidate) =>
      candidate.kind === "local-directory" &&
      candidate.roots.length === 1 &&
      candidate.roots[0]?.source.type === "local" &&
      candidate.roots[0].source.path === rootPath,
  );
  return existing ?? (await repositories.importLocalDirectory(rootPath));
}

/** Git repository root of the launch directory; falls back to the directory itself. */
function findRepositoryRoot(startDir: string): string {
  let candidate = resolve(startDir);
  while (true) {
    if (existsSync(join(candidate, ".git"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return resolve(startDir);
    candidate = parent;
  }
}
