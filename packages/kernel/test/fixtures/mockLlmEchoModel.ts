import type { LLMProvider, StreamEvent, Message, Tool, LLMOptions, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 回显收到的 model（供验证 ModelRouter 是否改写 model）+ 携带 usage。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(_m: Message[], _t: Tool[], opts: LLMOptions): AsyncGenerator<StreamEvent> {
    yield { type: "text-delta", text: `MODEL=${opts.model ?? "none"}` };
    yield {
      type: "message-stop",
      stopReason: "end_turn",
      usage: { uncachedInputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 3 },
    };
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
