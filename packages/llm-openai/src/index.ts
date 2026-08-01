import OpenAI from "openai";
import type {
  LLMProvider,
  KernelContext,
  Message,
  Tool,
  LLMOptions,
  StreamEvent,
} from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";
import { toOpenAIMessages, toOpenAITools } from "./convert";
import { mapOpenAIStream, type OpenAIChunk } from "./stream";

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
    const stream = await this.client.chat.completions.create({
      model: opts.model ?? this.defaultModel,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature,
      messages: toOpenAIMessages(messages, opts.system),
      tools: tools.length ? toOpenAITools(tools) : undefined,
      stream: true,
    });
    yield* mapOpenAIStream(stream as AsyncIterable<OpenAIChunk>);
  }
}

export const apiVersion = LLM_PROVIDER_API_VERSION;

export function create(ctx: KernelContext): LLMProvider {
  return new OpenAIProvider((ctx.options ?? {}) as OpenAIOptions);
}

export default { apiVersion, create };
