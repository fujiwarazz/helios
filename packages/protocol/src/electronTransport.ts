// ============================================================================
// packages/protocol/src/electronTransport.ts
// Electron IPC 传输 —— 主进程 ↔ 渲染进程内直连,不经 WebSocket。
// 与 nodeWsTransport/browserWsTransport 同一形状:一份底层包装函数,两侧各暴露一个
// 语义化命名的工厂(渲染进程侧/主进程侧),供 `bindSession` 的 Transport 参数消费。
//
// ⚠️ 本文件不 import "electron":`ElectronIpcBridge` 是结构化最小接口(duck typing),
// 由调用方（渲染进程用 preload 暴露的 contextBridge 对象;主进程用 @helios/host 里
// 包一层 ipcMain/webContents 的小适配器）各自实现并传入。好处:
//   1. protocol 包不背上 "electron" 依赖,可被非 Electron 宿主复用同一套接口约定;
//   2. 真正的 electron/ipcMain/webContents 接线留在各自的运行环境里(host 包/preload),
//      这里只认"一条按 connectionId 分拣的双向消息管道"。
//
// 多路复用:同一个 webContents/window 上可能有多条逻辑连接（对应 web 端"每次
// activeSessionId/nonce 变化建一条新连接"的语义,即"新建/切会话=新连接"）,靠
// connectionId 在同一物理 IPC 通道上分拣,与 valos ProxyChannel 按 channelName 分拣
// 同一思路,量级小很多,不需要引入完整 ProxyChannel。
// ============================================================================

import type { Disposable } from "@helios/ports";
import type { Transport } from "./transport";

/**
 * Electron IPC 两侧（主进程/渲染进程）都要实现的最小桥接口。
 * 两侧实现不同（主进程包 ipcMain+webContents;渲染进程包 preload 暴露的
 * contextBridge 对象),但形状一致,故 electronRendererTransport/electronMainTransport
 * 可以共用同一个 Transport 包装逻辑。
 */
export interface ElectronIpcBridge {
  /** 发一帧给对端,携带 connectionId 以便对端分拣。 */
  send(connectionId: string, data: string): void;
  /** 订阅"收到任意连接的一帧"(未过滤),调用方按 connectionId 自行分拣。 */
  onMessage(cb: (connectionId: string, data: string) => void): Disposable;
  /** 订阅"某条连接被对端关闭"。 */
  onClose(cb: (connectionId: string) => void): Disposable;
  /** 主动关闭某条连接。 */
  close(connectionId: string): void;
}

/** 把"一个多路复用的 bridge + 一个 connectionId"包成该连接专属的 Transport。 */
function wrapElectronBridge(bridge: ElectronIpcBridge, connectionId: string): Transport {
  return {
    send(data: string): void {
      bridge.send(connectionId, data);
    },
    onMessage(cb: (data: string) => void): Disposable {
      return bridge.onMessage((cid, data) => {
        if (cid === connectionId) cb(data);
      });
    },
    onClose(cb: () => void): Disposable {
      return bridge.onClose((cid) => {
        if (cid === connectionId) cb();
      });
    },
    close(): void {
      bridge.close(connectionId);
    },
  };
}

/** 渲染进程侧:bridge 来自 preload 的 contextBridge 暴露对象。 */
export function electronRendererTransport(bridge: ElectronIpcBridge, connectionId: string): Transport {
  return wrapElectronBridge(bridge, connectionId);
}

/** 主进程侧:bridge 来自 @helios/host 里包一层 ipcMain/webContents 的适配器。 */
export function electronMainTransport(bridge: ElectronIpcBridge, connectionId: string): Transport {
  return wrapElectronBridge(bridge, connectionId);
}
