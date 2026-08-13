import { resolve } from "node:path";
import type { CreateSessionOptions, Manifest } from "@helios/kernel";
import {
  LegacySessionMigrator,
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
}

export interface CliWorkspaceRuntime {
  bound: BoundSession;
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
    const codeRoot = options.cli.codePath
      ? resolve(options.cwd, options.cli.codePath)
      : undefined;
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
      editRecords: new LocalEditRecordStore(paths),
      mutations: new LocalMutationCoordinator(paths),
    });
    await sessions.reconcileInterrupted();
    await registry.scavengeExpiredDrafts();

    if (options.cli.resume) {
      if (!(await sessions.get(options.cli.resume))) {
        const migrated = await new LegacySessionMigrator({
          paths,
          repositories,
          sessions,
          legacyRoots: [legacyRoot],
        }).migrate(options.cli.resume);
        if (!migrated) {
          throw new Error(`session ${options.cli.resume} does not exist`);
        }
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
    return {
      bound,
      close: async () => {
        if (closed) return;
        closed = true;
        bound?.session.cancel();
        await bound?.session.dispose();
        if (bound?.binding.runtimeId) {
          await registry?.release(bound.binding.runtimeId, bound.session.id);
        }
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
  if (!options.cli.codePath && !options.cli.cloneUrl && !options.cli.workspaceId) {
    return { mode: "chat" };
  }

  const workspace = options.cli.codePath
    ? await repositories.importLocalDirectory(resolve(options.cwd, options.cli.codePath))
    : options.cli.cloneUrl
      ? await repositories.cloneRepository(options.cli.cloneUrl, {
          signal: options.signal,
          timeoutMs: options.gitTimeoutMs,
        })
      : undefined;
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
