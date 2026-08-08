import type { Message, ContentBlock, Tool, LLMOptions, LLMProvider, StopReason, Logger } from "@helios/ports";
import { uid } from "../ids";
import type { AgentEvent } from "../events";
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
  emit: (event: AgentEvent) => void;
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

/**
 * 调一次 LLM、把流式事件收拢成一条完整 assistant 消息。纯函数，不持有任何 Session 状态——
 * 调用方负责传入本轮要发的路径（messages）与订阅信号（signal），并消费返回结果去决定下一步。
 */
export async function streamAssistant(params: StreamAssistantParams): Promise<StreamAssistantResult> {
  const { provider, messages, tools, llmOptions, system, signal, turnId, logger, emit } = params;
  const messageId = uid("msg");
  emit({ type: "message_start", messageId, role: "assistant", turnId });

  let textAccum = "";
  let thinkingAccum = "";
  let thinkingSignature: string | undefined;
  const toolCalls = new Map<string, { name: string; args: string }>();
  const order: string[] = [];
  let stopReason: StopReason = "end_turn";
  let streamError: string | undefined;

  const gen = provider.streamMessage(messages, tools, { ...llmOptions, system, signal });

  for await (const ev of gen) {
    emit({ type: "message_update", messageId, delta: ev });
    switch (ev.type) {
      case "text-delta":
        textAccum += ev.text;
        break;
      case "thinking-delta":
        thinkingAccum += ev.text;
        break;
      case "thinking-signature":
        thinkingSignature = ev.signature;
        break;
      case "tool-call-start":
        toolCalls.set(ev.id, { name: ev.name, args: "" });
        order.push(ev.id);
        break;
      case "tool-call-delta": {
        const tc = toolCalls.get(ev.id);
        if (tc) tc.args += ev.argsDelta;
        break;
      }
      case "tool-call-end":
        break;
      case "message-stop":
        stopReason = ev.stopReason;
        break;
      case "error":
        // Bug 3：不再 throw 穿透整个 run，记录错误并中断流，交由调用方优雅收尾。
        logger.error(`LLM 流错误：${ev.error}`);
        streamError = ev.error;
        break;
    }
    if (streamError) break;
  }

  const content: ContentBlock[] = [];
  // thinking 块须置于文本/工具之前（Anthropic 要求 thinking 在 assistant 内容最前）。
  if (thinkingAccum) content.push({ type: "thinking", thinking: thinkingAccum, signature: thinkingSignature });
  if (textAccum) content.push({ type: "text", text: textAccum });

  // 流错误时丢弃可能被截断的残缺 tool_use（执行会误伤），仅保留已累计文本。
  const toolUseBlocks: ToolUseBlock[] = [];
  const parseErrorIds = new Set<string>();
  if (!streamError) {
    for (const id of order) {
      const tc = toolCalls.get(id)!;
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
  // 输出被截断（max_tokens）：本轮工具调用参数可能不完整，即便碰巧解析成功也不可信，全部判失败而非执行。
  // 必须在下面的 stopReason 改写为 "tool_use" 之前判断，否则原始截断信号会被覆盖丢失。
  if (stopReason === "max_tokens") {
    for (const block of toolUseBlocks) parseErrorIds.add(block.id);
  }
  if (toolUseBlocks.length > 0) stopReason = "tool_use";

  const assistantMsg: Message = { id: messageId, role: "assistant", content };
  emit({ type: "message_end", messageId, role: "assistant", stopReason });
  return { assistantMsg, stopReason, toolUseBlocks, streamError, parseErrorIds };
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
