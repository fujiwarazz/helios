import type { AgentEvent } from "@helios/kernel";
import type { Message, ToolRenderDescriptor } from "@helios/ports";
import { formatCostSummary } from "../costSummary";

export interface TranscriptMessage {
  id: string;
  role: Message["role"];
  text: string;
  thinking: string;
  complete: boolean;
}

export interface ToolCardState {
  toolUseId: string;
  name: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  status: "pending" | "running" | "success" | "error";
  descriptor?: ToolRenderDescriptor;
}

export interface SessionViewState {
  busy: boolean;
  status: string;
  messages: readonly TranscriptMessage[];
  tools: readonly ToolCardState[];
}

export class SessionViewModel {
  private readonly messages = new Map<string, TranscriptMessage>();
  private readonly messageOrder: string[] = [];
  private readonly tools = new Map<string, ToolCardState>();
  private readonly toolOrder: string[] = [];
  private busy = false;
  private status = "Ready";
  private noticeCount = 0;

  hydrate(history: readonly Message[]): void {
    this.reset();
    for (const message of history) {
      const { text, thinking } = contentToTranscript(message.content);
      this.putMessage({ id: message.id, role: message.role, text, thinking, complete: true });
    }
  }

  /**
   * Discards the visual projection only. Kernel messages, branches, and persisted history are
   * untouched; `/clear` and the rehydrate after `head_changed` share this entry point.
   */
  reset(): void {
    this.messages.clear();
    this.messageOrder.length = 0;
    this.tools.clear();
    this.toolOrder.length = 0;
  }

  /** Local, LLM-invisible transcript line (command output, resume/branch reports). */
  notice(text: string): void {
    this.noticeCount += 1;
    this.putMessage({
      id: `local-notice-${this.noticeCount}`,
      role: "system",
      text,
      thinking: "",
      complete: true,
    });
  }

  setStatus(status: string): void {
    this.status = status;
  }

  apply(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.busy = true;
        this.status = "Working";
        return;
      case "message_start":
        this.putMessage({
          id: event.messageId,
          role: event.role,
          text: "",
          thinking: "",
          complete: false,
        });
        return;
      case "message_update":
        this.applyMessageDelta(event);
        return;
      case "message_end": {
        const message = this.messages.get(event.messageId);
        if (message) message.complete = true;
        return;
      }
      case "tool_execution_start":
        this.putTool({
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
          status: "running",
        });
        return;
      case "tool_execution_end": {
        const tool = this.tools.get(event.toolUseId);
        if (tool) {
          tool.output = event.output;
          tool.isError = event.isError;
          tool.status = event.isError ? "error" : "success";
          tool.descriptor = event.descriptor;
        } else {
          this.putTool({
            toolUseId: event.toolUseId,
            name: "Tool",
            input: undefined,
            output: event.output,
            isError: event.isError,
            status: event.isError ? "error" : "success",
            descriptor: event.descriptor,
          });
        }
        return;
      }
      case "llm_retry":
        this.status = `Retrying (${event.retryCount})`;
        return;
      case "compact_start":
        this.status = "Compacting";
        return;
      case "compact_end":
        this.status = "Ready";
        return;
      case "agent_end": {
        this.busy = false;
        this.status = event.error ? `Error: ${event.error}` : "Completed";
        // 成本行走 notice：它是本地 transcript 行，不进消息树、LLM 看不到。
        const cost = formatCostSummary(event.costReport);
        if (cost) this.notice(cost);
        return;
      }
      default:
        return;
    }
  }

  snapshot(): SessionViewState {
    return {
      busy: this.busy,
      status: this.status,
      messages: this.messageOrder.map((id) => ({ ...this.messages.get(id)! })),
      tools: this.toolOrder.map((id) => ({ ...this.tools.get(id)! })),
    };
  }

  private applyMessageDelta(event: Extract<AgentEvent, { type: "message_update" }>): void {
    const message = this.messages.get(event.messageId);
    if (!message) return;
    if (event.delta.type === "text-delta") message.text += event.delta.text;
    if (event.delta.type === "thinking-delta") message.thinking += event.delta.text;
  }

  private putMessage(message: TranscriptMessage): void {
    if (!this.messages.has(message.id)) this.messageOrder.push(message.id);
    this.messages.set(message.id, message);
  }

  private putTool(tool: ToolCardState): void {
    if (!this.tools.has(tool.toolUseId)) this.toolOrder.push(tool.toolUseId);
    this.tools.set(tool.toolUseId, tool);
  }
}

function contentToTranscript(content: Message["content"]): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  let text = "";
  let thinking = "";
  for (const block of content) {
    if (block.type === "text") text += block.text;
    if (block.type === "thinking") thinking += block.thinking;
    if (block.type === "tool_use") text += `\nTool call: ${block.name}`;
    if (block.type === "tool_result") text += `\nTool result: ${renderValue(block.output)}`;
  }
  return { text: text.trimStart(), thinking };
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
}
