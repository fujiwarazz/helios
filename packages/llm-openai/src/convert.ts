import type { Message, ContentBlock, Tool, StopReason } from "@helios/ports";
import type OpenAI from "openai";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

/** helios Message[] → OpenAI chat messages（system 单独经 opts.system 前置）。 */
export function toOpenAIMessages(messages: Message[], system?: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: textOf(m.content) });
    } else if (m.role === "user") {
      out.push({ role: "user", content: textOf(m.content) });
    } else if (m.role === "assistant") {
      out.push(toAssistant(m.content));
    } else if (m.role === "toolResult") {
      for (const tm of toToolMessages(m.content)) out.push(tm);
    }
  }
  return out;
}

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function toAssistant(content: string | ContentBlock[]): ChatMessage {
  if (typeof content === "string") return { role: "assistant", content };
  const text = textOf(content);
  const toolCalls = content
    .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function" as const,
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
  const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
    role: "assistant",
    content: text || null,
  };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return msg;
}

function toToolMessages(content: string | ContentBlock[]): ChatMessage[] {
  if (typeof content === "string") return [];
  return content
    .filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")
    .map((b) => ({
      role: "tool" as const,
      tool_call_id: b.toolUseId,
      content: typeof b.output === "string" ? b.output : JSON.stringify(b.output),
    }));
}

export function toOpenAITools(tools: Tool[]): ChatTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

export function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    default:
      return "end_turn";
  }
}
