import type { Message, Tool, LLMOptions, StreamEvent } from "./types";

export const LLM_PROVIDER_API_VERSION = 1;

/**
 * provider 的前缀缓存形态。决定上层能不能靠"追加到已有前缀之后"省钱：
 * - `manual`：需要请求里显式打断点才缓存（Anthropic 的 `cache_control`）
 * - `automatic`：服务端自动缓存公共前缀，请求侧无需声明（OpenAI / DeepSeek）
 * - `none`：不缓存，任何"复用前缀"的优化都不成立
 *
 * 刻意不抽象成"打断点"接口：manual 只有 Anthropic 一个实例，且 Gemini 的显式上下文缓存
 * 是资源生命周期形态（先创建缓存对象再引用），塞不进断点模型。此处只暴露上层做路由决策
 * 所需的最小信息，断点怎么打仍由各 provider 自己在内部决定。
 */
export type CachingMode = "manual" | "automatic" | "none";

/**
 * LLM 推理。唯一"必须至少有一个实现"的 Port —— 无 LLM 无法推理。
 * 多实例：可同时注册 anthropic / openai，运行时按 LLMOptions.provider 选用。
 */
export interface LLMProvider {
  /** provider 标识，用于多实例注册与选用 */
  readonly id: string;
  /** 前缀缓存形态；缺省视为 `automatic`（多数 OpenAI 兼容网关的实际行为）。 */
  readonly caching?: CachingMode;
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

