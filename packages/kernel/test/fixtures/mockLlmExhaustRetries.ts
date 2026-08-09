import type { LLMProvider, StreamEvent, Message, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 永远返回可重试错误——验证重试耗尽（默认 maxRetries=3）后落到现有 agent_end.error 优雅结束路径。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(_messages: Message[]): AsyncGenerator<StreamEvent> {
    yield { type: "error", error: "服务暂不可用", retryable: true, httpStatus: 503 };
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
