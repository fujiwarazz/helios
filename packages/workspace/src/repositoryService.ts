import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative } from "node:path";
import { execa } from "execa";
import type { WorkspaceCatalog } from "./catalog";
import { WorkspacePaths } from "./paths";
import type { Workspace } from "./types";

const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export interface GitRunOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GitRunner {
  run(args: string[], options?: GitRunOptions): Promise<{ stdout: string; stderr: string }>;
}

export interface RepositoryService {
  importLocalDirectory(path: string, name?: string): Promise<Workspace>;
  cloneRepository(
    remoteUrl: string,
    options?: { name?: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Workspace>;
  inspectGit(path: string): Promise<{ repoRoot: string; defaultBranch?: string } | undefined>;
}

export interface LocalRepositoryServiceOptions {
  catalog: WorkspaceCatalog;
  paths: WorkspacePaths;
  allowedRoots: string[];
  git?: GitRunner;
  idFactory?: (prefix: "ws" | "root" | "repo") => string;
  now?: () => number;
}

export class ExecaGitRunner implements GitRunner {
  async run(args: string[], options: GitRunOptions = {}): Promise<{
    stdout: string;
    stderr: string;
  }> {
    const result = await execa("git", args, {
      cancelSignal: options.signal,
      cleanup: true,
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      reject: true,
      shell: false,
      timeout: options.timeoutMs,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }
}

export class LocalRepositoryService implements RepositoryService {
  private readonly catalog: WorkspaceCatalog;
  private readonly paths: WorkspacePaths;
  private readonly allowedRoots: string[];
  private readonly git: GitRunner;
  private readonly idFactory: (prefix: "ws" | "root" | "repo") => string;
  private readonly now: () => number;

  constructor(options: LocalRepositoryServiceOptions) {
    this.catalog = options.catalog;
    this.paths = options.paths;
    this.allowedRoots = options.allowedRoots;
    this.git = options.git ?? new ExecaGitRunner();
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.now = options.now ?? Date.now;
  }

  async importLocalDirectory(path: string, name?: string): Promise<Workspace> {
    const selectedPath = await realpath(path);
    await this.assertAllowed(selectedPath);

    const git = await this.inspectGit(selectedPath);
    const rootPath = git?.repoRoot ?? selectedPath;
    await this.assertAllowed(rootPath);

    const timestamp = this.now();
    const workspace: Workspace = {
      id: this.idFactory("ws"),
      name: name ?? basename(rootPath),
      kind: "local-directory",
      roots: [
        {
          id: this.idFactory("root"),
          displayName: name ?? basename(rootPath),
          source: { type: "local", path: rootPath },
          ...(git ? { git: { defaultBranch: git.defaultBranch } } : {}),
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.catalog.put(workspace);
    return workspace;
  }

  async cloneRepository(
    remoteUrl: string,
    options: { name?: string; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Workspace> {
    const remoteIdentity = normalizeRemoteIdentity(remoteUrl);
    const repositoryId = this.idFactory("repo");
    const workspaceId = this.idFactory("ws");
    const rootId = this.idFactory("root");
    const destination = this.paths.repositorySource(repositoryId);
    const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
    let promoted = false;

    await mkdir(dirname(destination), { recursive: true });
    try {
      await this.git.run(["clone", "--", remoteUrl, temporary], {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      });
      const git = await this.inspectGit(temporary);
      if (!git) throw new Error("cloned repository is not a Git work tree");

      await rename(temporary, destination);
      promoted = true;

      const displayName = options.name ?? repositoryName(remoteIdentity);
      const timestamp = this.now();
      const workspace: Workspace = {
        id: workspaceId,
        name: displayName,
        kind: "git-clone",
        roots: [
          {
            id: rootId,
            displayName,
            source: { type: "git", remoteIdentity, repositoryId },
            git: { defaultBranch: git.defaultBranch },
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.catalog.put(workspace);
      return workspace;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (promoted) await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async inspectGit(
    path: string,
  ): Promise<{ repoRoot: string; defaultBranch?: string } | undefined> {
    let repoRoot: string;
    try {
      const result = await this.git.run(["rev-parse", "--show-toplevel"], { cwd: path });
      repoRoot = await realpath(result.stdout.trim());
    } catch {
      return undefined;
    }

    let defaultBranch: string | undefined;
    try {
      const result = await this.git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], {
        cwd: repoRoot,
      });
      defaultBranch = result.stdout.trim() || undefined;
    } catch {
      defaultBranch = undefined;
    }
    return { repoRoot, defaultBranch };
  }

  private async assertAllowed(candidate: string): Promise<void> {
    const roots = await Promise.all(this.allowedRoots.map((root) => realpath(root)));
    if (!roots.some((root) => isWithin(root, candidate))) {
      throw new Error(`path is outside allowed roots: ${candidate}`);
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function normalizeRemoteIdentity(remoteUrl: string): string {
  if (/^[^@\s/:]+@[^:\s]+:.+/.test(remoteUrl)) return remoteUrl;

  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new Error("remote must be an HTTPS, SSH, or scp-like Git URL");
  }

  if (parsed.protocol === "https:") {
    if (parsed.username || parsed.password) {
      throw new Error("HTTPS Git URL must not contain credentials or userinfo");
    }
  } else if (parsed.protocol === "ssh:") {
    if (parsed.password) throw new Error("SSH Git URL must not contain a password");
  } else {
    throw new Error("remote must use HTTPS or SSH");
  }

  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function repositoryName(remoteIdentity: string): string {
  const withoutQuery = remoteIdentity.split(/[?#]/, 1)[0] ?? remoteIdentity;
  const segment = withoutQuery.split(/[/:]/).filter(Boolean).at(-1) ?? "Repository";
  return segment.replace(/\.git$/, "") || "Repository";
}
