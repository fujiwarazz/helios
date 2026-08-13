import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "@helios/kernel";
import {
  serveWorkspaceHostOverElectronIpc,
  type ElectronConnectRequest,
} from "@helios/host";
import type { ElectronIpcBridge } from "@helios/protocol";
import type { Disposable } from "@helios/ports";
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
import { selectAndImportDirectory } from "./directoryDialog";
import { assertTrustedIpcEvent } from "./ipcSecurity";

const CONFIG_PATH = fileURLToPath(new URL("../../../helios.config.json", import.meta.url));
const DEV_SERVER_URL = process.env.HELIOS_ELECTRON_DEV_URL ?? "http://localhost:5174";
const DIST_INDEX = fileURLToPath(new URL("../dist/index.html", import.meta.url));
const DATA_ROOT = resolve(process.env.HELIOS_DATA_ROOT ?? join(homedir(), ".helios"));
const CODE_MODE = process.env.HELIOS_CODE_MODE === "1";

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

function createMainBridge(win: BrowserWindow): ElectronIpcBridge {
  return {
    send(connectionId, data) {
      win.webContents.send("helios:message", { connectionId, data });
    },
    onMessage(cb) {
      const listener = (event: IpcMainEvent, payload: { connectionId: string; data: string }) => {
        try {
          assertTrustedIpcEvent(event, win);
          cb(payload.connectionId, payload.data);
        } catch {
          return;
        }
      };
      ipcMain.on("helios:message", listener);
      return { dispose: () => ipcMain.removeListener("helios:message", listener) };
    },
    onClose(cb) {
      const listener = (event: IpcMainEvent, payload: { connectionId: string }) => {
        try {
          assertTrustedIpcEvent(event, win);
          cb(payload.connectionId);
        } catch {
          return;
        }
      };
      ipcMain.on("helios:close", listener);
      return { dispose: () => ipcMain.removeListener("helios:close", listener) };
    },
    close(connectionId) {
      win.webContents.send("helios:close", { connectionId });
    },
  };
}

function onConnect(
  win: BrowserWindow,
  handler: (request: ElectronConnectRequest) => Promise<void>,
): Disposable {
  const listener = (event: IpcMainInvokeEvent, request: ElectronConnectRequest) => {
    assertTrustedIpcEvent(event, win);
    return handler(request);
  };
  ipcMain.handle("helios:connect", listener);
  return { dispose: () => ipcMain.removeHandler("helios:connect") };
}

async function createWindow(): Promise<void> {
  const lease = await LocalDataRootLease.acquire(DATA_ROOT);
  let host: { dispose(): void } | undefined;
  let directoryHandlerRegistered = false;
  try {
    const manifest = await loadManifest();
    const paths = new WorkspacePaths(DATA_ROOT);
    const catalog = new LocalWorkspaceCatalog(paths);
    const sessions = new LocalSessionCatalog(paths);
    const repositories = new LocalRepositoryService({ catalog, paths, allowedRoots: [] });
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

    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        preload: fileURLToPath(new URL("../dist-electron/preload.cjs", import.meta.url)),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    host = serveWorkspaceHostOverElectronIpc({
      registry,
      catalog,
      sessions,
      repositories,
      bridge: createMainBridge(win),
      onConnect: (handler) => onConnect(win, handler),
      codeMode: CODE_MODE,
      allowLocalImport: false,
    });

    if (CODE_MODE) {
      ipcMain.handle("helios:select-and-import-directory", async (event) => {
        assertTrustedIpcEvent(event, win);
        return selectAndImportDirectory(
          {
            showOpenDialog: async (_window, options) =>
              dialog.showOpenDialog(win, options),
          },
          win,
          {
            importLocalDirectory: async (path) => {
              const authorizedRepositories = new LocalRepositoryService({
                catalog,
                paths,
                allowedRoots: [path],
              });
              return authorizedRepositories.importLocalDirectory(path);
            },
          },
        );
      });
      directoryHandlerRegistered = true;
    }

    let closed = false;
    win.on("closed", () => {
      if (closed) return;
      closed = true;
      if (directoryHandlerRegistered) {
        ipcMain.removeHandler("helios:select-and-import-directory");
      }
      host?.dispose();
      host = undefined;
      void lease.dispose();
    });

    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    if (existsSync(DIST_INDEX)) await win.loadFile(DIST_INDEX);
    else await win.loadURL(DEV_SERVER_URL);
    const rendererUrl = win.webContents.getURL();
    win.webContents.on("will-navigate", (event, url) => {
      if (url !== rendererUrl) event.preventDefault();
    });
    console.info(
      "helios Electron Workspace Host ready; Code mode " + (CODE_MODE ? "enabled" : "disabled"),
    );
  } catch (error) {
    if (directoryHandlerRegistered) {
      ipcMain.removeHandler("helios:select-and-import-directory");
    }
    host?.dispose();
    await lease.dispose();
    throw error;
  }
}

void app.whenReady().then(createWindow).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  app.quit();
});
