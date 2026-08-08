import type { LLMProvider, StreamEvent, Message, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 输出被截断（max_tokens）：工具参数碰巧是合法 JSON，但仍应被判失败而非执行（不能靠 JSON.parse 偶然抛错兜底）。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(messages: Message[]): AsyncGenerator<StreamEvent> {
    const hasToolResult = messages.some((m) => m.role === "toolResult");
    if (!hasToolResult) {
      yield { type: "tool-call-start", id: "t1", name: "mock__echo" };
      yield { type: "tool-call-delta", id: "t1", argsDelta: '{"text":"hi"}' };
      yield { type: "tool-call-end", id: "t1" };
      yield { type: "message-stop", stopReason: "max_tokens" };
    } else {
      yield { type: "text-delta", text: "recovered" };
      yield { type: "message-stop", stopReason: "end_turn" };
    }
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
