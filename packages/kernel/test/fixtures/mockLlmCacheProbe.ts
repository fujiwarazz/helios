import type { LLMProvider, StreamEvent, Message, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 每个 run：无 toolResult 时调用可缓存工具 probe__cache_probe，收到结果后结束。均带 usage。
const USAGE = { uncachedInputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 4 };

const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(messages: Message[]): AsyncGenerator<StreamEvent> {
    // 按"最后一条消息"判断（而非全历史），使每个 run 都恰好调用一次工具：
    // run 起点最后一条是 user → 调工具；执行后最后一条变 toolResult → 结束。
    const last = messages[messages.length - 1];
    const awaitingTool = !last || last.role !== "toolResult";
    if (awaitingTool) {
      yield { type: "tool-call-start", id: "c1", name: "probe__cache_probe" };
      yield { type: "tool-call-delta", id: "c1", argsDelta: "{}" };
      yield { type: "tool-call-end", id: "c1" };
      yield { type: "message-stop", stopReason: "tool_use", usage: USAGE };
    } else {
      yield { type: "text-delta", text: "done" };
      yield { type: "message-stop", stopReason: "end_turn", usage: USAGE };
    }
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
