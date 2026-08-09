import type { LLMProvider, LLMOptions, Message, Tool, StreamEvent, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

/** 供测试断言每次调用实际收到的 messages/system。每个 test 用后需清空。 */
export const calls: Array<{ messages: Message[]; opts: LLMOptions }> = [];

const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(messages, _tools, opts): AsyncGenerator<StreamEvent> {
    calls.push({ messages, opts });
    yield { type: "text-delta", text: "ok" };
    yield { type: "message-stop", stopReason: "end_turn" };
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
