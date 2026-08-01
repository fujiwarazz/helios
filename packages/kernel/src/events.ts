import type { Message, StreamEvent, StopReason, Role } from "@helios/ports";

/** 分层事件协议：agent_start → (turn_start → message_* → tool_execution_* → turn_end)+ → agent_end */
export type AgentEvent =
  | { type: "agent_start"; runId: string }
  | { type: "turn_start"; turnId: string }
  | { type: "message_start"; messageId: string; role: Role; turnId: string }
  | { type: "message_update"; messageId: string; delta: StreamEvent }
  | { type: "message_end"; messageId: string; role: Role; stopReason?: StopReason }
  | { type: "tool_execution_start"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_execution_end"; toolUseId: string; output: unknown; isError: boolean }
  | { type: "turn_end"; turnId: string; toolResults: ToolResultRecord[] }
  | { type: "compact_start"; messageCount: number }
  | { type: "compact_end"; summaryLength: number; remaining: number }
  | { type: "rollback"; turnId: string; historyLength: number }
  | { type: "agent_end"; runId: string; turnIds: string[]; newMessages: Message[] };

export interface ToolResultRecord {
  toolUseId: string;
  name: string;
  output: unknown;
  isError: boolean;
}

export type AgentEventListener = (event: AgentEvent) => void;
