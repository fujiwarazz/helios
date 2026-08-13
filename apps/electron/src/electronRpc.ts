// apps/electron/src/electronRpc.ts —— 渲染进程侧的连接建立:先 connect() 握手(等主进程
// bindSession 完成才 resolve,避免"渲染进程先发消息、主进程还没绑好"的竞态,这是 Electron IPC
// 请求/响应天然有序可靠带来的好处,不需要 apps/web 那套"缓冲早到消息"的兜底)。

import { electronRendererTransport } from "@helios/protocol/browser";
import type { Transport } from "@helios/protocol/browser";
import type { SessionLaunchRequest } from "@helios/workspace/types";

function newConnectionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 建一条新连接:resumeSessionId 有值则 resume 历史会话,无则新建(语义对齐 web 端
 * wsUrlFor 的 ?session= 参数)。每次调用生成一个新 connectionId,对应 web 端"每个
 * activeSessionId/nonce 组合建一条新连接"。
 */
export async function connectElectronTransport(
  resumeSessionId?: string,
  launch?: SessionLaunchRequest,
): Promise<Transport> {
  const connectionId = newConnectionId();
  await window.helios.connect(
    resumeSessionId
      ? { connectionId, resumeSessionId }
      : launch
        ? { connectionId, launch }
        : { connectionId },
  );
  return electronRendererTransport(window.helios, connectionId);
}
