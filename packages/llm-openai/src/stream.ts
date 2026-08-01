import type { StreamEvent } from "@helios/ports";
import { mapFinishReason } from "./convert";

/** OpenAI 流式 chunk 的最小结构（便于 fixture 单测，不强绑 SDK 类型）。 */
export interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
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
  let finished = false;

  for await (const chunk of chunks) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
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

    if (choice.finish_reason) {
      for (const id of order) yield { type: "tool-call-end", id };
      yield { type: "message-stop", stopReason: mapFinishReason(choice.finish_reason) };
      finished = true;
    }
  }

  if (!finished) {
    for (const id of order) yield { type: "tool-call-end", id };
    yield { type: "message-stop", stopReason: "end_turn" };
  }
}
