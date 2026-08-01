// ============================================================================
// packages/ui-chat/src/useChat.ts
// 核心 hook + 纯 reducer。reducer 把 AgentEvent 归并成 ChatMessageView[],
// 必须幂等 / 容忍乱序(按 messageId、toolUseId 定位,重复不重复插入)。
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@helios/kernel";
import type {
  Message,
  ContentBlock,
  ToolStatus,
  ToolRenderDescriptor,
} from "@helios/ports";
import type {
  IChatClient,
  ConnectionState,
  ChatMessageView,
  ToolCallView,
} from "./types";

/** 可选的工具渲染器:把工具名/入参/状态/输出映射成结构化描述。 */
export type RenderTool = (
  name: string,
  input: unknown,
  status: ToolStatus,
  output?: unknown,
) => ToolRenderDescriptor;

export interface ChatState {
  messages: ChatMessageView[];
  isStreaming: boolean;
}

export const initialState: ChatState = { messages: [], isStreaming: false };

function findTool(
  messages: ChatMessageView[],
  toolUseId: string,
): { msg: ChatMessageView; tool: ToolCallView } | undefined {
  for (const msg of messages) {
    const tool = msg.tools.find((t) => t.id === toolUseId);
    if (tool) return { msg, tool };
  }
  return undefined;
}

/** 找最后一条 assistant 消息(工具卡片挂在它上面);没有则返回 undefined。 */
function lastAssistant(messages: ChatMessageView[]): ChatMessageView | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return undefined;
}

/**
 * 纯 reducer:输入旧 state + 一个事件,返回新 state(不可变更新)。
 * 幂等:重复 message_start / 重复 tool 事件都不会产生重复条目。
 */
export function reduce(
  state: ChatState,
  event: AgentEvent,
  renderTool?: RenderTool,
): ChatState {
  switch (event.type) {
    case "agent_start":
      return { ...state, isStreaming: true };

    case "message_start": {
      if (state.messages.some((m) => m.id === event.messageId)) return state;
      const msg: ChatMessageView = {
        id: event.messageId,
        role: event.role,
        text: "",
        tools: [],
      };
      return { ...state, messages: [...state.messages, msg] };
    }

    case "message_update": {
      if (event.delta.type !== "text-delta") return state; // 工具走 tool_execution_*
      const text = event.delta.text;
      let found = false;
      const messages = state.messages.map((m) => {
        if (m.id !== event.messageId) return m;
        found = true;
        return { ...m, text: m.text + text };
      });
      if (found) return { ...state, messages };
      // 容忍乱序:update 早于 start → 先建一条 assistant 消息。
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: event.messageId, role: "assistant", text, tools: [] },
        ],
      };
    }

    case "tool_execution_start": {
      if (findTool(state.messages, event.toolUseId)) return state; // 幂等
      const descriptor = renderTool?.(event.name, event.input, "running");
      const card: ToolCallView = {
        id: event.toolUseId,
        name: event.name,
        status: "running",
        descriptor,
      };
      const owner = lastAssistant(state.messages);
      if (owner) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === owner.id ? { ...m, tools: [...m.tools, card] } : m,
          ),
        };
      }
      // 没有 assistant 消息可挂 → 新建一条承载工具卡片。
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: `tools-${event.toolUseId}`, role: "assistant", text: "", tools: [card] },
        ],
      };
    }

    case "tool_execution_end": {
      const status: ToolStatus = event.isError ? "error" : "success";
      const hit = findTool(state.messages, event.toolUseId);
      if (hit) {
        const descriptor = renderTool?.(hit.tool.name, undefined, status, event.output);
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === hit.msg.id
              ? {
                  ...m,
                  tools: m.tools.map((t) =>
                    t.id === event.toolUseId ? { ...t, status, descriptor } : t,
                  ),
                }
              : m,
          ),
        };
      }
      // 容忍乱序:end 早于 start → 预建一张已完成卡片挂到最后 assistant。
      const descriptor = renderTool?.("", undefined, status, event.output);
      const card: ToolCallView = { id: event.toolUseId, name: "", status, descriptor };
      const owner = lastAssistant(state.messages);
      if (owner) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === owner.id ? { ...m, tools: [...m.tools, card] } : m,
          ),
        };
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: `tools-${event.toolUseId}`, role: "assistant", text: "", tools: [card] },
        ],
      };
    }

    case "agent_end":
      return { ...state, isStreaming: false };

    default:
      return state;
  }
}

/** 历史 Message[] → 初始视图(text 块拼接 + tool_use → 卡片 + tool_result 合并输出)。 */
export function messagesToViews(
  messages: Message[],
  renderTool?: RenderTool,
): ChatMessageView[] {
  const views: ChatMessageView[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      views.push({ id: m.id, role: m.role, text: m.content, tools: [] });
      continue;
    }
    if (m.role === "toolResult") {
      // 把 tool_result 合并到已存在的工具卡片上。
      for (const block of m.content as ContentBlock[]) {
        if (block.type !== "tool_result") continue;
        const hit = findTool(views, block.toolUseId);
        if (hit) {
          const status: ToolStatus = block.isError ? "error" : "success";
          hit.tool.status = status;
          hit.tool.descriptor = renderTool?.(hit.tool.name, undefined, status, block.output);
        }
      }
      continue;
    }
    let text = "";
    const tools: ToolCallView[] = [];
    for (const block of m.content as ContentBlock[]) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") {
        tools.push({
          id: block.id,
          name: block.name,
          status: "success",
          descriptor: renderTool?.(block.name, block.input, "success"),
        });
      }
    }
    views.push({ id: m.id, role: m.role, text, tools });
  }
  return views;
}

export interface UseChatResult {
  messages: ChatMessageView[];
  isStreaming: boolean;
  connection: ConnectionState;
  send: (text: string) => Promise<void>;
}

export function useChat(client: IChatClient, opts: { renderTool?: RenderTool } = {}): UseChatResult {
  const { renderTool } = opts;
  const [state, setState] = useState<ChatState>(initialState);
  const [connection, setConnection] = useState<ConnectionState>("open");
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let alive = true;
    void client.getHistory().then((history) => {
      if (!alive) return;
      // 合并而非覆盖:历史可能晚于首批事件到达,不能清掉已归并的流式消息。
      setState((s) => {
        const hist = messagesToViews(history, renderTool);
        const histIds = new Set(hist.map((m) => m.id));
        const streamed = s.messages.filter((m) => !histIds.has(m.id));
        return { ...s, messages: [...hist, ...streamed] };
      });
    });
    const offEvent = client.onEvent((e) => {
      setState((prev) => reduce(prev, e, renderTool));
    });
    const offState = client.onState?.((s) => setConnection(s));
    return () => {
      alive = false;
      offEvent();
      offState?.();
    };
    // client 变化即整体重建订阅(切会话)。renderTool 稳定性由调用方负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      await client.sendMessage(t);
    },
    [client],
  );

  return { messages: state.messages, isStreaming: state.isStreaming, connection, send };
}
