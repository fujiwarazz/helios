// ============================================================================
// packages/protocol/src/browserWsTransport.ts
// 浏览器侧 WebSocket 传输(用全局 WebSocket,零 import,可安全打进浏览器 bundle)。
// ============================================================================

import type { Disposable } from "@helios/ports";
import type { Transport } from "./transport";

type MsgCb = (data: string) => void;
type CloseCb = () => void;

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
