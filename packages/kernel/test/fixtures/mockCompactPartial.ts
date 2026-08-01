import type { CompactStrategyPort, ConversationState, Message, Summary, KernelContext } from "@helios/ports";
import { COMPACT_STRATEGY_PORT_API_VERSION } from "@helios/ports";

// 部分覆盖策略：路径 >= 2 时触发，只覆盖「除最后一条外」的所有消息，
// 用于验证未被覆盖的近端 tail 不会被静默丢弃（re-parent 到 summary 之后）。
const provider: CompactStrategyPort = {
  shouldCompact(state: ConversationState): boolean {
    return state.messages.length >= 2;
  },
  async compact(messages: Message[]): Promise<Summary> {
    const covered = messages.slice(0, -1).map((m) => m.id); // 保留最后一条不压
    return { text: "COMPACTED_PARTIAL", coveredMessageIds: covered };
  },
};

export const apiVersion = COMPACT_STRATEGY_PORT_API_VERSION;
export function create(_ctx: KernelContext): CompactStrategyPort {
  return provider;
}
export default { apiVersion, create };
