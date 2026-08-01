// ============================================================================
// packages/protocol/src/wsTransport.ts
// 三个 WebSocket 传输实现。传输层只搬字符串,不认识协议帧。
//   nodeWsServerTransport(ws)  : 服务端把已 accept 的单个连接包成 Transport。
//   nodeWsClientTransport(url) : node 宿主/测试用 `ws` 库连接。
//   browserWsClientTransport(url): 浏览器宿主用全局 WebSocket。
// 其余传输(ElectronIpc / InProcess)是同一 Transport 抽象的另一实现,本期不做。
// ============================================================================

import type { WebSocket as NodeWebSocket } from "ws";
import { WebSocket as NodeWebSocketCtor } from "ws";
import type { Disposable } from "@helios/ports";
import type { Transport } from "./transport";

type MsgCb = (data: string) => void;
type CloseCb = () => void;

/** 把一个已建立的 ws 连接(server 端或 client 端)包成 Transport。 */
function wrapNodeWs(ws: NodeWebSocket): Transport {
  const msgCbs = new Set<MsgCb>();
  const closeCbs = new Set<CloseCb>();
  ws.on("message", (data: unknown) => {
    const s = typeof data === "string" ? data : String(data);
    for (const cb of msgCbs) cb(s);
  });
  ws.on("close", () => {
    for (const cb of closeCbs) cb();
  });
  ws.on("error", () => {
    // 错误后 close 事件会随之触发;这里吞掉避免未处理 error 崩进程。
  });
  return {
    send(data: string): void {
      ws.send(data);
    },
    onMessage(cb: MsgCb): Disposable {
      msgCbs.add(cb);
      return { dispose: () => msgCbs.delete(cb) };
    },
    onClose(cb: CloseCb): Disposable {
      closeCbs.add(cb);
      return { dispose: () => closeCbs.delete(cb) };
    },
    close(): void {
      ws.close();
    },
  };
}

/** 服务端:每个 accept 的连接调一次,得到该连接的 Transport。 */
export function nodeWsServerTransport(ws: NodeWebSocket): Transport {
  return wrapNodeWs(ws);
}

/** node 客户端:连接 url,ws 建立后 resolve。 */
export function nodeWsClientTransport(url: string): Promise<Transport> {
  return new Promise<Transport>((resolve, reject) => {
    const ws = new NodeWebSocketCtor(url);
    ws.once("open", () => resolve(wrapNodeWs(ws)));
    ws.once("error", (err: Error) => reject(err));
  });
}

/** 浏览器客户端:用全局 WebSocket。 */
export function browserWsClientTransport(url: string): Promise<Transport> {
  return new Promise<Transport>((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgCbs = new Set<MsgCb>();
    const closeCbs = new Set<CloseCb>();
    ws.onmessage = (ev: MessageEvent) => {
      const s = typeof ev.data === "string" ? ev.data : String(ev.data);
      for (const cb of msgCbs) cb(s);
    };
    ws.onclose = () => {
      for (const cb of closeCbs) cb();
    };
    ws.onerror = () => {
      reject(new Error("WebSocket 连接失败"));
    };
    ws.onopen = () => {
      resolve({
        send: (data: string) => ws.send(data),
        onMessage(cb: MsgCb): Disposable {
          msgCbs.add(cb);
          return { dispose: () => msgCbs.delete(cb) };
        },
        onClose(cb: CloseCb): Disposable {
          closeCbs.add(cb);
          return { dispose: () => closeCbs.delete(cb) };
        },
        close: () => ws.close(),
      });
    };
  });
}
