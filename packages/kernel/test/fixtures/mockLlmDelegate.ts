import type { LLMProvider, StreamEvent, Message, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 首轮调用 delegator__delegate，收到结果后文本结束。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(messages: Message[]): AsyncGenerator<StreamEvent> {
    const hasToolResult = messages.some((m) => m.role === "toolResult");
    if (!hasToolResult) {
      yield { type: "tool-call-start", id: "d1", name: "delegator__delegate" };
      yield { type: "tool-call-delta", id: "d1", argsDelta: '{"task":"build"}' };
      yield { type: "tool-call-end", id: "d1" };
      yield { type: "message-stop", stopReason: "tool_use" };
    } else {
      yield { type: "text-delta", text: "ok" };
      yield { type: "message-stop", stopReason: "end_turn" };
    }
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
