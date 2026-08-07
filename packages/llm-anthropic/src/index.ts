import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  KernelContext,
  Message,
  Tool,
  LLMOptions,
  StreamEvent,
} from "@helios/ports";
import { LLM_PROVIDER_API_VERSION } from "@helios/ports";
import {
  toAnthropicMessages,
  toAnthropicTools,
  mapStopReason,
} from "./convert";

const DEFAULT_MODEL = "claude-3-5-sonnet-latest";

interface AnthropicOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

/**
 * @helios/llm-anthropic —— LLMProvider 官方实现。
 * 处理 Anthropic 流式协议：content block 按 index 分片，
 * input_json_delta 逐片拼接工具入参，映射为统一 StreamEvent。
 */
class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  private readonly client: Anthropic;
  private readonly defaultModel: string;

  constructor(opts: AnthropicOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: opts.baseURL,
    });
    this.defaultModel = opts.model ?? DEFAULT_MODEL;
  }

  async *streamMessage(
    messages: Message[],
    tools: Tool[],
    opts: LLMOptions,
  ): AsyncGenerator<StreamEvent> {
    const thinkingOn = opts.thinking?.enabled === true;
    const budget = opts.thinking?.budgetTokens ?? 2048;
    // thinking 开启时:max_tokens 必须 > budget；temperature 必须为默认(不可自定义)。
    const maxTokens = opts.maxTokens ?? 4096;
    const stream = await this.client.messages.create(
      {
        model: opts.model ?? this.defaultModel,
        max_tokens: thinkingOn ? Math.max(maxTokens, budget + 1024) : maxTokens,
        temperature: thinkingOn ? undefined : opts.temperature,
        system: opts.system,
        messages: toAnthropicMessages(messages),
        tools: tools.length ? toAnthropicTools(tools) : undefined,
        ...(thinkingOn
          ? { thinking: { type: "enabled" as const, budget_tokens: budget } }
          : {}),
        stream: true,
      },
      { signal: opts.signal },
    );

    // index → tool_use 的 block id，用于把 input_json_delta 归到正确的工具调用
    const indexToToolId = new Map<number, string>();
    let stopReason = "end_turn";

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "tool_use") {
              indexToToolId.set(event.index, block.id);
              yield { type: "tool-call-start", id: block.id, name: block.name };
            }
            break;
          }
          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              yield { type: "text-delta", text: delta.text };
            } else if (delta.type === "thinking_delta") {
              yield { type: "thinking-delta", text: delta.thinking };
            } else if (delta.type === "input_json_delta") {
              const id = indexToToolId.get(event.index);
              if (id) yield { type: "tool-call-delta", id, argsDelta: delta.partial_json };
            }
            break;
          }
          case "content_block_stop": {
            const id = indexToToolId.get(event.index);
            if (id) yield { type: "tool-call-end", id };
            break;
          }
          case "message_delta": {
            if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
            break;
          }
          case "message_stop":
            break;
          default:
            break;
        }
      }
      yield { type: "message-stop", stopReason: mapStopReason(stopReason) };
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const apiVersion = LLM_PROVIDER_API_VERSION;

export function create(ctx: KernelContext): LLMProvider {
  const opts = (ctx.options ?? {}) as AnthropicOptions;
  return new AnthropicProvider(opts);
}

export default { apiVersion, create };
