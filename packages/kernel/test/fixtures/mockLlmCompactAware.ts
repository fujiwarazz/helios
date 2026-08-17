import type { LLMProvider, StreamEvent, Message, Tool, LLMOptions, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

/**
 * 能区分"压缩请求"与"正常 turn 请求"的假 provider：压缩请求由 kernel 用 id 为
 * `compact-request` 的单条消息发出，据此定向注入失败/产物，而正常 turn 照常收尾。
 *
 * 行为由 env 控制（fixture 经 pluginLoader 动态 import，拿不到测试传参）：
 * - HELIOS_TEST_COMPACT_MODE=error  → 压缩请求走 Result 通道报错（模拟限流）
 * - HELIOS_TEST_COMPACT_MODE=throw  → 压缩请求直接抛（模拟连接中断）
 * - HELIOS_TEST_COMPACT_MODE=empty  → 压缩请求返回空白文本（parseSummary 判不可用）
 * - 其他/未设置                      → 返回一份正常摘要 COMPACTED_VIA_LLM
 */
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(
    messages: Message[],
    _tools: Tool[],
    _opts: LLMOptions,
  ): AsyncGenerator<StreamEvent> {
    const isCompaction = messages[0]?.id === "compact-request";
    if (!isCompaction) {
      yield { type: "text-delta", text: "ok" };
      yield { type: "message-stop", stopReason: "end_turn" };
      return;
    }
    switch (process.env.HELIOS_TEST_COMPACT_MODE) {
      case "error":
        yield { type: "error", error: "rate limited", retryable: true };
        return;
      case "throw":
        throw new Error("connection reset");
      case "empty":
        yield { type: "text-delta", text: "   " };
        yield { type: "message-stop", stopReason: "end_turn" };
        return;
      default:
        yield { type: "text-delta", text: "COMPACTED_VIA_LLM" };
        yield {
          type: "message-stop",
          stopReason: "end_turn",
          usage: {
            uncachedInputTokens: 900,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 40,
          },
        };
    }
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
