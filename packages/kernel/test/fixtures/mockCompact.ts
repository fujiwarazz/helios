import type { CompactStrategyPort, ConversationState, Message, Summary, KernelContext } from "@helios/ports";
import { COMPACT_STRATEGY_PORT_API_VERSION } from "@helios/ports";

// 历史消息数 >= 2 时触发压缩，摘要覆盖当前全部消息（coveredMessageIds = 所有 id）。
const provider: CompactStrategyPort = {
  shouldCompact(state: ConversationState): boolean {
    return state.messages.length >= 2;
  },
  async compact(messages: Message[]): Promise<Summary> {
    return { text: "COMPACTED_SUMMARY", coveredMessageIds: messages.map((m) => m.id) };
  },
};

export const apiVersion = COMPACT_STRATEGY_PORT_API_VERSION;
export function create(_ctx: KernelContext): CompactStrategyPort {
  return provider;
}
export default { apiVersion, create };
