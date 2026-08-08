import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "@helios/ports";

// 用 vi.hoisted 建一个可变持有器，供 mock 工厂与测试共享（规避 vi.mock 提升导致的 TDZ）。
const h = vi.hoisted(() => ({ captured: undefined as unknown }));

vi.mock("@anthropic-ai/sdk", () => {
  async function* fakeStream() {
    yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "abc" } };
    yield { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } };
    yield { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } };
    yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    yield { type: "message_stop" };
  }
  return {
    default: class {
      messages = {
        create: async (params: unknown) => {
          h.captured = params;
          return fakeStream();
        },
      };
    },
  };
});

// 必须在 vi.mock 之后 import（拿到被 mock 的 SDK）。
import { create } from "./index";

async function collect(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

function provider() {
  return create({ options: { apiKey: "x" } } as never);
}

beforeEach(() => {
  h.captured = undefined;
});

describe("AnthropicProvider.streamMessage —— thinking 请求与映射", () => {
  it("thinking 开启：请求带 thinking 参数且省略 temperature", async () => {
    const events = await collect(
      provider().streamMessage(
        [{ id: "u", role: "user", content: "go" }],
        [],
        { thinking: { enabled: true }, temperature: 0.7 },
      ),
    );
    const params = h.captured as { thinking?: unknown; temperature?: unknown };
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(params.temperature).toBeUndefined(); // 互斥：开 thinking 不传 temperature

    expect(events).toEqual([
      { type: "thinking-delta", text: "abc" },
      { type: "thinking-signature", signature: "sig-1" },
      { type: "text-delta", text: "hi" },
      { type: "message-stop", stopReason: "end_turn" },
    ]);
  });

  it("thinking 关闭：不带 thinking，temperature 原样透传", async () => {
    await collect(
      provider().streamMessage(
        [{ id: "u", role: "user", content: "go" }],
        [],
        { temperature: 0.5 },
      ),
    );
    const params = h.captured as { thinking?: unknown; temperature?: unknown };
    expect(params.thinking).toBeUndefined();
    expect(params.temperature).toBe(0.5);
  });

  it("自定义 budgetTokens 透传", async () => {
    await collect(
      provider().streamMessage(
        [{ id: "u", role: "user", content: "go" }],
        [],
        { thinking: { enabled: true, budgetTokens: 32000 } },
      ),
    );
    const params = h.captured as { thinking?: { budget_tokens?: number } };
    expect(params.thinking?.budget_tokens).toBe(32000);
  });
});
