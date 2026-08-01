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
  const blocks: BlockParam[] = [];
  for (const b of content) {
    if (b.type === "text") blocks.push({ type: "text", text: b.text });
    else if (b.type === "tool_use")
      blocks.push({
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
      });
  }
  return blocks;
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

// ---------------------------------------------------------------------------
// Prompt cache 断点（缓存纪律二）
// Anthropic 手动 cache_control：从头逐 token 比对，遇第一个不同 token 之前全部命中。
// kernel 已保证 pathToHead() 内容稳定、system 前缀冻结（公共前提），provider 侧只负责
// 在稳定前缀上打静态断点。切分支/回溯回旧节点再往下时，共享祖先前缀天然复用缓存。
// ---------------------------------------------------------------------------

type EphemeralCacheControl = { type: "ephemeral" };

/** system 前缀转带 cache_control 的 text block（最靠前、最稳定、跨所有分支共享的缓存块）。 */
export function cachedSystem(
  system: string,
): { type: "text"; text: string; cache_control: EphemeralCacheControl }[] {
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
}

/**
 * 在 messages 上打一个静态 cache 断点：取倒数第二个 message（只有一条时退化为最后一条）
 * 的最后一个内容块加 cache_control，命中「历史前缀」缓存。就地修改传入数组。
 */
export function applyCacheBreakpoints(messages: AnthropicMessageParam[]): void {
  if (messages.length === 0) return;
  const idx = messages.length >= 2 ? messages.length - 2 : messages.length - 1;
  const msg = messages[idx];
  const content = msg.content;
  if (typeof content === "string") {
    msg.content = [
      { type: "text", text: content, cache_control: { type: "ephemeral" } } as BlockParam,
    ];
  } else if (content.length > 0) {
    const last = content[content.length - 1] as BlockParam & { cache_control?: EphemeralCacheControl };
    last.cache_control = { type: "ephemeral" };
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
