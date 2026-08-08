import type { CompactStrategyPort, ConversationState, Message, Summary, KernelContext } from "@helios/ports";
import { COMPACT_STRATEGY_PORT_API_VERSION } from "@helios/ports";

// 一次性压缩策略：全局仅触发一次（首次路径长度 >= 4 时），覆盖「除最后一条外」的所有消息。
// 用于精确控制“只在主线的某一 run 压缩一次”，从而构造 tail[0] 为共享节点的拓扑来回归 Q3。
let fired = false;
const provider: CompactStrategyPort = {
  shouldCompact(state: ConversationState): boolean {
    return !fired && state.messages.length >= 4;
  },
  async compact(messages: Message[]): Promise<Summary> {
    fired = true;
    const covered = messages.slice(0, -1).map((m) => m.id); // 保留最后一条（tail[0]=当前叶子）
    return { text: "COMPACTED_ONCE", coveredMessageIds: covered };
  },
};

export const apiVersion = COMPACT_STRATEGY_PORT_API_VERSION;
export function create(_ctx: KernelContext): CompactStrategyPort {
  fired = false; // 每次 create（每个测试）重置
  return provider;
}
export default { apiVersion, create };
