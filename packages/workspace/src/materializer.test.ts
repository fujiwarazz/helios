import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalWorkspaceMaterializer } from "./materializer";
import { WorkspacePaths } from "./paths";
import { ExecaGitRunner, type GitRunOptions, type GitRunner } from "./repositoryService";
import type { SessionWorkspaceBinding, Workspace, WorkspaceRoot } from "./types";

describe("LocalWorkspaceMaterializer", () => {
  let dataRoot: string;
  let paths: WorkspacePaths;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "helios-materializer-"));
    paths = new WorkspacePaths(dataRoot);
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("materializes managed, local, and cloned roots directly", async () => {
    const local = join(dataRoot, "local");
    await mkdir(local);
    const managed = workspace("managed-chat", { type: "managed" });
    const cloned = workspace("git-clone", {
      type: "git",
      remoteIdentity: "https://example.com/repo.git",
      repositoryId: "repo_1",
    });
    await mkdir(paths.managedRoot(managed.id), { recursive: true });
    await mkdir(paths.repositorySource("repo_1"), { recursive: true });
    const materializer = new LocalWorkspaceMaterializer({ paths });

    await expect(materializer.materialize(managed, binding(managed, "direct"))).resolves.toMatchObject({
      workspaceId: managed.id,
      primaryDir: await realpath(paths.managedRoot(managed.id)),
      additionalDirs: [],
      roots: [{ rootId: "root_1", readOnly: false }],
    });

    const localWorkspace = workspace("local-directory", { type: "local", path: local });
    await expect(
      materializer.materialize(localWorkspace, binding(localWorkspace, "direct")),
    ).resolves.toMatchObject({ primaryDir: await realpath(local) });
    await expect(
      materializer.materialize(cloned, binding(cloned, "direct")),
    ).resolves.toMatchObject({ primaryDir: await realpath(paths.repositorySource("repo_1")) });
  });

  it("rejects worktree materialization for a non-Git root", async () => {
    const directory = join(dataRoot, "plain");
    await mkdir(directory);
    const target = workspace("local-directory", { type: "local", path: directory });
    const materializer = new LocalWorkspaceMaterializer({ paths });

    await expect(materializer.materialize(target, binding(target, "worktree"))).rejects.toThrow(
      /worktree.*Git/i,
    );
  });

  it("uses the current HEAD when the root has no default branch", async () => {
    const source = await createRepository(join(dataRoot, "source"));
    const target = gitWorkspace(source);
    target.roots[0]!.git = {};
    const materializer = new LocalWorkspaceMaterializer({ paths });
    const sessionBinding = binding(target, "worktree");

    const result = await materializer.materialize(target, sessionBinding);

    expect(result.primaryDir).toBe(
      await realpath(paths.worktreeRoot(target.id, "mat_1", "root_1")),
    );
    expect((await runGit(["rev-parse", "HEAD"], result.primaryDir)).stdout).toBe(
      (await runGit(["rev-parse", "HEAD"], source)).stdout,
    );
  });

  it("serializes concurrent creation for the same physical worktree", async () => {
    const source = await createRepository(join(dataRoot, "source"));
    const target = gitWorkspace(source);
    const git = new CountingGitRunner();
    const materializer = new LocalWorkspaceMaterializer({ paths, git });
    const sessionBinding = binding(target, "worktree");

    const [first, second] = await Promise.all([
      materializer.materialize(target, sessionBinding),
      materializer.materialize(target, sessionBinding),
    ]);

    expect(first.primaryDir).toBe(second.primaryDir);
    expect(git.worktreeAddCalls).toBe(1);
  });

  it("isolates different materialization ids and branches", async () => {
    const source = await createRepository(join(dataRoot, "source"));
    await runGit(["branch", "feature"], source);
    const target = gitWorkspace(source);
    const materializer = new LocalWorkspaceMaterializer({ paths });

    const main = await materializer.materialize(
      target,
      binding(target, "worktree", { materializationId: "mat_main", branch: "main" }),
    );
    const feature = await materializer.materialize(
      target,
      binding(target, "worktree", { materializationId: "mat_feature", branch: "feature" }),
    );

    expect(main.primaryDir).not.toBe(feature.primaryDir);
    expect((await runGit(["rev-parse", "--abbrev-ref", "HEAD"], main.primaryDir)).stdout).toBe(
      "main",
    );
    expect((await runGit(["rev-parse", "--abbrev-ref", "HEAD"], feature.primaryDir)).stdout).toBe(
      "feature",
    );
  });

  it("rejects reuse when an existing worktree does not match the requested branch", async () => {
    const source = await createRepository(join(dataRoot, "source"));
    await runGit(["branch", "feature"], source);
    const target = gitWorkspace(source);
    const materializer = new LocalWorkspaceMaterializer({ paths });
    await materializer.materialize(
      target,
      binding(target, "worktree", { materializationId: "mat_shared", branch: "main" }),
    );

    await expect(
      materializer.materialize(
        target,
        binding(target, "worktree", { materializationId: "mat_shared", branch: "feature" }),
      ),
    ).rejects.toThrow(/existing worktree.*branch/i);
  });

  it("rejects multiple roots during the single-repository MVP", async () => {
    const directory = join(dataRoot, "local");
    await mkdir(directory);
    const target = workspace("local-directory", { type: "local", path: directory });
    target.roots.push({ ...target.roots[0]!, id: "root_2" });
    const sessionBinding = binding(target, "direct");
    sessionBinding.roots.push({
      rootId: "root_2",
      strategy: "direct",
      materializationId: "direct-root_2",
    });

    await expect(
      new LocalWorkspaceMaterializer({ paths }).materialize(target, sessionBinding),
    ).rejects.toThrow(/single-root/i);
  });
});

class CountingGitRunner implements GitRunner {
  private readonly delegate = new ExecaGitRunner();
  worktreeAddCalls = 0;

  run(args: string[], options?: GitRunOptions): Promise<{ stdout: string; stderr: string }> {
    if (args[0] === "worktree" && args[1] === "add") this.worktreeAddCalls += 1;
    return this.delegate.run(args, options);
  }
}

function workspace(kind: Workspace["kind"], source: WorkspaceRoot["source"]): Workspace {
  return {
    id: "ws_1",
    name: "Workspace",
    kind,
    roots: [{ id: "root_1", displayName: "Root", source }],
    createdAt: 1,
    updatedAt: 1,
  };
}

function gitWorkspace(sourcePath: string): Workspace {
  const result = workspace("local-directory", { type: "local", path: sourcePath });
  result.roots[0]!.git = { defaultBranch: "main" };
  return result;
}

function binding(
  target: Workspace,
  strategy: "direct" | "worktree",
  overrides: { materializationId?: string; branch?: string } = {},
): SessionWorkspaceBinding {
  return {
    sessionId: "sess_1",
    mode: "code",
    workspaceId: target.id,
    roots: [
      {
        rootId: target.roots[0]!.id,
        strategy,
        materializationId:
          overrides.materializationId ??
          (strategy === "direct" ? `direct-${target.roots[0]!.id}` : "mat_1"),
        branch: overrides.branch,
      },
    ],
    createdAt: 1,
  };
}

async function createRepository(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await runGit(["init", "-b", "main"], path);
  await runGit(["config", "user.email", "helios@example.com"], path);
  await runGit(["config", "user.name", "Helios Test"], path);
  await writeFile(join(path, "README.md"), "initial\n", "utf8");
  await runGit(["add", "README.md"], path);
  await runGit(["commit", "-m", "initial"], path);
  await runGit(["checkout", "--detach"], path);
  return await realpath(path);
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new ExecaGitRunner().run(args, { cwd });
}
