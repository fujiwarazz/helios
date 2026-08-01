import type { LLMProvider, StreamEvent, Message, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 第一次调用发起 Write 工具写 roll.txt；收到工具结果后返回纯文本结束。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(messages: Message[]): AsyncGenerator<StreamEvent> {
    const hasToolResult = messages.some((m) => m.role === "toolResult");
    if (!hasToolResult) {
      yield { type: "tool-call-start", id: "w1", name: "Write" };
      yield {
        type: "tool-call-delta",
        id: "w1",
        argsDelta: JSON.stringify({ file_path: "roll.txt", content: "after-turn\n" }),
      };
      yield { type: "tool-call-end", id: "w1" };
      yield { type: "message-stop", stopReason: "tool_use" };
    } else {
      yield { type: "text-delta", text: "写好了" };
      yield { type: "message-stop", stopReason: "end_turn" };
    }
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
