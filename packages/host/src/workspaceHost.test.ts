import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "@helios/ports";
import { RpcClient, nodeWsClientTransport } from "@helios/protocol";
import {
  LocalRepositoryService,
  LocalRuntimeRegistry,
  LocalSessionCatalog,
  LocalWorkspaceCatalog,
  LocalWorkspaceMaterializer,
  WorkspacePaths,
  type SessionWorkspaceBinding,
  type WorkspaceSummary,
} from "@helios/workspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveWorkspaceHostOverWs, type ServeHandle } from "./index";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("serveWorkspaceHostOverWs", () => {
  let dataRoot: string;
  let allowedRoot: string;
  let paths: WorkspacePaths;
  let catalog: LocalWorkspaceCatalog;
  let sessions: LocalSessionCatalog;
  let repositories: LocalRepositoryService;
  let registry: LocalRuntimeRegistry;
  let handle: ServeHandle;
  const clients: RpcClient[] = [];

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "helios-workspace-host-state-"));
    allowedRoot = await mkdtemp(join(tmpdir(), "helios-workspace-host-root-"));
    paths = new WorkspacePaths(dataRoot);
    catalog = new LocalWorkspaceCatalog(paths);
    sessions = new LocalSessionCatalog(paths);
    repositories = new LocalRepositoryService({ catalog, paths, allowedRoots: [allowedRoot] });
    registry = new LocalRuntimeRegistry({
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
    });
    handle = await serveWorkspaceHostOverWs({
      registry,
      catalog,
      sessions,
      repositories,
      port: 0,
    });
  });

  afterEach(async () => {
    clients.splice(0).forEach((client) => client.close());
    await handle.close();
    await Promise.all(
      [dataRoot, allowedRoot].map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("launches Code from stable ids and exposes safe workspace/session RPC", async () => {
    const local = join(allowedRoot, "repo");
    await mkdir(local);
    const workspace = await repositories.importLocalDirectory(local, "Local repo");
    const launch = {
      mode: "code",
      workspaceId: workspace.id,
      roots: [{ rootId: workspace.roots[0]!.id, strategy: "direct" }],
      primaryDir: "/etc",
    };
    const rpc = connect({ launch });

    const binding = (await rpc.call("session.workspace")) as SessionWorkspaceBinding;
    expect(binding.workspaceId).toBe(workspace.id);
    expect(JSON.stringify(binding)).not.toContain("/etc");
    expect(await rpc.call("sessions.list")).toEqual([]);

    const summaries = (await rpc.call("workspaces.list")) as WorkspaceSummary[];
    expect(summaries).toEqual([
      expect.objectContaining({ id: workspace.id, name: "Local repo" }),
    ]);
    expect(JSON.stringify(summaries)).not.toContain(await realpath(local));

    await rpc.call("sendMessage", { text: "commit session" });
    expect(await rpc.call("sessions.list")).toHaveLength(1);
  });

  it("imports allowlisted local directories through RPC", async () => {
    const local = join(allowedRoot, "imported");
    await mkdir(local);
    const rpc = connect({ launch: { mode: "chat" } });

    const imported = (await rpc.call("workspaces.importLocal", { path: local })) as WorkspaceSummary;

    expect(imported).toMatchObject({ kind: "local-directory", roots: [{ git: false }] });
    await expect(
      rpc.call("workspaces.importLocal", { path: dataRoot }),
    ).rejects.toThrow(/outside allowed roots/i);
  });

  it("releases the runtime reference when the client disconnects", async () => {
    const release = vi.spyOn(registry, "release");
    const rpc = connect({ launch: { mode: "chat" } });
    await rpc.call("sessionId");

    rpc.close();
    await waitFor(() => release.mock.calls.length === 1, 2_000);

    expect(release).toHaveBeenCalledWith(expect.stringMatching(/^runtime_/));
  });

  it("advertises capabilities and disables workspace mutations with Code mode", async () => {
    await handle.close();
    handle = await serveWorkspaceHostOverWs({
      registry,
      catalog,
      sessions,
      repositories,
      port: 0,
      codeMode: false,
      allowLocalImport: false,
    });
    const rpc = connect({ launch: { mode: "chat" } });

    await expect(rpc.call("host.capabilities")).resolves.toEqual({
      codeMode: false,
      localImport: false,
      rollbackMode: "conversation-only",
    });
    await expect(rpc.call("workspaces.clone", { remoteUrl: "git@host:org/repo.git" }))
      .rejects.toThrow(/未知方法|method not found/i);
    await expect(rpc.call("workspaces.importLocal", { path: allowedRoot }))
      .rejects.toThrow(/未知方法|method not found/i);
  });

  function connect(params: { launch?: unknown; resumeSessionId?: string }): RpcClient {
    const query = new URLSearchParams();
    if (params.launch) query.set("launch", JSON.stringify(params.launch));
    if (params.resumeSessionId) query.set("resumeSessionId", params.resumeSessionId);
    const rpc = new RpcClient(() =>
      nodeWsClientTransport(`ws://127.0.0.1:${handle.port}?${query.toString()}`),
    );
    clients.push(rpc);
    return rpc;
  }
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture(name: string): string {
  return fileURLToPath(new URL(`../../kernel/test/fixtures/${name}`, import.meta.url));
}
