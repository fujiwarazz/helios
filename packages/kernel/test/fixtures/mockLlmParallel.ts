import type { LLMProvider, StreamEvent, Message, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 一次返回两个都声明 executionMode:'parallel' 的 tool_use；收到工具结果后结束。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(messages: Message[]): AsyncGenerator<StreamEvent> {
    const hasToolResult = messages.some((m) => m.role === "toolResult");
    if (!hasToolResult) {
      yield { type: "tool-call-start", id: "a1", name: "par__toolA" };
      yield { type: "tool-call-end", id: "a1" };
      yield { type: "tool-call-start", id: "b1", name: "par__toolB" };
      yield { type: "tool-call-end", id: "b1" };
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
