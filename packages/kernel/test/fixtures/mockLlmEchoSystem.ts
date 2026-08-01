import type { LLMProvider, StreamEvent, Message, Tool, LLMOptions, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 把收到的 system 原样作为文本输出，便于测试断言 system 注入内容（memory / compacted 摘要）。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(_messages: Message[], _tools: Tool[], opts: LLMOptions): AsyncGenerator<StreamEvent> {
    yield { type: "text-delta", text: opts.system ?? "" };
    yield { type: "message-stop", stopReason: "end_turn" };
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
