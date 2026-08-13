import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "@helios/kernel";
import { serveWorkspaceHostOverWs, type ServeHandle } from "@helios/host";
import {
  LocalDataRootLease,
  LocalEditRecordStore,
  LocalMutationCoordinator,
  LocalRepositoryService,
  LocalRuntimeRegistry,
  LocalSessionCatalog,
  LocalWorkspaceCatalog,
  LocalWorkspaceMaterializer,
  WorkspaceMemoryStore,
  WorkspacePaths,
} from "@helios/workspace";
import { parseWebHostConfig, type WebHostConfig } from "./hostConfig";

const CONFIG_PATH = fileURLToPath(new URL("../../../helios.config.json", import.meta.url));

async function loadManifest(): Promise<Manifest> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const manifest = JSON.parse(raw) as Manifest;
  return {
    plugins: manifest.plugins.map((entry) => ({
      ...entry,
      package: import.meta.resolve(entry.package),
    })),
  };
}

export async function startWebHost(
  config: WebHostConfig,
): Promise<ServeHandle & { dataRoot: string }> {
  const lease = await LocalDataRootLease.acquire(config.dataRoot);
  let handle: ServeHandle | undefined;
  try {
    const manifest = await loadManifest();
    const paths = new WorkspacePaths(config.dataRoot);
    const catalog = new LocalWorkspaceCatalog(paths);
    const sessions = new LocalSessionCatalog(paths);
    const repositories = new LocalRepositoryService({
      catalog,
      paths,
      allowedRoots: config.allowedRoots,
    });
    const materializer = new LocalWorkspaceMaterializer({ paths });
    const edits = new LocalEditRecordStore(paths);
    const mutations = new LocalMutationCoordinator(paths);
    const memory = new WorkspaceMemoryStore(paths);
    void memory;
    const registry = new LocalRuntimeRegistry({
      paths,
      catalog,
      sessions,
      materializer,
      manifest,
      editRecords: edits,
      mutations,
    });
    await sessions.reconcileInterrupted();
    await registry.scavengeExpiredDrafts();

    handle = await serveWorkspaceHostOverWs({
      registry,
      catalog,
      sessions,
      repositories,
      port: config.port,
      host: config.host,
      codeMode: config.codeMode,
      allowLocalImport: config.allowedRoots.length > 0,
    });
    return {
      port: handle.port,
      dataRoot: config.dataRoot,
      close: async () => {
        await handle?.close();
        await lease.dispose();
      },
    };
  } catch (error) {
    await handle?.close();
    await lease.dispose();
    throw error;
  }
}

async function main(): Promise<void> {
  const config = parseWebHostConfig(process.env);
  const handle = await startWebHost(config);
  console.info(
    "helios Workspace Host ready: ws://" + config.host + ":" + handle.port,
  );
  console.info("dataRoot: " + handle.dataRoot);
  console.info(
    config.codeMode
      ? "Code mode enabled (HELIOS_CODE_MODE=1)"
      : "Code mode disabled; set HELIOS_CODE_MODE=1 to enable it",
  );

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
