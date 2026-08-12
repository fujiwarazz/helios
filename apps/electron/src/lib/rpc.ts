// apps/electron/src/lib/rpc.ts —— 应用侧对宿主只读 RPC 的薄封装。
// 与 apps/web 的版本区别:没有 wsUrlFor(electron 走 IPC 不走 WS URL),
// 连接建立逻辑在 ../electronRpc.ts。

import type { RpcClient } from "@helios/protocol/browser";
import type { SessionMeta, PortInfo } from "@helios/kernel";

/** 会话列表视图(直接用后端 SessionMeta)。 */
export type SessionMetaView = SessionMeta;
export type PortInfoView = PortInfo;

export async function listSessions(rpc: RpcClient): Promise<SessionMetaView[]> {
  const r = await rpc.call("sessions.list");
  return Array.isArray(r) ? (r as SessionMetaView[]) : [];
}

export async function listPorts(rpc: RpcClient): Promise<PortInfoView[]> {
  const r = await rpc.call("ports.list");
  return Array.isArray(r) ? (r as PortInfoView[]) : [];
}
