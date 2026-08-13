import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalWorkspaceCatalog } from "./catalog";
import { WorkspacePaths } from "./paths";
import {
  LocalRepositoryService,
  type GitRunOptions,
  type GitRunner,
} from "./repositoryService";

describe("LocalRepositoryService", () => {
  let dataRoot: string;
  let allowedRoot: string;
  let outsideRoot: string;
  let paths: WorkspacePaths;
  let catalog: LocalWorkspaceCatalog;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "helios-repository-state-"));
    allowedRoot = await mkdtemp(join(tmpdir(), "helios-repository-allowed-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "helios-repository-outside-"));
    paths = new WorkspacePaths(dataRoot);
    let counter = 0;
    catalog = new LocalWorkspaceCatalog(paths, {
      idFactory: (prefix) => `${prefix}_catalog_${counter++}`,
      now: () => 10,
    });
  });

  afterEach(async () => {
    await Promise.all(
      [dataRoot, allowedRoot, outsideRoot].map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("imports a real local git repository and normalizes a nested selection to its root", async () => {
    const repo = join(allowedRoot, "repo");
    const nested = join(repo, "src");
    await mkdir(nested, { recursive: true });
    await runGit(["init", repo]);
    const service = new LocalRepositoryService({
      catalog,
      paths,
      allowedRoots: [allowedRoot],
      idFactory: fixedIds(),
      now: () => 20,
    });

    const imported = await service.importLocalDirectory(nested, "Local repo");

    expect(imported.kind).toBe("local-directory");
    expect(imported.roots[0]?.source).toEqual({ type: "local", path: await realpath(repo) });
    expect(imported.roots[0]?.git?.defaultBranch).toMatch(/^(main|master)$/);
    await expect(catalog.get(imported.id)).resolves.toEqual(imported);
  });

  it("allows an unversioned directory for direct materialization", async () => {
    const directory = join(allowedRoot, "plain");
    await mkdir(directory);
    const service = new LocalRepositoryService({
      catalog,
      paths,
      allowedRoots: [allowedRoot],
      idFactory: fixedIds(),
    });

    const imported = await service.importLocalDirectory(directory);

    expect(imported.roots[0]?.source).toEqual({ type: "local", path: await realpath(directory) });
    expect(imported.roots[0]?.git).toBeUndefined();
  });

  it("rejects paths outside allowed roots after resolving symlinks", async () => {
    const link = join(allowedRoot, "escape");
    await symlink(outsideRoot, link);
    const service = new LocalRepositoryService({
      catalog,
      paths,
      allowedRoots: [allowedRoot],
      idFactory: fixedIds(),
    });

    await expect(service.importLocalDirectory(outsideRoot)).rejects.toThrow(/outside allowed roots/i);
    await expect(service.importLocalDirectory(link)).rejects.toThrow(/outside allowed roots/i);
  });

  it.each([
    ["https://github.com/org/repo.git", "https://github.com/org/repo.git"],
    ["ssh://git@github.com/org/repo.git", "ssh://git@github.com/org/repo.git"],
    ["git@github.com:org/repo.git", "git@github.com:org/repo.git"],
  ])("clones %s without persisting credentials", async (remoteUrl, remoteIdentity) => {
    const git = new FakeGitRunner();
    const service = new LocalRepositoryService({
      catalog,
      paths,
      allowedRoots: [allowedRoot],
      git,
      idFactory: fixedIds(),
      now: () => 30,
    });
    const signal = new AbortController().signal;

    const cloned = await service.cloneRepository(remoteUrl, {
      name: "Cloned repo",
      signal,
      timeoutMs: 1234,
    });

    expect(git.calls[0]).toEqual({
      args: ["clone", "--", remoteUrl, expect.stringContaining(".tmp-")],
      options: { signal, timeoutMs: 1234 },
    });
    expect(cloned.roots[0]?.source).toEqual({
      type: "git",
      remoteIdentity,
      repositoryId: "repo_fixed",
    });
    expect(cloned.roots[0]?.git).toEqual({ defaultBranch: "main" });
    await expect(catalog.get(cloned.id)).resolves.toEqual(cloned);
  });

  it.each([
    "https://token@github.com/org/repo.git",
    "https://user:password@github.com/org/repo.git",
    "ssh://git:password@github.com/org/repo.git",
  ])("rejects credential-bearing URL %s before invoking git", async (remoteUrl) => {
    const git = new FakeGitRunner();
    const service = new LocalRepositoryService({
      catalog,
      paths,
      allowedRoots: [allowedRoot],
      git,
      idFactory: fixedIds(),
    });

    await expect(service.cloneRepository(remoteUrl)).rejects.toThrow(/credentials|userinfo|password/i);
    expect(git.calls).toEqual([]);
    await expect(catalog.list()).resolves.toEqual([]);
  });

  it("cleans partial clone state when git fails", async () => {
    const git: GitRunner = {
      run: vi.fn().mockRejectedValue(new Error("clone failed")),
    };
    const service = new LocalRepositoryService({
      catalog,
      paths,
      allowedRoots: [allowedRoot],
      git,
      idFactory: fixedIds(),
    });

    await expect(service.cloneRepository("https://github.com/org/repo.git")).rejects.toThrow(
      "clone failed",
    );
    await expect(readFile(paths.workspaceFile("ws_fixed"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(paths.repositorySource("repo_fixed"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

class FakeGitRunner implements GitRunner {
  readonly calls: Array<{ args: string[]; options?: GitRunOptions }> = [];

  async run(args: string[], options?: GitRunOptions): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ args, options });
    if (args[0] === "clone") {
      await mkdir(args[args.length - 1]!, { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { stdout: options?.cwd ?? "", stderr: "" };
    }
    if (args[0] === "symbolic-ref") return { stdout: "main", stderr: "" };
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  }
}

function fixedIds(): (prefix: "ws" | "root" | "repo") => string {
  return (prefix) => `${prefix}_fixed`;
}

async function runGit(args: string[]): Promise<void> {
  const { execa } = await import("execa");
  await execa("git", args, { reject: true });
}
