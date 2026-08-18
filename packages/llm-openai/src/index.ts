import OpenAI, { APIError, APIUserAbortError } from "openai";
import type {
  LLMProvider,
  KernelContext,
  Message,
  Tool,
  LLMOptions,
  StreamEvent,
} from "@helios/ports";
import { LLM_PROVIDER_API_VERSION, isRetryableHttpStatus } from "@helios/ports";
import { toOpenAIMessages, toOpenAITools } from "./convert";
import { mapOpenAIStream, type OpenAIChunk } from "./stream";

/** 从 SDK 错误的 `Retry-After` 响应头解析毫秒数；解析失败/不存在返回 undefined。 */
function extractRetryAfterMs(err: APIError): number | undefined {
  const raw = err.headers?.["retry-after"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

const DEFAULT_MODEL = "gpt-4o";

interface OpenAIOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

/**
 * @helios/llm-openai —— LLMProvider 官方实现（验证 LLMProvider 本身也可插拔）。
 * 处理 OpenAI 流式协议：delta.tool_calls 按数组 index 分片，见 stream.ts。
 * 支持自定义 baseURL，兼容任意 OpenAI 协议网关。
 */
class OpenAIProvider implements LLMProvider {
  readonly id = "openai";
  /** OpenAI 及兼容网关自动缓存公共前缀，请求侧无断点可打（`prompt_cache_key` 只是路由提示）。 */
  readonly caching = "automatic" as const;
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(opts: OpenAIOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? "",
      baseURL: opts.baseURL,
    });
    this.defaultModel = opts.model ?? DEFAULT_MODEL;
  }

  async *streamMessage(
    messages: Message[],
    tools: Tool[],
    opts: LLMOptions,
  ): AsyncGenerator<StreamEvent> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: opts.model ?? this.defaultModel,
          max_tokens: opts.maxTokens ?? 4096,
          temperature: opts.temperature,
          messages: toOpenAIMessages(messages, opts.system),
          tools: tools.length ? toOpenAITools(tools) : undefined,
          stream: true,
          // 让末尾 chunk 携带 usage，供 CostMeter 计量。
          stream_options: { include_usage: true },
        },
        { signal: opts.signal },
      );
      yield* mapOpenAIStream(stream as AsyncIterable<OpenAIChunk>);
    } catch (err) {
      // 预期错误（SDK APIError：429/5xx/401/网络类）转成 Result 通道；非预期错误（我们自己代码的
      // bug）原样穿透，不吞。
      if (!(err instanceof APIError)) throw err;
      const isAbort = err instanceof APIUserAbortError;
      yield {
        type: "error",
        error: err.message,
        retryable: isAbort ? false : isRetryableHttpStatus(err.status),
        httpStatus: err.status,
        retryAfterMs: isAbort ? undefined : extractRetryAfterMs(err),
      };
    }
  }
}

export const apiVersion = LLM_PROVIDER_API_VERSION;

export function create(ctx: KernelContext): LLMProvider {
  return new OpenAIProvider((ctx.options ?? {}) as OpenAIOptions);
}

export default { apiVersion, create };
