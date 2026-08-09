import type { LLMProvider, StreamEvent, Message, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// retryable:true 但 retryAfterMs 远超 maxDelayMs（默认 32000ms）——验证 cap 生效：不重试，直接判定失败。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(_messages: Message[]): AsyncGenerator<StreamEvent> {
    yield { type: "error", error: "限流", retryable: true, httpStatus: 429, retryAfterMs: 300000 };
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
