import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AskQuestionRequest, AskQuestionResponse, Logger } from "@helios/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalWorkspaceCatalog } from "./catalog";
import { LocalWorkspaceMaterializer } from "./materializer";
import { WorkspacePaths } from "./paths";
import { LocalRepositoryService } from "./repositoryService";
import { LocalRuntimeRegistry } from "./runtimeRegistry";
import { LocalSessionCatalog } from "./sessionCatalog";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const noAsk = async (_request: AskQuestionRequest): Promise<AskQuestionResponse> => ({
  answers: ["ok"],
});

describe("LocalRuntimeRegistry", () => {
  let dataRoot: string;
  let allowedRoot: string;
  let paths: WorkspacePaths;
  let catalog: LocalWorkspaceCatalog;
  let sessions: LocalSessionCatalog;
  let repositories: LocalRepositoryService;
  let now: number;
  let nextId: number;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "helios-runtime-state-"));
    allowedRoot = await mkdtemp(join(tmpdir(), "helios-runtime-workspace-"));
    paths = new WorkspacePaths(dataRoot);
    catalog = new LocalWorkspaceCatalog(paths);
    sessions = new LocalSessionCatalog(paths);
    repositories = new LocalRepositoryService({ catalog, paths, allowedRoots: [allowedRoot] });
    now = 100;
    nextId = 0;
  });

  afterEach(async () => {
    await Promise.all(
      [dataRoot, allowedRoot].map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("creates an unlisted Chat draft and atomically commits its SessionRecord on first send", async () => {
    const registry = createRegistry();

    const bound = await registry.createSession({ mode: "chat" }, { askQuestion: noAsk });

    expect(await sessions.list()).toEqual([]);
    expect(bound.binding.mode).toBe("chat");
    expect(bound.materialized.primaryDir).toBe(
      await realpath(paths.managedRoot(bound.binding.workspaceId)),
    );

    await bound.session.sendMessage("first message");
    expect(await sessions.get(bound.session.id)).toMatchObject({
      state: "idle",
      meta: { title: "first message" },
      binding: { workspaceId: bound.binding.workspaceId },
    });
  });

  it("reuses direct runtimes and disposes the Kernel after the final release", async () => {
    const local = join(allowedRoot, "repo");
    await mkdir(local);
    const workspace = await repositories.importLocalDirectory(local);
    const registry = createRegistry();
    const launch = {
      mode: "code" as const,
      workspaceId: workspace.id,
      roots: [{ rootId: workspace.roots[0]!.id, strategy: "direct" as const }],
    };

    const first = await registry.createSession(launch, { askQuestion: noAsk });
    const second = await registry.createSession(launch, { askQuestion: noAsk });
    expect(second.kernel).toBe(first.kernel);

    await registry.release(first.binding.runtimeId!);
    await registry.release(second.binding.runtimeId!);
    const third = await registry.createSession(launch, { askQuestion: noAsk });
    expect(third.kernel).not.toBe(first.kernel);
  });

  it("resumes from the persisted binding rather than process.cwd", async () => {
    const local = join(allowedRoot, "repo");
    await mkdir(local);
    const workspace = await repositories.importLocalDirectory(local);
    const registry = createRegistry();
    const created = await registry.createSession(
      {
        mode: "code",
        workspaceId: workspace.id,
        roots: [{ rootId: workspace.roots[0]!.id, strategy: "direct" }],
      },
      { askQuestion: noAsk },
    );
    await created.session.sendMessage("persist binding");
    await registry.release(created.binding.runtimeId!);

    const resumed = await registry.resumeSession(created.session.id, { askQuestion: noAsk });

    expect(resumed.materialized.primaryDir).toBe(await realpath(local));
    expect(resumed.binding.workspaceId).toBe(workspace.id);
    expect(resumed.session.getHistory()).not.toEqual([]);
  });

  it("returns a structured error when a persisted local root is unavailable", async () => {
    const local = join(allowedRoot, "missing-repo");
    await mkdir(local);
    const workspace = await repositories.importLocalDirectory(local);
    await rm(local, { recursive: true });

    await expect(
      createRegistry().createSession(
        {
          mode: "code",
          workspaceId: workspace.id,
          roots: [{ rootId: workspace.roots[0]!.id, strategy: "direct" }],
        },
        { askQuestion: noAsk },
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_UNAVAILABLE" });
  });

  it("scavenges only expired uncommitted Chat drafts", async () => {
    const registry = createRegistry();
    const draft = await registry.createSession({ mode: "chat" }, { askQuestion: noAsk });
    const draftRoot = paths.managedRoot(draft.binding.workspaceId);
    await registry.release(draft.binding.runtimeId!);

    now = 1_000;
    await expect(registry.scavengeExpiredDrafts()).resolves.toBe(1);
    await expect(access(draftRoot)).rejects.toBeDefined();

    const committed = await registry.createSession({ mode: "chat" }, { askQuestion: noAsk });
    const committedRoot = paths.managedRoot(committed.binding.workspaceId);
    await committed.session.sendMessage("keep me");
    await registry.release(committed.binding.runtimeId!);
    now = 2_000;

    await expect(registry.scavengeExpiredDrafts()).resolves.toBe(0);
    await expect(access(committedRoot)).resolves.toBeUndefined();
  });

  function createRegistry(): LocalRuntimeRegistry {
    return new LocalRuntimeRegistry({
      paths,
      catalog,
      sessions,
      materializer: new LocalWorkspaceMaterializer({ paths }),
      manifest: {
        plugins: [
          { port: "FileSystemPort", package: "@helios/fs-node" },
          { port: "LLMProvider", package: fixture("mockLlmTextOnly.ts") },
        ],
      },
      logger: silent,
      now: () => now,
      draftTtlMs: 50,
      idFactory: (prefix) => `${prefix}_${nextId++}`,
    });
  }
});

function fixture(name: string): string {
  return fileURLToPath(new URL(`../../kernel/test/fixtures/${name}`, import.meta.url));
}
