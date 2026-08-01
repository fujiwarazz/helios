import type { LLMProvider, StreamEvent, KernelContext } from "@helios/ports";

// 故意用不兼容的 apiVersion，应被 PluginLoader 拒绝加载。
export const apiVersion = 999;
export function create(_ctx: KernelContext): LLMProvider {
  return {
    id: "bad",
    async *streamMessage(): AsyncGenerator<StreamEvent> {
      yield { type: "message-stop", stopReason: "end_turn" };
    },
  };
}
export default { apiVersion, create };
