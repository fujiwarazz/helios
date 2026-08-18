import type { CompactPlan, CompactStrategyPort, ConversationState, KernelContext } from "@helios/ports";
import { COMPACT_STRATEGY_PORT_API_VERSION } from "@helios/ports";

// 一次性压缩策略：全局仅触发一次（首次路径长度 >= 4 时），覆盖「除最后一条外」的所有消息。
// 用于精确控制“只在主线的某一 run 压缩一次”，从而构造 tail[0] 为共享节点的拓扑来回归 Q3。
let fired = false;
const provider: CompactStrategyPort = {
  // "只触发一次"的状态记在 shouldCompact 而非 plan：契约要求 plan() 是纯函数。
  shouldCompact(state: ConversationState): boolean {
    if (fired || state.messages.length < 4) return false;
    fired = true;
    return true;
  },
  plan(state: ConversationState): CompactPlan {
    return {
      coveredMessageIds: state.messages.slice(0, -1).map((m) => m.id), // 保留最后一条（tail[0]=当前叶子）
      maxTokens: 128,
      inlineInstruction: "SUMMARIZE",
      standalone: { system: "SUMMARIZER", userText: "CONVERSATION" },
      precomputed: "COMPACTED_ONCE",
    };
  },
  parseSummary(raw: string): string | undefined {
    return raw.trim() || undefined;
  },
};

export const apiVersion = COMPACT_STRATEGY_PORT_API_VERSION;
export function create(_ctx: KernelContext): CompactStrategyPort {
  fired = false; // 每次 create（每个测试）重置
  return provider;
}
export default { apiVersion, create };
