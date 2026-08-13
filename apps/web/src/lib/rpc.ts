// Browser-safe Workspace Host RPC helpers.

import type { RpcClient } from "@helios/protocol/browser";
import type { PortInfo, SessionMeta } from "@helios/kernel";
import type {
  SessionLaunchRequest,
  SessionRecord,
  SessionWorkspaceBinding,
  WorkspaceSummary,
} from "@helios/workspace/types";

export type SessionMetaView = SessionMeta;
export type PortInfoView = PortInfo;

export interface HostCapabilities {
  codeMode: boolean;
  localImport: boolean;
  rollbackMode: "conversation-only";
}

export function wsUrlFor(
  sessionId: string | undefined,
  launch?: SessionLaunchRequest,
): string {
  const override = new URLSearchParams(window.location.search).get("ws");
  const base = override ?? "ws://localhost:8787";
  const query = new URLSearchParams();
  if (sessionId) query.set("resumeSessionId", sessionId);
  else if (launch) query.set("launch", JSON.stringify(launch));
  if ([...query].length === 0) return base;
  const separator = base.includes("?") ? "&" : "?";
  return base + separator + query.toString();
}

export async function listSessions(rpc: RpcClient): Promise<SessionMetaView[]> {
  const result = await rpc.call("sessions.list");
  if (!Array.isArray(result)) return [];
  return result.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Partial<SessionRecord> & Partial<SessionMetaView>;
    return record.meta
      ? [{
          schemaVersion: 1,
          ...record.meta,
          lastRunIndex: 0,
          lastTurnIndex: 0,
        }]
      : [record as SessionMetaView];
  });
}

export async function listPorts(rpc: RpcClient): Promise<PortInfoView[]> {
  const result = await rpc.call("ports.list");
  return Array.isArray(result) ? (result as PortInfoView[]) : [];
}

export async function getHostCapabilities(rpc: RpcClient): Promise<HostCapabilities> {
  return (await rpc.call("host.capabilities")) as HostCapabilities;
}

export async function getSessionWorkspace(rpc: RpcClient): Promise<SessionWorkspaceBinding> {
  return (await rpc.call("session.workspace")) as SessionWorkspaceBinding;
}

export async function listWorkspaces(rpc: RpcClient): Promise<WorkspaceSummary[]> {
  const result = await rpc.call("workspaces.list");
  return Array.isArray(result) ? (result as WorkspaceSummary[]) : [];
}

export async function cloneWorkspace(
  rpc: RpcClient,
  remoteUrl: string,
): Promise<WorkspaceSummary> {
  return (await rpc.call("workspaces.clone", { remoteUrl })) as WorkspaceSummary;
}

export async function importLocalWorkspace(
  rpc: RpcClient,
  path: string,
): Promise<WorkspaceSummary> {
  return (await rpc.call("workspaces.importLocal", { path })) as WorkspaceSummary;
}
