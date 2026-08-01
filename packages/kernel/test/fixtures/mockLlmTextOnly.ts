import type { LLMProvider, StreamEvent, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(): AsyncGenerator<StreamEvent> {
    yield { type: "text-delta", text: "Hello " };
    yield { type: "text-delta", text: "world" };
    yield { type: "message-stop", stopReason: "end_turn" };
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
