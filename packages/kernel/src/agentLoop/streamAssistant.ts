import type { Message, ContentBlock, Tool, LLMOptions, LLMProvider, StopReason, StreamEvent, Logger } from "@helios/ports";
import { uid } from "../ids";
import type { AgentEventEmitter } from "../events";
import type { ToolUseBlock } from "./types";

export interface StreamAssistantParams {
  provider: LLMProvider;
  /** 发给 LLM 的有效路径（调用方传 pathToHead() 的结果）。 */
  messages: Message[];
  tools: Tool[];
  llmOptions: LLMOptions;
  system: string;
  signal?: AbortSignal;
  turnId: string;
  logger: Logger;
  events: AgentEventEmitter;
}

export interface StreamAssistantResult {
  assistantMsg: Message;
  stopReason: StopReason;
  toolUseBlocks: ToolUseBlock[];
  /** LLM 流中途报错时的信息（Bug 3）；正常时 undefined。 */
  streamError?: string;
  /** 参数 JSON 解析失败 / 因输出截断（max_tokens）而判失败的 tool_use id 集合，executeTools 据此回传错误。 */
  parseErrorIds: Set<string>;
}

/** for-await 循环期间的累积态；每种 StreamEvent 只改自己关心的字段。 */
interface StreamAccumulator {
  textAccum: string;
  thinkingAccum: string;
  thinkingSignature?: string;
  toolCalls: Map<string, { name: string; args: string }>;
  order: string[];
  stopReason: StopReason;
  streamError?: string;
}

type StreamEventHandler<E extends StreamEvent = StreamEvent> = (acc: StreamAccumulator, ev: E, logger: Logger) => void;

/**
 * 按 StreamEvent.type 分发的处理表，取代原来的 switch-case——新增事件类型只需加一行表项，
 * 不用改分发逻辑本身；`{ [K in ...]: ... }` 保证漏写某个 case 会在编译期报错。
 */
const STREAM_EVENT_HANDLERS: { [K in StreamEvent["type"]]: StreamEventHandler<Extract<StreamEvent, { type: K }>> } = {
  "text-delta": (acc, ev) => {
    acc.textAccum += ev.text;
  },
  "thinking-delta": (acc, ev) => {
    acc.thinkingAccum += ev.text;
  },
  "thinking-signature": (acc, ev) => {
    acc.thinkingSignature = ev.signature;
  },
  "tool-call-start": (acc, ev) => {
    acc.toolCalls.set(ev.id, { name: ev.name, args: "" });
    acc.order.push(ev.id);
  },
  "tool-call-delta": (acc, ev) => {
    const tc = acc.toolCalls.get(ev.id);
    if (tc) tc.args += ev.argsDelta;
  },
  "tool-call-end": () => {},
  "message-stop": (acc, ev) => {
    acc.stopReason = ev.stopReason;
  },
  error: (acc, ev, logger) => {
    // Bug 3：不再 throw 穿透整个 run，记录错误并中断流，交由调用方优雅收尾。
    logger.error(`LLM 流错误：${ev.error}`);
    acc.streamError = ev.error;
  },
};

/**
 * 调一次 LLM、把流式事件收拢成一条完整 assistant 消息。纯函数，不持有任何 Session 状态——
 * 调用方负责传入本轮要发的路径（messages）与订阅信号（signal），并消费返回结果去决定下一步。
 */
export async function streamAssistant(params: StreamAssistantParams): Promise<StreamAssistantResult> {
  const { provider, messages, tools, llmOptions, system, signal, turnId, logger, events } = params;
  const messageId = uid("msg");
  events.emit({ type: "message_start", messageId, role: "assistant", turnId });

  const acc: StreamAccumulator = {
    textAccum: "",
    thinkingAccum: "",
    toolCalls: new Map(),
    order: [],
    stopReason: "end_turn",
  };

  const gen = provider.streamMessage(messages, tools, { ...llmOptions, system, signal });

  for await (const ev of gen) {
    events.emit({ type: "message_update", messageId, delta: ev });
    const handler = STREAM_EVENT_HANDLERS[ev.type] as StreamEventHandler;
    handler(acc, ev, logger);
    if (acc.streamError) break;
  }

  const content: ContentBlock[] = [];
  // thinking 块须置于文本/工具之前（Anthropic 要求 thinking 在 assistant 内容最前）。
  if (acc.thinkingAccum) content.push({ type: "thinking", thinking: acc.thinkingAccum, signature: acc.thinkingSignature });
  if (acc.textAccum) content.push({ type: "text", text: acc.textAccum });

  // 流错误时丢弃可能被截断的残缺 tool_use（执行会误伤），仅保留已累计文本。
  const toolUseBlocks: ToolUseBlock[] = [];
  const parseErrorIds = new Set<string>();
  if (!acc.streamError) {
    for (const id of acc.order) {
      const tc = acc.toolCalls.get(id)!;
      const parsed = parseJsonSafe(tc.args);
      if (!parsed.ok) parseErrorIds.add(id); // Bug 4：标记解析失败
      const block: ToolUseBlock = {
        type: "tool_use",
        id,
        name: tc.name,
        input: parsed.value,
      };
      content.push(block);
      toolUseBlocks.push(block);
    }
  }
  let stopReason = acc.stopReason;
  // 输出被截断（max_tokens）：本轮工具调用参数可能不完整，即便碰巧解析成功也不可信，全部判失败而非执行。
  // 必须在下面的 stopReason 改写为 "tool_use" 之前判断，否则原始截断信号会被覆盖丢失。
  if (stopReason === "max_tokens") {
    for (const block of toolUseBlocks) parseErrorIds.add(block.id);
  }
  if (toolUseBlocks.length > 0) stopReason = "tool_use";

  const assistantMsg: Message = { id: messageId, role: "assistant", content };
  events.emit({ type: "message_end", messageId, role: "assistant", stopReason });
  return { assistantMsg, stopReason, toolUseBlocks, streamError: acc.streamError, parseErrorIds };
}

/**
 * 解析 tool_use 参数 JSON。空参数视为合法（无参工具）；
 * 非法 JSON（流式拼接被截断等）返回 ok:false，由 executeTools 回传错误让 LLM 重试，
 * 而非静默吞成 {} 让工具拿空参数硬跑（Bug 4）。
 */
function parseJsonSafe(s: string): { ok: boolean; value: unknown } {
  if (!s || !s.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false, value: {} };
  }
}
