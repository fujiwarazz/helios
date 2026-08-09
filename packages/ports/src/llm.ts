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

/**
 * 429（限流）/5xx（服务端错误）/529（Anthropic 过载）及无 status 的连接类错误（超时/网络中断，
 * SDK 未拿到 HTTP 响应）视为可重试的瞬时故障；其余 4xx（400/401/403/404/422 等，请求本身有问题）
 * 视为致命错误，不应重试。两个 provider（llm-anthropic/llm-openai）共用同一份判断逻辑。
 */
export function isRetryableHttpStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 429 || status === 529 || (status >= 500 && status < 600);
}

