// ============================================================================
// apps/electron/electron/preload.ts
// contextBridge 暴露渲染进程需要的最小 IPC 面(ElectronIpcBridge + connect)。
// 编译成 CJS(见 package.json build:electron):preload 传统上用 CJS 更省心,
// 避免 ESM 在 sandbox/contextIsolation 下的额外限制。
// ============================================================================

import { contextBridge, ipcRenderer } from "electron";
import type { SessionLaunchRequest } from "@helios/workspace/types";

interface ConnectRequest {
  connectionId: string;
  resumeSessionId?: string;
  launch?: SessionLaunchRequest;
}

contextBridge.exposeInMainWorld("helios", {
  connect: (req: ConnectRequest): Promise<void> => ipcRenderer.invoke("helios:connect", req),
  send: (connectionId: string, data: string): void => {
    ipcRenderer.send("helios:message", { connectionId, data });
  },
  onMessage(cb: (connectionId: string, data: string) => void) {
    const listener = (_event: unknown, payload: { connectionId: string; data: string }) =>
      cb(payload.connectionId, payload.data);
    ipcRenderer.on("helios:message", listener);
    return { dispose: () => ipcRenderer.removeListener("helios:message", listener) };
  },
  onClose(cb: (connectionId: string) => void) {
    const listener = (_event: unknown, payload: { connectionId: string }) => cb(payload.connectionId);
    ipcRenderer.on("helios:close", listener);
    return { dispose: () => ipcRenderer.removeListener("helios:close", listener) };
  },
  close: (connectionId: string): void => {
    ipcRenderer.send("helios:close", { connectionId });
  },
});

contextBridge.exposeInMainWorld("heliosDesktop", {
  selectAndImportDirectory: () =>
    ipcRenderer.invoke("helios:select-and-import-directory"),
});
