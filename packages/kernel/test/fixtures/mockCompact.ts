import type { CompactPlan, CompactStrategyPort, ConversationState, KernelContext } from "@helios/ports";
import { COMPACT_STRATEGY_PORT_API_VERSION } from "@helios/ports";

// 历史消息数 >= 2 时触发压缩，摘要覆盖当前全部消息（coveredMessageIds = 所有 id）。
// precomputed 让 kernel 不发 LLM 请求，产物确定。
const provider: CompactStrategyPort = {
  shouldCompact(state: ConversationState): boolean {
    return state.messages.length >= 2;
  },
  plan(state: ConversationState): CompactPlan {
    return {
      coveredMessageIds: state.messages.map((m) => m.id),
      maxTokens: 128,
      inlineInstruction: "SUMMARIZE",
      standalone: { system: "SUMMARIZER", userText: "CONVERSATION" },
      precomputed: "COMPACTED_SUMMARY",
    };
  },
  parseSummary(raw: string): string | undefined {
    return raw.trim() || undefined;
  },
};

export const apiVersion = COMPACT_STRATEGY_PORT_API_VERSION;
export function create(_ctx: KernelContext): CompactStrategyPort {
  return provider;
}
export default { apiVersion, create };
