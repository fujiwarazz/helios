import type { LLMProvider, StreamEvent, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 先思考（带签名）后回答：验证 session 累积 thinking 块 + signature，且置于 text 前。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(): AsyncGenerator<StreamEvent> {
    yield { type: "thinking-delta", text: "let me " };
    yield { type: "thinking-delta", text: "think" };
    yield { type: "thinking-signature", signature: "sig-1" };
    yield { type: "text-delta", text: "the answer" };
    yield { type: "message-stop", stopReason: "end_turn" };
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
