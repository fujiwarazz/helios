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
    // extended thinking 与 temperature 互斥（Anthropic 硬约束）：开 thinking 时不传 temperature。
    // 注：SDK 0.32 类型未覆盖 thinking，此处窄类型旁路（运行时服务端/网关按 JSON 透传）。
    const thinkingOn = opts.thinking?.enabled === true;
    const thinking = thinkingOn
      ? { type: "enabled" as const, budget_tokens: opts.thinking?.budgetTokens ?? 10000 }
      : undefined;

    const createParams = {
      model: opts.model ?? this.defaultModel,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: thinkingOn ? undefined : opts.temperature,
      system: opts.system,
      messages: toAnthropicMessages(messages),
      tools: tools.length ? toAnthropicTools(tools) : undefined,
      stream: true as const,
      ...(thinking ? { thinking } : {}),
    };
    const stream = await this.client.messages.create(
      createParams as unknown as Anthropic.MessageCreateParamsStreaming,
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
            // ⚠️ 已知降级（S2）：redacted_thinking 块（type=redacted_thinking，内容在 data 字段、
            // 无 delta）当前不透传——统一 StreamEvent 尚无对应事件，故静默丢弃。若该轮含 tool_use，
            // 同样存在 thinking-precede-tool_use 的 400 边界（见 convert.ts S1 注释）。opaque 保真透传
            // 需新增 StreamEvent/ContentBlock，对罕见场景不成比例，暂作降级并在 doc 记录。
            break;
          }
          case "content_block_delta": {
            // SDK 0.32 的 delta 联合类型不含 thinking_delta/signature_delta，
            // 但运行时事件对象会带这些字段，故窄类型旁路读取。
            const delta = event.delta as
              | { type: "text_delta"; text: string }
              | { type: "input_json_delta"; partial_json: string }
              | { type: "thinking_delta"; thinking: string }
              | { type: "signature_delta"; signature: string };
            if (delta.type === "text_delta") {
              yield { type: "text-delta", text: delta.text };
            } else if (delta.type === "thinking_delta") {
              yield { type: "thinking-delta", text: delta.thinking };
            } else if (delta.type === "signature_delta") {
              yield { type: "thinking-signature", signature: delta.signature };
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
