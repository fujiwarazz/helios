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
  | { type: "head_changed"; headId: string | null }
  | {
      type: "agent_end";
      runId: string;
      turnIds: string[];
      newMessages: Message[];
      /** run 因 LLM 流错误优雅终止时的错误信息（Bug 3）；正常结束时为 undefined */
      error?: string;
      /** run 因达到 turn 上限而提前结束（Bug 5）；自然结束时为 undefined */
      reachedMaxTurns?: boolean;
    };

export interface ToolResultRecord {
  toolUseId: string;
  name: string;
  output: unknown;
  isError: boolean;
}

export type AgentEventListener = (event: AgentEvent) => void;
