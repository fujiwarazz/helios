// ============================================================================
// packages/ui-chat/src/useChat.ts
// 核心 hook + 纯 reducer。reducer 把 AgentEvent 归并成 ChatMessageView[],
// 必须幂等 / 容忍乱序(按 messageId、toolUseId 定位,重复不重复插入)。
// ============================================================================

import { useCallback, useEffect, useState } from "react";
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
  AskQuestion,
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
  /** run 开始前的历史压缩阶段是否在进行中（同步阻塞，见 compact_start/compact_end）。 */
  isCompacting: boolean;
}

export const initialState: ChatState = { messages: [], isStreaming: false, isCompacting: false };

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
 * 幂等地追加一条系统消息（用于展示 run 失败/发送失败的错误文案）。
 * id 已存在则原样返回，避免重复插入。
 */
function appendErrorMessage(
  messages: ChatMessageView[],
  id: string,
  text: string,
): ChatMessageView[] {
  if (messages.some((m) => m.id === id)) return messages;
  return [...messages, { id, role: "system", text, tools: [] }];
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

    case "compact_start":
      return { ...state, isCompacting: true };

    case "compact_end":
      return { ...state, isCompacting: false };

    case "message_start": {
      if (state.messages.some((m) => m.id === event.messageId)) return state;
      const msg: ChatMessageView = {
        id: event.messageId,
        role: event.role,
        text: "",
        tools: [],
        turnId: event.role === "assistant" ? event.turnId : undefined,
      };
      return { ...state, messages: [...state.messages, msg] };
    }

    case "message_update": {
      // 文本与思考分别累积；其余 delta（工具）走 tool_execution_*。
      // 直接在 event.delta.type 上判别以便 TS 收窄到带 .text 的成员。
      const d = event.delta;
      if (d.type !== "text-delta" && d.type !== "thinking-delta") return state;
      const isThinking = d.type === "thinking-delta";
      const chunk = d.text;
      let found = false;
      const messages = state.messages.map((m) => {
        if (m.id !== event.messageId) return m;
        found = true;
        return isThinking
          ? { ...m, thinking: (m.thinking ?? "") + chunk }
          : { ...m, text: m.text + chunk };
      });
      if (found) return { ...state, messages };
      // 容忍乱序:update 早于 start → 先建一条 assistant 消息。
      return {
        ...state,
        messages: [
          ...state.messages,
          isThinking
            ? { id: event.messageId, role: "assistant", text: "", thinking: chunk, tools: [] }
            : { id: event.messageId, role: "assistant", text: chunk, tools: [] },
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

    case "turn_end":
      // turn 是 run 内的单步；回溯入口按 run 粒度呈现（见 agent_end），此处不打边界。
      return state;

    case "rollback":
      // 后端已把 HEAD 移回该 turn。视图不在 reducer 里猜测截断（ChatMessageView 与
      // 后端 Message[] 非一一对应：tool_result 会并进卡片）。改由 hook 监听到该事件后
      // 重新 getHistory() 重建——历史是权威。这里仅结束流式态。
      return { ...state, isStreaming: false };

    case "agent_end": {
      // 一个 run（一次用户输入 → 多个 turn）结束：按 run 粒度重标回溯入口
      // （只在每个 run 最后一条 assistant 消息上，回溯目标 = 该 run 第一个 turn）。
      // run 因错误优雅收尾（如 LLM 配额超限/不可重试错误）时，追加一条可见的系统提示，
      // 否则错误只留在 host 日志里，前端会像"悄悄卡住"一样毫无提示。
      const messages = event.error
        ? appendErrorMessage(state.messages, `error-${event.runId}`, event.error)
        : state.messages;
      // compact() 若抛错，maybeCompact() 内只 emit 了 compact_start（无 compact_end）就向上抛，
      // isCompacting 会永久卡 true；agent_end 是该 run 的终态兜底，一并复位。
      return { ...state, messages: markRunBoundaries(messages), isStreaming: false, isCompacting: false };
    }

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
    let thinking = "";
    const tools: ToolCallView[] = [];
    for (const block of m.content as ContentBlock[]) {
      if (block.type === "text") text += block.text;
      else if (block.type === "thinking") thinking += block.thinking;
      else if (block.type === "tool_use") {
        tools.push({
          id: block.id,
          name: block.name,
          status: "success",
          descriptor: renderTool?.(block.name, block.input, "success"),
        });
      }
    }
    views.push({ id: m.id, role: m.role, text, tools, turnId: m.turnId, ...(thinking ? { thinking } : {}) });
  }
  return markRunBoundaries(views);
}

/** turnId 格式 `${sessionId}-${runIndex}-${turnIndex}`，取出 runIndex（解析失败返回 undefined）。 */
export function runIndexOf(turnId: string | undefined): number | undefined {
  if (!turnId) return undefined;
  const parts = turnId.split("-");
  if (parts.length < 2) return undefined;
  const run = Number(parts[parts.length - 2]);
  return Number.isFinite(run) ? run : undefined;
}

/**
 * 按 run 粒度标记回溯入口：每个 run（同 runIndex）的最后一条 assistant 消息置
 * isRunBoundary，回溯目标 = 该 run 第一个 turn。纯函数，历史重建与实时事件共用。
 */
export function markRunBoundaries(views: ChatMessageView[]): ChatMessageView[] {
  const firstTurnByRun = new Map<number, string>();
  const lastAssistantIdxByRun = new Map<number, number>();
  views.forEach((v, i) => {
    const run = runIndexOf(v.turnId);
    if (run === undefined) return;
    if (!firstTurnByRun.has(run)) firstTurnByRun.set(run, v.turnId!);
    if (v.role === "assistant") lastAssistantIdxByRun.set(run, i);
  });
  if (lastAssistantIdxByRun.size === 0) return views;
  const boundaryIdx = new Map<number, number>(); // idx -> run
  for (const [run, idx] of lastAssistantIdxByRun) boundaryIdx.set(idx, run);
  return views.map((v, i) => {
    if (!boundaryIdx.has(i)) return v.isRunBoundary ? { ...v, isRunBoundary: false } : v;
    const run = boundaryIdx.get(i)!;
    return { ...v, isRunBoundary: true, rollbackTurnId: firstTurnByRun.get(run) };
  });
}

export interface UseChatResult {
  messages: ChatMessageView[];
  isStreaming: boolean;
  /** run 开始前的历史压缩阶段是否在进行中（同步阻塞：此时 sendMessage 尚未真正发起 LLM 请求）。 */
  isCompacting: boolean;
  connection: ConnectionState;
  send: (text: string) => Promise<void>;
  /** 中断当前 run（Stop 按钮）。client 不支持则为 no-op。 */
  stop: () => Promise<void>;
  /** 回溯到某 turn（⟲ 从这里重新开始）。client 不支持则为 no-op。 */
  rollback: (turnId: string) => Promise<void>;
  /** client 是否支持 stop（据此显隐 Stop 按钮）。 */
  canStop: boolean;
  /** client 是否支持 rollback（据此显隐回溯入口）。 */
  canRollback: boolean;
  /** 当前挂起的审批提问(AskUserQuestion);null 表示无。 */
  pendingQuestion: AskQuestion | null;
  /** 回传审批答案，解阻塞对应工具并清空卡片。 */
  answer: (questionId: string, answers: string[]) => Promise<void>;
}

export function useChat(client: IChatClient, opts: { renderTool?: RenderTool } = {}): UseChatResult {
  const { renderTool } = opts;
  const [state, setState] = useState<ChatState>(initialState);
  const [connection, setConnection] = useState<ConnectionState>("open");
  // 当前挂起的审批提问(AskUserQuestion);null 表示无。答复后清空。
  const [pendingQuestion, setPendingQuestion] = useState<AskQuestion | null>(null);

  /**
   * 从后端权威历史重建视图。
   * - mode "merge"（挂载时）：保留尚未落历史的流式消息，避免历史晚到清掉在途消息。
   * - mode "replace"（rollback 后）：历史即权威,被后端移除的消息必须消失,不保留任何在途。
   */
  const mergeHistory = useCallback(
    (aliveRef: { alive: boolean }, mode: "merge" | "replace" = "merge") => {
      void client
        .getHistory()
        .then((history) => {
          if (!aliveRef.alive) return;
          setState((s) => {
            const hist = messagesToViews(history, renderTool);
            if (mode === "replace") return { ...s, messages: hist };
            const histIds = new Set(hist.map((m) => m.id));
            const streamed = s.messages.filter((m) => !histIds.has(m.id));
            return { ...s, messages: [...hist, ...streamed] };
          });
        })
        .catch(() => {
          /* getHistory 失败(重连/断线瞬间):忽略,下次事件或重连会再拉。 */
        });
    },
    [client, renderTool],
  );

  useEffect(() => {
    const aliveRef = { alive: true };
    // client 变化 = 真实切会话/新建会话（reconnect 由 RpcClient 内部处理，不会走到这里、
    // 不会换 client 引用）：先清空上一个会话的残留消息/流式态，避免新会话的消息列表里
    // 还拖着上一个会话的内容，让人以为"切换没有效果"。
    setState(initialState);
    mergeHistory(aliveRef);
    const offEvent = client.onEvent((e) => {
      setState((prev) => reduce(prev, e, renderTool));
      // rollback：后端已移 HEAD，重新拉取权威历史并整体替换（被移除的消息随之消失）。
      if (e.type === "rollback") mergeHistory(aliveRef, "replace");
    });
    const offState = client.onState?.((s) => setConnection(s));
    const offAsk = client.onAsk?.((q) => setPendingQuestion(q));
    return () => {
      aliveRef.alive = false;
      offEvent();
      offState?.();
      offAsk?.();
      setPendingQuestion(null); // 切会话/断开：清掉挂起提问
    };
    // client 变化即整体重建订阅(切会话)。renderTool 稳定性由调用方负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      try {
        await client.sendMessage(t);
      } catch (err) {
        // sendMessage() 在 run 未优雅收尾前意外 throw（如非预期异常/连接中断/compact() 抛错——
        // kernel 侧 maybeCompact() 无 try/catch，只 emit 了 compact_start 就直接向上抛，
        // 不会有 agent_end 事件来兜底）：没有事件会来，isStreaming/isCompacting 都会永久卡在
        // true，这里强制复位并给出提示。
        const message = err instanceof Error ? err.message : String(err);
        setState((s) => ({
          ...s,
          isStreaming: false,
          isCompacting: false,
          messages: appendErrorMessage(s.messages, `error-send-${Date.now()}`, message),
        }));
      }
    },
    [client],
  );

  const stop = useCallback(async () => {
    await client.cancel?.();
  }, [client]);

  const rollback = useCallback(
    async (turnId: string) => {
      await client.rollback?.(turnId);
    },
    [client],
  );

  const answer = useCallback(
    async (questionId: string, answers: string[]) => {
      setPendingQuestion((cur) => (cur?.questionId === questionId ? null : cur));
      await client.answer?.(questionId, answers);
    },
    [client],
  );

  return {
    messages: state.messages,
    isStreaming: state.isStreaming,
    isCompacting: state.isCompacting,
    connection,
    send,
    stop,
    rollback,
    canStop: typeof client.cancel === "function",
    canRollback: typeof client.rollback === "function",
    pendingQuestion,
    answer,
  };
}
