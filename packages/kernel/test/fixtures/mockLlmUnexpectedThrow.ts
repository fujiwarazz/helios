import type { LLMProvider, StreamEvent, Message, KernelContext } from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";

// 模拟 provider 内部代码 bug（非 SDK APIError）：直接 throw，不落任何 error StreamEvent——
// 验证"非预期错误"穿透到 session.sendMessage() reject，且被 normalizeLlmError 归一化。
const provider: LLMProvider = {
  id: "mock",
  // eslint-disable-next-line require-yield
  async *streamMessage(_messages: Message[]): AsyncGenerator<StreamEvent> {
    throw new TypeError("provider 内部 bug");
  },
};

export const apiVersion = LLM_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): LLMProvider {
  return provider;
}
export default { apiVersion, create };
