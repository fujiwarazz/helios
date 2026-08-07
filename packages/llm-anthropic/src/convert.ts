import type { Message, ContentBlock, Tool, StopReason } from "@helios/ports";
import type Anthropic from "@anthropic-ai/sdk";

type AnthropicMessageParam = Anthropic.MessageParam;
type AnthropicToolParam = Anthropic.Tool;
// 0.32 未直接导出 ContentBlockParam，从 MessageParam 的 content 数组元素推导。
type BlockParam = Exclude<AnthropicMessageParam["content"], string>[number];

/** helios Message[] → Anthropic messages（system 单独经 opts 传，不进 messages）。 */
export function toAnthropicMessages(messages: Message[]): AnthropicMessageParam[] {
  const out: AnthropicMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: textOf(m.content) });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: toAnthropicBlocks(m.content) });
    } else if (m.role === "toolResult") {
      out.push({ role: "user", content: toToolResultBlocks(m.content) });
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

function toAnthropicBlocks(
  content: string | ContentBlock[],
): AnthropicMessageParam["content"] {
  if (typeof content === "string") return content;
  // thinking 块必须置于 text/tool_use 之前，且回传需带 signature（Anthropic 硬约束）；
  // 无 signature 的 thinking 块无法通过校验，直接丢弃而非发出非法请求。
  const thinkingBlocks: BlockParam[] = [];
  const otherBlocks: BlockParam[] = [];
  for (const b of content) {
    if (b.type === "thinking") {
      // SDK 0.32 的 BlockParam 联合未含 thinking 块，窄类型旁路（运行时服务端按 JSON 接收）。
      if (b.signature) {
        thinkingBlocks.push({
          type: "thinking",
          thinking: b.thinking,
          signature: b.signature,
        } as unknown as BlockParam);
      }
    } else if (b.type === "text") {
      otherBlocks.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
      otherBlocks.push({
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return [...thinkingBlocks, ...otherBlocks];
}

function toToolResultBlocks(
  content: string | ContentBlock[],
): AnthropicMessageParam["content"] {
  if (typeof content === "string") return content;
  const blocks: BlockParam[] = [];
  for (const b of content) {
    if (b.type === "tool_result") {
      blocks.push({
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: stringifyOutput(b.output),
        is_error: b.isError,
      });
    }
  }
  return blocks;
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export function toAnthropicTools(tools: Tool[]): AnthropicToolParam[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as AnthropicToolParam["input_schema"],
  }));
}

export function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop";
    case "end_turn":
    default:
      return "end_turn";
  }
}
