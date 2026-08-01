import type { LLMProvider, StreamEvent, LLMOptions, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 每一 turn 都发起工具调用 → 若不中断会一直循环到 maxTurns。
// 尊重 opts.signal：模拟真实 SDK 行为，收到已中止 signal 时抛错（AbortError 语义）。
// 每次流开始前留一个时间窗口，给外部 cancel() 机会介入。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(
    _messages,
    _tools,
    opts: LLMOptions,
  ): AsyncGenerator<StreamEvent> {
    await new Promise((r) => setTimeout(r, 15));
    if (opts.signal?.aborted) {
      throw new Error("aborted by signal");
    }
    yield { type: "tool-call-start", id: "loop", name: "mock__echo" };
    yield { type: "tool-call-delta", id: "loop", argsDelta: '{"text":"x"}' };
    yield { type: "tool-call-end", id: "loop" };
    yield { type: "message-stop", stopReason: "tool_use" };
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
