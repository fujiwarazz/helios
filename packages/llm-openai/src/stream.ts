import type { StreamEvent, StopReason, Usage } from "@helios/ports";
import { mapFinishReason } from "./convert";

/** OpenAI 流式 chunk 的最小结构（便于 fixture 单测，不强绑 SDK 类型）。 */
export interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** 非标准字段：DeepSeek-R1 等推理模型把思考过程放这里，归一化为 thinking-delta。 */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  /** 需请求带 stream_options:{include_usage:true}；通常在末尾 choices 为空的 chunk 上出现。 */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

/** OpenAI usage → 统一 Usage：uncached = prompt - cached，cached 单列，OpenAI 无 cache write。 */
function toUsage(u: NonNullable<OpenAIChunk["usage"]>): Usage {
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = u.prompt_tokens ?? 0;
  return {
    uncachedInputTokens: Math.max(0, prompt - cached),
    cachedInputTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: u.completion_tokens ?? 0,
    promptTokens: u.prompt_tokens != null ? prompt : undefined,
  };
}

/**
 * 将 OpenAI chat.completions 流映射为统一 StreamEvent。
 * 工具调用增量按数组下标 index 分片：id/name 仅首个 delta 出现，
 * 后续只有 arguments 片段，需 index→id 映射拼接。
 */
export async function* mapOpenAIStream(
  chunks: AsyncIterable<OpenAIChunk>,
): AsyncGenerator<StreamEvent> {
  const indexToId = new Map<number, string>();
  const order: string[] = [];
  let sawFinish = false;
  let stopReason: StopReason = "end_turn";
  let usage: Usage | undefined;

  for await (const chunk of chunks) {
    // usage 可能在 choices 为空的末尾 chunk 上单独到达（include_usage）。
    if (chunk.usage) usage = toUsage(chunk.usage);

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
    if (delta?.reasoning_content) {
      yield { type: "thinking-delta", text: delta.reasoning_content };
    }
    if (delta?.content) {
      yield { type: "text-delta", text: delta.content };
    }
    for (const tc of delta?.tool_calls ?? []) {
      if (tc.id && !indexToId.has(tc.index)) {
        indexToId.set(tc.index, tc.id);
        order.push(tc.id);
        yield { type: "tool-call-start", id: tc.id, name: tc.function?.name ?? "" };
      }
      const argsDelta = tc.function?.arguments;
      if (argsDelta) {
        const id = indexToId.get(tc.index);
        if (id) yield { type: "tool-call-delta", id, argsDelta };
      }
    }

    // 收到 finish_reason 即关闭工具块并记录停因；message-stop 延到流末尾统一 emit（等 usage）。
    if (choice.finish_reason && !sawFinish) {
      for (const id of order) yield { type: "tool-call-end", id };
      stopReason = mapFinishReason(choice.finish_reason);
      sawFinish = true;
    }
  }

  if (!sawFinish) {
    for (const id of order) yield { type: "tool-call-end", id };
  }
  yield { type: "message-stop", stopReason, usage };
}
