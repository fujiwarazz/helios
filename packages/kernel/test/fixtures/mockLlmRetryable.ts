import type { LLMProvider, StreamEvent, Message, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 前 2 次返回可重试错误（模拟 429），第 3 次成功——验证 runTurnLoop 的 backoff 重试路径。
let callCount = 0;

const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(_messages: Message[]): AsyncGenerator<StreamEvent> {
    callCount++;
    if (callCount <= 2) {
      yield { type: "error", error: "限流", retryable: true, httpStatus: 429 };
      return;
    }
    yield { type: "text-delta", text: "重试后成功" };
    yield { type: "message-stop", stopReason: "end_turn" };
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
