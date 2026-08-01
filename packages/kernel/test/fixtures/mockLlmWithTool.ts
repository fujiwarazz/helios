import type { LLMProvider, StreamEvent, Message, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 第一次调用发起工具调用 mock__echo；收到工具结果后返回纯文本结束。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(messages: Message[]): AsyncGenerator<StreamEvent> {
    const hasToolResult = messages.some((m) => m.role === "toolResult");
    if (!hasToolResult) {
      yield { type: "tool-call-start", id: "t1", name: "mock__echo" };
      yield { type: "tool-call-delta", id: "t1", argsDelta: '{"text":"hi"}' };
      yield { type: "tool-call-end", id: "t1" };
      yield { type: "message-stop", stopReason: "tool_use" };
    } else {
      yield { type: "text-delta", text: "done" };
      yield { type: "message-stop", stopReason: "end_turn" };
    }
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
