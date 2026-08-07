import type { LLMProvider, StreamEvent, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 只思考、不回答、不调工具：验证 thinking-only 轮不计入有效正文、不入历史。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(): AsyncGenerator<StreamEvent> {
    yield { type: "thinking-delta", text: "hmm" };
    yield { type: "message-stop", stopReason: "end_turn" };
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
