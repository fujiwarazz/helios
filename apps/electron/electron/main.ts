// ============================================================================
// apps/electron/electron/main.ts
// Electron 主进程:起 Kernel(进程内直连,不监听端口)+ 用 ElectronIpcBridge 包一层
// ipcMain/webContents + serveKernelOverElectronIpc 绑定连接 + 建窗口加载 renderer。
// 对应 apps/web/server/host.ts 的角色,只是传输从 WS 换成 Electron 原生 IPC。
//
// ⚠️ main.ts 必须经 tsx 加载运行(见 package.json scripts 里的 `NODE_OPTIONS=--import=tsx`),
// 不能用 esbuild 提前打包成纯 JS：kernel 的 pluginLoader 会在运行时对 manifest 里的每个插件
// 包（如 @helios/fs-node、@helios/llm-openai）做动态 `import(具体路径)`，这些包的 package.json
// "exports" 直接指向源码 .ts（仓库统一约定，不预编译）。esbuild 打包只能处理打包时静态可分析的
// import，这种运行时按字符串路径动态 import 的场景处理不了；tsx 给整个 Node 进程注册一次性的
// ".ts 实时转译"钩子，之后所有动态 import（包括这些插件包）都会经过它——跟 apps/web 用
// `tsx server/host.ts` 起宿主进程是同一个道理。
//
// ⚠️ 但 preload.ts 反过来必须提前用 esbuild 编译成 `.cjs`（见 package.json 的 build:preload），
// **不能**像 main.ts 一样指望 tsx：Electron 加载 preload 脚本走的是它自己内部一套 require 机制，
// 不经过 `--import` 注册的钩子（实测：main.ts 里的 TS import 正常跑，preload.ts 原样引用会报
// "Cannot use import statement outside a module"）。preload.ts 本身不依赖 kernel 运行时动态 import
// .ts 插件包这套机制（只 import "electron"），esbuild 打包对它完全安全，不会碰到 main.ts 那两个坑。
// ============================================================================

import { app, BrowserWindow, ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Kernel, type Manifest } from "@helios/kernel";
import { serveKernelOverElectronIpc, type ElectronConnectRequest } from "@helios/host";
import type { ElectronIpcBridge } from "@helios/protocol";
import type { Disposable } from "@helios/ports";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL("../../../helios.config.json", import.meta.url));
const DEV_SERVER_URL = process.env.HELIOS_ELECTRON_DEV_URL ?? "http://localhost:5174";
// `pnpm build` 产出的 vite 静态页;存在即视为"已构建产物可用",不依赖 `app.isPackaged`
// (只有 electron-builder 之类的真打包工具才会把它置 true——本次范围内没有接那一层)。
const DIST_INDEX = fileURLToPath(new URL("../dist/index.html", import.meta.url));

async function loadManifest(): Promise<Manifest> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  return JSON.parse(raw) as Manifest;
}

/**
 * 把单窗口的 ipcMain/webContents 包成 @helios/protocol 认识的 ElectronIpcBridge。
 * 简化:只支持单窗口(本次范围内不做多窗口),多条逻辑连接靠 connectionId 在这一个
 * 物理 IPC 通道上分拣(见 electronMainTransport 的多路复用说明)。
 */
function createMainBridge(win: BrowserWindow): ElectronIpcBridge {
  return {
    send(connectionId, data) {
      win.webContents.send("helios:message", { connectionId, data });
    },
    onMessage(cb) {
      const listener = (_event: IpcMainEvent, payload: { connectionId: string; data: string }) =>
        cb(payload.connectionId, payload.data);
      ipcMain.on("helios:message", listener);
      return { dispose: () => ipcMain.removeListener("helios:message", listener) };
    },
    onClose(cb) {
      const listener = (_event: IpcMainEvent, payload: { connectionId: string }) => cb(payload.connectionId);
      ipcMain.on("helios:close", listener);
      return { dispose: () => ipcMain.removeListener("helios:close", listener) };
    },
    close(connectionId) {
      win.webContents.send("helios:close", { connectionId });
    },
  };
}

/** 接 `ipcMain.handle('helios:connect', ...)`:renderer 的 connect() 等这个 handle 的 ack 才返回。 */
function onConnect(handler: (req: ElectronConnectRequest) => Promise<void>): Disposable {
  const listener = (_event: IpcMainInvokeEvent, req: ElectronConnectRequest) => handler(req);
  ipcMain.handle("helios:connect", listener);
  return { dispose: () => ipcMain.removeHandler("helios:connect") };
}

async function createWindow(): Promise<void> {
  const manifest = await loadManifest();
  const kernel = new Kernel({
    workDir: REPO_ROOT,
    manifest,
    llmOptions: { provider: "openai" },
    // 裸包名从本 app 依赖解析(manifest 里的 @helios/* 是 @helios/electron 的 workspace 依赖)。
    resolvePackage: (spec) => import.meta.resolve(spec),
  });
  await kernel.start();
  console.info(`helios electron 主进程就绪：工具=[${kernel.listTools().join(", ")}]`);

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: fileURLToPath(new URL("../dist-electron/preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox 保持默认(true)：preload.cjs 只 require("electron")(沙箱允许的白名单模块之一),
      // 不需要放宽沙箱换 Node 全量能力。
    },
  });

  const bridge = createMainBridge(win);
  const handle = serveKernelOverElectronIpc({ kernel, bridge, onConnect });
  win.on("closed", () => handle.dispose());

  if (existsSync(DIST_INDEX)) {
    await win.loadFile(DIST_INDEX); // 生产:build 产物存在,直接读静态文件,不用起 vite
  } else {
    await win.loadURL(DEV_SERVER_URL); // 开发:没有 build 产物,连 vite dev server
  }
}

void app.whenReady().then(() => {
  void createWindow();
});

app.on("window-all-closed", () => {
  // 简化:不做 macOS "点 dock 图标重开窗口"那套多窗口生命周期,统一退出。
  app.quit();
});
