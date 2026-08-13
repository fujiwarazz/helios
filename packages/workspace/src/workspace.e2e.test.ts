import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AskQuestionRequest, AskQuestionResponse, Logger } from "@helios/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalWorkspaceCatalog } from "./catalog";
import { LocalDataRootLease } from "./dataRootLease";
import { LocalEditRecordStore } from "./editRecordStore";
import { LocalWorkspaceMaterializer } from "./materializer";
import { LocalMutationCoordinator } from "./mutationCoordinator";
import { WorkspacePaths } from "./paths";
import { ExecaGitRunner, LocalRepositoryService } from "./repositoryService";
import { LocalRuntimeRegistry } from "./runtimeRegistry";
import { LocalSessionCatalog } from "./sessionCatalog";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const noAsk = async (_request: AskQuestionRequest): Promise<AskQuestionResponse> => ({
  answers: [],
});

describe("Workspace platform end to end", () => {
  let dataRoot: string;
  let allowedRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "helios-workspace-e2e-data-"));
    allowedRoot = await mkdtemp(join(tmpdir(), "helios-workspace-e2e-root-"));
  });

  afterEach(async () => {
    await Promise.all(
      [dataRoot, allowedRoot].map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("keeps Chat, direct, and worktree files and session audit data in their intended scopes", async () => {
    const paths = new WorkspacePaths(dataRoot);
    const catalog = new LocalWorkspaceCatalog(paths);
    const sessions = new LocalSessionCatalog(paths);
    const edits = new LocalEditRecordStore(paths);
    const repositories = new LocalRepositoryService({
      paths,
      catalog,
      allowedRoots: [allowedRoot],
    });
    const registry = new LocalRuntimeRegistry({
      paths,
      catalog,
      sessions,
      materializer: new LocalWorkspaceMaterializer({ paths }),
      editRecords: edits,
      mutations: new LocalMutationCoordinator(paths),
      manifest: {
        plugins: [
          { port: "FileSystemPort", package: "@helios/fs-node" },
          { port: "LLMProvider", package: fixture("mockLlmWrite.ts") },
        ],
      },
      logger: silent,
    });

    const chat = await registry.createSession({ mode: "chat" }, { askQuestion: noAsk });
    await chat.session.sendMessage("create a chat artifact");
    await expect(
      readFile(join(paths.managedRoot(chat.binding.workspaceId), "roll.txt"), "utf8"),
    ).resolves.toBe("after-turn\n");

    const repository = await createRepository(join(allowedRoot, "repo"));
    const workspace = await repositories.importLocalDirectory(repository);
    const rootId = workspace.roots[0]!.id;
    const direct = await registry.createSession(
      {
        mode: "code",
        workspaceId: workspace.id,
        roots: [{ rootId, strategy: "direct" }],
      },
      { askQuestion: noAsk },
    );
    await direct.session.sendMessage("edit directly");
    await expect(readFile(join(repository, "roll.txt"), "utf8")).resolves.toBe("after-turn\n");
    await writeFile(join(repository, "roll.txt"), "outside-change\n", "utf8");

    const worktree = await registry.createSession(
      {
        mode: "code",
        workspaceId: workspace.id,
        roots: [{ rootId, strategy: "worktree", branch: "main" }],
      },
      { askQuestion: noAsk },
    );
    await worktree.session.sendMessage("edit in an isolated worktree");
    await expect(readFile(join(worktree.materialized.primaryDir, "roll.txt"), "utf8")).resolves.toBe(
      "after-turn\n",
    );
    await expect(readFile(join(repository, "roll.txt"), "utf8")).resolves.toBe(
      "outside-change\n",
    );
    expect(
      (
        await new ExecaGitRunner().run(["branch", "--show-current"], {
          cwd: worktree.materialized.primaryDir,
        })
      ).stdout,
    ).toMatch(/^helios\/mat_/);

    expect(await sessions.list()).toHaveLength(3);
    expect(await edits.list(chat.session.id)).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        workspaceId: chat.binding.workspaceId,
        relativePath: "roll.txt",
      }),
    ]);
    expect(await edits.list(direct.session.id)).toEqual([
      expect.objectContaining({ workspaceId: workspace.id, rootId, relativePath: "roll.txt" }),
    ]);
    expect(await edits.list(worktree.session.id)).toEqual([
      expect.objectContaining({ workspaceId: workspace.id, rootId, relativePath: "roll.txt" }),
    ]);

    await registry.release(direct.binding.runtimeId!);
    const resumed = await registry.resumeSession(direct.session.id, { askQuestion: noAsk });
    expect(resumed.materialized.primaryDir).toBe(await realpath(repository));
    expect(resumed.binding.workspaceId).toBe(workspace.id);

    for (const bound of [chat, worktree, resumed]) {
      await registry.release(bound.binding.runtimeId!);
    }
    await expect(access(paths.sessionRecord(chat.session.id))).resolves.toBeUndefined();
  });

  it("prevents two local hosts from mutating the same data root", async () => {
    const first = await LocalDataRootLease.acquire(dataRoot);
    try {
      await expect(LocalDataRootLease.acquire(dataRoot)).rejects.toThrow(/already in use/i);
    } finally {
      await first.dispose();
    }
    const next = await LocalDataRootLease.acquire(dataRoot);
    await next.dispose();
  });
});

async function createRepository(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  const git = new ExecaGitRunner();
  await git.run(["init", "-b", "main"], { cwd: path });
  await git.run(["config", "user.email", "helios@example.com"], { cwd: path });
  await git.run(["config", "user.name", "Helios Test"], { cwd: path });
  await writeFile(join(path, "README.md"), "initial\n", "utf8");
  await git.run(["add", "README.md"], { cwd: path });
  await git.run(["commit", "-m", "initial"], { cwd: path });
  return await realpath(path);
}

function fixture(name: string): string {
  return fileURLToPath(new URL(`../../kernel/test/fixtures/${name}`, import.meta.url));
}
