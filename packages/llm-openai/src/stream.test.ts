import { describe, it, expect } from "vitest";
import type { StreamEvent } from "@helios/ports";
import { mapOpenAIStream, type OpenAIChunk } from "./stream";

async function* feed(chunks: OpenAIChunk[]): AsyncGenerator<OpenAIChunk> {
  for (const c of chunks) yield c;
}

async function collect(chunks: OpenAIChunk[]): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of mapOpenAIStream(feed(chunks))) out.push(ev);
  return out;
}

describe("mapOpenAIStream", () => {
  it("emits text-delta then message-stop end_turn", async () => {
    const events = await collect([
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    expect(events).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " world" },
      { type: "message-stop", stopReason: "end_turn" },
    ]);
  });

  it("reads a gateway completed message when a stream chunk has no delta", async () => {
    const events = await collect([
      { choices: [{ message: { content: "你好" }, finish_reason: "stop" }] },
    ]);
    expect(events).toEqual([
      { type: "text-delta", text: "你好" },
      { type: "message-stop", stopReason: "end_turn" },
    ]);
  });

  it("splits a single tool call across index-based deltas", async () => {
    const events = await collect([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "Write", arguments: '{"path":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    expect(events).toEqual([
      { type: "tool-call-start", id: "call_1", name: "Write" },
      { type: "tool-call-delta", id: "call_1", argsDelta: '{"path":' },
      { type: "tool-call-delta", id: "call_1", argsDelta: '"a.txt"}' },
      { type: "tool-call-end", id: "call_1" },
      { type: "message-stop", stopReason: "tool_use" },
    ]);
  });

  it("handles parallel tool calls by distinct index", async () => {
    const events = await collect([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "a", function: { name: "Read", arguments: "{}" } },
                { index: 1, id: "b", function: { name: "Glob", arguments: "" } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 1, function: { arguments: '{"p":1}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    expect(events).toEqual([
      { type: "tool-call-start", id: "a", name: "Read" },
      { type: "tool-call-delta", id: "a", argsDelta: "{}" },
      { type: "tool-call-start", id: "b", name: "Glob" },
      { type: "tool-call-delta", id: "b", argsDelta: '{"p":1}' },
      { type: "tool-call-end", id: "a" },
      { type: "tool-call-end", id: "b" },
      { type: "message-stop", stopReason: "tool_use" },
    ]);
  });

  it("maps reasoning_content to thinking-delta before text", async () => {
    const events = await collect([
      { choices: [{ delta: { reasoning_content: "let me think" } }] },
      { choices: [{ delta: { reasoning_content: " more" } }] },
      { choices: [{ delta: { content: "answer" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    expect(events).toEqual([
      { type: "thinking-delta", text: "let me think" },
      { type: "thinking-delta", text: " more" },
      { type: "text-delta", text: "answer" },
      { type: "message-stop", stopReason: "end_turn" },
    ]);
  });

  it("falls back to end_turn when stream ends without finish_reason", async () => {
    const events = await collect([{ choices: [{ delta: { content: "hi" } }] }]);
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "message-stop", stopReason: "end_turn" },
    ]);
  });

  it("normalizes usage from trailing include_usage chunk (uncached = prompt - cached)", async () => {
    const events = await collect([
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      // 末尾 choices 为空、仅带 usage 的 chunk（stream_options.include_usage）
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } },
    ]);
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      {
        type: "message-stop",
        stopReason: "end_turn",
        usage: {
          uncachedInputTokens: 60, // prompt(100) - cached(40)
          cachedInputTokens: 40,
          cacheWriteTokens: 0, // OpenAI 无 cache write
          outputTokens: 20,
          promptTokens: 100,
        },
      },
    ]);
  });

  it("emits message-stop exactly once even when usage arrives after finish_reason", async () => {
    const events = await collect([
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    // 关键：finish_reason 只设停因，message-stop 延到流末尾统一 emit —— 不能出现两次
    const stops = events.filter((e) => e.type === "message-stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toEqual({
      type: "message-stop",
      stopReason: "end_turn",
      usage: { uncachedInputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5, promptTokens: 10 },
    });
  });
});
