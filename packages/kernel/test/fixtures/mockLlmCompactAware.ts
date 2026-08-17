import type { LLMProvider, StreamEvent, Message, Tool, LLMOptions, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

/**
 * 能区分"压缩请求"与"正常 turn 请求"的假 provider：压缩请求的**最后一条**消息 id 为
 * `compact-request`（inline 路线把它追加在整段历史之后，standalone 路线它是唯一一条），
 * 据此定向注入失败/产物，而正常 turn 照常收尾。
 *
 * 摘要文本里带 `route=inline|standalone`，让测试无需窥探 provider 入参即可断言选路 ——
 * 摘要会原样进 summary 节点，从 session 历史里读得到。
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
    tools: Tool[],
    _opts: LLMOptions,
  ): AsyncGenerator<StreamEvent> {
    const isCompaction = messages[messages.length - 1]?.id === "compact-request";
    if (!isCompaction) {
      yield { type: "text-delta", text: "ok" };
      yield { type: "message-stop", stopReason: "end_turn" };
      return;
    }
    // inline 的判据是"历史仍在请求里"：standalone 只发一条渲染后的消息、且 tools 为空。
    const route = messages.length > 1 ? "inline" : "standalone";
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
        yield {
          type: "text-delta",
          text: `COMPACTED_VIA_LLM route=${route} tools=${tools.length}`,
        };
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
