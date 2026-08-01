import type { Message, Tool, LLMOptions, StreamEvent } from "./types";

export const LLM_PROVIDER_API_VERSION = 1;

/**
 * LLM 推理。唯一"必须至少有一个实现"的 Port —— 无 LLM 无法推理。
 * 多实例：可同时注册 anthropic / openai，运行时按 LLMOptions.provider 选用。
 */
export interface LLMProvider {
  /** provider 标识，用于多实例注册与选用 */
  readonly id: string;
  streamMessage(
    messages: Message[],
    tools: Tool[],
    opts: LLMOptions,
  ): AsyncGenerator<StreamEvent>;
}
