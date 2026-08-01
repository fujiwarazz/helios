import type { AgentSpec, AgentHandle, AgentMessage, Disposable } from "./types";

export const MULTI_AGENT_PORT_API_VERSION = 1;

/**
 * 多智能体协作。降级：不加载 → spawn 抛结构化"未启用"错误，
 * 被 Task 工具捕获后作为 tool_result 回传 LLM。
 */
export interface MultiAgentPort {
  spawn(spec: AgentSpec): Promise<AgentHandle>;
  send(handle: AgentHandle, msg: AgentMessage): Promise<void>;
  onMessage(handle: AgentHandle, cb: (msg: AgentMessage) => void): Disposable;
  dispose?(handle: AgentHandle): Promise<void>;
}
