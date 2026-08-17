import type { CompactPlan, CompactStrategyPort, ConversationState, KernelContext } from "@helios/ports";
import { COMPACT_STRATEGY_PORT_API_VERSION } from "@helios/ports";

// 与 mockCompact 的区别：**不给 precomputed**，因此 kernel 必须真的发一次摘要请求。
// 用于验证 kernel 侧的调用/计量/失败语义（熔断、失败不改写历史）。
const provider: CompactStrategyPort = {
  shouldCompact(state: ConversationState): boolean {
    return state.messages.length >= 2;
  },
  plan(state: ConversationState): CompactPlan {
    return {
      coveredMessageIds: state.messages.map((m) => m.id),
      maxTokens: 128,
      inlineInstruction: "SUMMARIZE_INLINE",
      standalone: { system: "SUMMARIZER_SYSTEM_MARK", userText: "<conversation>...</conversation>" },
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
