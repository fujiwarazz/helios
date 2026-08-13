import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { WorkspacePaths } from "./paths";
import { ExecaGitRunner, type GitRunner } from "./repositoryService";
import type {
  MaterializedWorkspace,
  SessionWorkspaceBinding,
  Workspace,
  WorkspaceRoot,
} from "./types";

export interface WorkspaceMaterializer {
  materialize(
    workspace: Workspace,
    binding: SessionWorkspaceBinding,
  ): Promise<MaterializedWorkspace>;
}

export interface LocalWorkspaceMaterializerOptions {
  paths: WorkspacePaths;
  git?: GitRunner;
}

const worktreeLocks = new Map<string, Promise<void>>();

interface WorktreeMetadata {
  schemaVersion: 1;
  materializationId: string;
  reference: string;
  revision?: string;
  workingBranch: string;
}

export class LocalWorkspaceMaterializer implements WorkspaceMaterializer {
  private readonly paths: WorkspacePaths;
  private readonly git: GitRunner;

  constructor(options: LocalWorkspaceMaterializerOptions) {
    this.paths = options.paths;
    this.git = options.git ?? new ExecaGitRunner();
  }

  async materialize(
    workspace: Workspace,
    binding: SessionWorkspaceBinding,
  ): Promise<MaterializedWorkspace> {
    if (workspace.roots.length !== 1 || binding.roots.length !== 1) {
      throw new Error("single-root workspace required during the single-repository MVP");
    }
    if (binding.workspaceId !== workspace.id) {
      throw new Error("workspace binding does not match workspace");
    }

    const root = workspace.roots[0]!;
    const rootBinding = binding.roots[0]!;
    if (rootBinding.rootId !== root.id) throw new Error("workspace root binding does not match root");

    const absolutePath =
      rootBinding.strategy === "direct"
        ? await realpath(this.sourcePath(workspace, root))
        : await this.materializeWorktree(workspace, root, rootBinding);

    return {
      workspaceId: workspace.id,
      primaryDir: absolutePath,
      additionalDirs: [],
      roots: [{ rootId: root.id, absolutePath, readOnly: false }],
    };
  }

  private sourcePath(workspace: Workspace, root: WorkspaceRoot): string {
    switch (root.source.type) {
      case "managed":
        return this.paths.managedRoot(workspace.id);
      case "local":
        return root.source.path;
      case "git":
        return this.paths.repositorySource(root.source.repositoryId);
    }
  }

  private async materializeWorktree(
    workspace: Workspace,
    root: WorkspaceRoot,
    rootBinding: SessionWorkspaceBinding["roots"][number],
  ): Promise<string> {
    if (!root.git) throw new Error("worktree materialization requires a Git root");

    const source = await realpath(this.sourcePath(workspace, root));
    const target = this.paths.worktreeRoot(workspace.id, rootBinding.materializationId, root.id);
    const lockKey = resolve(target);
    return withWorktreeLock(lockKey, async () => {
      const requestedBranch = rootBinding.branch ?? root.git?.defaultBranch;
      const reference = requestedBranch ?? "HEAD";
      const workingBranch = `helios/${rootBinding.materializationId}`;
      const metadataFile = join(dirname(target), "materialization.json");
      if (await pathExists(target)) {
        await this.validateExistingWorktree({
          source,
          target,
          metadataFile,
          materializationId: rootBinding.materializationId,
          reference,
          workingBranch,
          revision: rootBinding.revision,
        });
      } else {
        await mkdir(dirname(target), { recursive: true });
        let created = false;
        try {
          await this.git.run(
            [
              "worktree",
              "add",
              "-b",
              workingBranch,
              target,
              rootBinding.revision ?? reference,
            ],
            { cwd: source },
          );
          created = true;
          const metadata: WorktreeMetadata = {
            schemaVersion: 1,
            materializationId: rootBinding.materializationId,
            reference,
            revision: rootBinding.revision,
            workingBranch,
          };
          await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
        } catch (error) {
          if (created) {
            await this.git
              .run(["worktree", "remove", "--force", target], { cwd: source })
              .catch(() => undefined);
            await this.git
              .run(["branch", "-D", workingBranch], { cwd: source })
              .catch(() => undefined);
          }
          await rm(target, { recursive: true, force: true });
          await rm(metadataFile, { force: true });
          throw error;
        }
      }
      return await realpath(target);
    });
  }

  private async validateExistingWorktree(options: {
    source: string;
    target: string;
    metadataFile: string;
    materializationId: string;
    reference: string;
    workingBranch: string;
    revision?: string;
  }): Promise<void> {
    const listing = await this.git.run(["worktree", "list", "--porcelain"], {
      cwd: options.source,
    });
    const canonicalTarget = await realpath(options.target);
    const listedPaths = await Promise.all(
      parseWorktreePaths(listing.stdout).map(async (path) => {
        try {
          return await realpath(path);
        } catch {
          return resolve(path);
        }
      }),
    );
    const listed = listedPaths.includes(canonicalTarget);
    if (!listed) throw new Error("existing worktree path is not registered with the repository");

    const [sourceCommonDir, targetCommonDir] = await Promise.all([
      this.gitCommonDir(options.source),
      this.gitCommonDir(options.target),
    ]);
    if (sourceCommonDir !== targetCommonDir) {
      throw new Error("existing worktree belongs to a different repository");
    }

    const metadata = await readWorktreeMetadata(options.metadataFile);
    if (
      metadata.materializationId !== options.materializationId ||
      metadata.reference !== options.reference ||
      metadata.revision !== options.revision ||
      metadata.workingBranch !== options.workingBranch
    ) {
      throw new Error("existing worktree does not match requested branch or materialization");
    }

    let branch: string;
    try {
      branch = (
        await this.git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], {
          cwd: options.target,
        })
      ).stdout.trim();
    } catch {
      throw new Error("existing worktree does not match requested branch");
    }
    if (branch !== options.workingBranch) {
      throw new Error(
        `existing worktree branch ${JSON.stringify(branch)} does not match ${JSON.stringify(options.workingBranch)}`,
      );
    }

    if (options.revision) {
      const head = (
        await this.git.run(["rev-parse", "HEAD"], { cwd: options.target })
      ).stdout.trim();
      if (head !== options.revision) {
        throw new Error("existing worktree HEAD does not match requested revision");
      }
    }
  }

  private async gitCommonDir(cwd: string): Promise<string> {
    const output = (await this.git.run(["rev-parse", "--git-common-dir"], { cwd })).stdout.trim();
    return await realpath(isAbsolute(output) ? output : resolve(cwd, output));
  }
}

async function readWorktreeMetadata(path: string): Promise<WorktreeMetadata> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("existing worktree is missing valid materialization metadata");
  }
  if (
    !value ||
    typeof value !== "object" ||
    (value as Partial<WorktreeMetadata>).schemaVersion !== 1 ||
    typeof (value as Partial<WorktreeMetadata>).materializationId !== "string" ||
    typeof (value as Partial<WorktreeMetadata>).reference !== "string" ||
    typeof (value as Partial<WorktreeMetadata>).workingBranch !== "string" ||
    ((value as Partial<WorktreeMetadata>).revision !== undefined &&
      typeof (value as Partial<WorktreeMetadata>).revision !== "string")
  ) {
    throw new Error("existing worktree is missing valid materialization metadata");
  }
  return value as WorktreeMetadata;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseWorktreePaths(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function withWorktreeLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = worktreeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const barrier = previous.catch(() => undefined).then(() => current);
  worktreeLocks.set(key, barrier);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (worktreeLocks.get(key) === barrier) worktreeLocks.delete(key);
  }
}
