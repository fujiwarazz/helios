import type { LLMProvider, StreamEvent, Message, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 先吐一段文本，然后流中途报错（模拟网络抖动/超时）。
const provider: LLMProvider = {
  id: "mock",
  async *streamMessage(_messages: Message[]): AsyncGenerator<StreamEvent> {
    yield { type: "text-delta", text: "部分" };
    yield { type: "error", error: "网络超时" };
    // 报错后不应再被消费（session 应 break 出流）。
    yield { type: "text-delta", text: "不该出现" };
    yield { type: "message-stop", stopReason: "end_turn" };
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
