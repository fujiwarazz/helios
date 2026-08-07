// apps/web/src/lib/rpc.ts —— 应用侧对宿主只读 RPC 的薄封装 + WS URL 构造。

import type { RpcClient } from "@helios/protocol/browser";
import type { SessionMeta, PortInfo } from "@helios/kernel";

/** 会话列表视图(直接用后端 SessionMeta)。 */
export type SessionMetaView = SessionMeta;
export type PortInfoView = PortInfo;

/**
 * 构造宿主 WS 地址。
 * - ?ws= 显式覆盖优先(非默认端口场景)。
 * - 否则默认 ws://localhost:8787,带上 ?session=<id> 以 resume。
 */
export function wsUrlFor(sessionId: string | undefined): string {
  const override = new URLSearchParams(window.location.search).get("ws");
  const base = override ?? "ws://localhost:8787";
  if (!sessionId) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}session=${encodeURIComponent(sessionId)}`;
}

export async function listSessions(rpc: RpcClient): Promise<SessionMetaView[]> {
  const r = await rpc.call("sessions.list");
  return Array.isArray(r) ? (r as SessionMetaView[]) : [];
}

export async function listPorts(rpc: RpcClient): Promise<PortInfoView[]> {
  const r = await rpc.call("ports.list");
  return Array.isArray(r) ? (r as PortInfoView[]) : [];
}
