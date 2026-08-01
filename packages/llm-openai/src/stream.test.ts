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

  it("falls back to end_turn when stream ends without finish_reason", async () => {
    const events = await collect([{ choices: [{ delta: { content: "hi" } }] }]);
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "message-stop", stopReason: "end_turn" },
    ]);
  });
});
