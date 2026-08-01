import type {
  CompactStrategyPort,
  ConversationState,
  Message,
  Summary,
  ContentBlock,
  KernelContext,
} from "@helios/ports";
import { COMPACT_STRATEGY_PORT_API_VERSION } from "@helios/ports";

// @helios/compact-default —— CompactStrategyPort 官方实现。
// 触发：approxTokens 超阈值。压缩：朴素抽取（首尾文本 + 计数），不调用 LLM。
// 用户可换成基于真实 tokenizer + 分层压缩的实现。

const DEFAULT_THRESHOLD = 12_000;

class DefaultCompact implements CompactStrategyPort {
  constructor(private readonly threshold: number) {}

  shouldCompact(state: ConversationState): boolean {
    return state.approxTokens > this.threshold;
  }

  async compact(messages: Message[]): Promise<Summary> {
    const ids = messages.map((m) => m.id);
    const texts = messages.map((m) => `${m.role}: ${truncate(textOf(m.content), 200)}`);
    const head = texts.slice(0, 2);
    const tail = texts.slice(-3);
    const body =
      texts.length > 5
        ? [...head, `… (省略 ${texts.length - 5} 条) …`, ...tail]
        : texts;
    return {
      text: `# 对话摘要（${messages.length} 条消息）\n${body.join("\n")}`,
      coveredMessageIds: ids,
    };
  }
}

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_use") return `[tool_use ${b.name}]`;
      if (b.type === "tool_result") return `[tool_result]`;
      return "";
    })
    .join(" ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export const apiVersion = COMPACT_STRATEGY_PORT_API_VERSION;

export function create(ctx: KernelContext): CompactStrategyPort {
  const threshold = Number((ctx.options?.threshold as number) ?? DEFAULT_THRESHOLD);
  return new DefaultCompact(threshold);
}

export default { apiVersion, create };
