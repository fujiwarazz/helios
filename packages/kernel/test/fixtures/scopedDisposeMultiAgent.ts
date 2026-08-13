import {
  MULTI_AGENT_PORT_API_VERSION,
  type AgentHandle,
  type AgentMessage,
  type AgentSpec,
  type Disposable,
  type MultiAgentPort,
} from "@helios/ports";

export const apiVersion = MULTI_AGENT_PORT_API_VERSION;
export const scopedDisposeCalls: string[] = [];

export function reset(): void {
  scopedDisposeCalls.length = 0;
}

export function create(): MultiAgentPort {
  return {
    async spawn(spec: AgentSpec): Promise<AgentHandle> {
      return { id: spec.name, name: spec.name };
    },
    async send(_handle: AgentHandle, _message: AgentMessage): Promise<void> {},
    onMessage(): Disposable {
      return { dispose() {} };
    },
    async dispose(handle: AgentHandle): Promise<void> {
      scopedDisposeCalls.push(handle.name);
    },
  };
}

export default { apiVersion, create };
