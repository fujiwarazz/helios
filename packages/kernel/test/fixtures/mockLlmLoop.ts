import type { LLMProvider, StreamEvent, Message, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 永远发起工具调用、从不结束，用于触发 maxTurns 上限（Bug 5）。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(_messages: Message[]): AsyncGenerator<StreamEvent> {
    yield { type: "tool-call-start", id: "t", name: "mock__echo" };
    yield { type: "tool-call-delta", id: "t", argsDelta: '{"text":"loop"}' };
    yield { type: "tool-call-end", id: "t" };
    yield { type: "message-stop", stopReason: "tool_use" };
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
