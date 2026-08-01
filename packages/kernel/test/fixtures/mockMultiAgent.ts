import type {
  MultiAgentPort,
  AgentSpec,
  AgentHandle,
  Disposable,
  KernelContext,
} from "@helios/ports";
import { MULTI_AGENT_PORT_API_VERSION } from "@helios/ports";

// 内存直调的 MultiAgentPort 实现——用于验证：换掉 teams-mailbox，kernel 与
// 依赖 MultiAgentPort 的工具零改动仍工作。
class InMemoryMultiAgent implements MultiAgentPort {
  readonly sent: unknown[] = [];
  async spawn(spec: AgentSpec): Promise<AgentHandle> {
    return { id: `mem-${spec.name}`, name: spec.name };
  }
  async send(_h: AgentHandle, msg: unknown): Promise<void> {
    this.sent.push(msg);
  }
  onMessage(): Disposable {
    return { dispose() {} };
  }
}

export const apiVersion = MULTI_AGENT_PORT_API_VERSION;
export function create(_ctx: KernelContext): MultiAgentPort {
  return new InMemoryMultiAgent();
}
export default { apiVersion, create };
