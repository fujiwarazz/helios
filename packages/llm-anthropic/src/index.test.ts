import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "@helios/ports";

// 用 vi.hoisted 建一个可变持有器，供 mock 工厂与测试共享（规避 vi.mock 提升导致的 TDZ）。
const h = vi.hoisted(() => ({
  captured: undefined as unknown,
  createImpl: undefined as (() => AsyncGenerator<unknown> | never) | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
  async function* fakeStream() {
    yield {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
          output_tokens: 1,
        },
      },
    };
    yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "abc" } };
    yield { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } };
    yield { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } };
    yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 25 } };
    yield { type: "message_stop" };
  }
  // 最小可用的 APIError/APIUserAbortError 影子实现，形状对齐真实 SDK（status/headers/message），
  // 供 index.ts 的 `instanceof` 判断在测试里也能命中。
  class FakeAPIError extends Error {
    constructor(
      readonly status: number | undefined,
      _error: unknown,
      message: string | undefined,
      readonly headers?: Record<string, string | null | undefined>,
    ) {
      super(message);
    }
  }
  class FakeAPIUserAbortError extends FakeAPIError {
    constructor(opts?: { message?: string }) {
      super(undefined, undefined, opts?.message ?? "Request was aborted", undefined);
    }
  }
  return {
    default: class {
      messages = {
        create: async (params: unknown) => {
          h.captured = params;
          if (h.createImpl) return h.createImpl();
          return fakeStream();
        },
      };
    },
    APIError: FakeAPIError,
    APIUserAbortError: FakeAPIUserAbortError,
  };
});

// 必须在 vi.mock 之后 import（拿到被 mock 的 SDK）。
import { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
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
  h.createImpl = undefined;
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
      {
        type: "message-stop",
        stopReason: "end_turn",
        // usage 归一化：input_tokens→uncached，cache_read→cached，cache_creation→write，output 取 message_delta 累积值。
        usage: {
          uncachedInputTokens: 100,
          cachedInputTokens: 40,
          cacheWriteTokens: 10,
          outputTokens: 25,
        },
      },
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

describe("AnthropicProvider.streamMessage —— issue #10 错误分层", () => {
  it("建连阶段（.create() 本身）抛 429 APIError：变成 error StreamEvent 而不穿透", async () => {
    h.createImpl = () => {
      throw new APIError(429, {}, "rate limited", { "retry-after": "2" });
    };
    const events = await collect(provider().streamMessage([{ id: "u", role: "user", content: "go" }], [], {}));
    expect(events).toEqual([
      { type: "error", error: "rate limited", retryable: true, httpStatus: 429, retryAfterMs: 2000 },
    ]);
  });

  it("流中途抛 500 APIError：retryable=true，无 Retry-After 时 retryAfterMs 为 undefined", async () => {
    h.createImpl = async function* () {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "部分" } };
      throw new APIError(500, {}, "internal error", {});
    };
    const events = await collect(provider().streamMessage([{ id: "u", role: "user", content: "go" }], [], {}));
    expect(events).toEqual([
      { type: "text-delta", text: "部分" },
      { type: "error", error: "internal error", retryable: true, httpStatus: 500, retryAfterMs: undefined },
    ]);
  });

  it("401 APIError：retryable=false（致命错误，请求本身有问题）", async () => {
    h.createImpl = () => {
      throw new APIError(401, {}, "invalid api key", {});
    };
    const events = await collect(provider().streamMessage([{ id: "u", role: "user", content: "go" }], [], {}));
    expect(events).toEqual([
      { type: "error", error: "invalid api key", retryable: false, httpStatus: 401, retryAfterMs: undefined },
    ]);
  });

  it("APIUserAbortError（用户主动 abort）：显式 retryable=false，不因为无 status 被误判成瞬时故障", async () => {
    h.createImpl = () => {
      throw new APIUserAbortError({ message: "aborted" });
    };
    const events = await collect(provider().streamMessage([{ id: "u", role: "user", content: "go" }], [], {}));
    expect(events).toEqual([
      { type: "error", error: "aborted", retryable: false, httpStatus: undefined, retryAfterMs: undefined },
    ]);
  });

  it("非 APIError 的异常（provider 内部 bug）：原样穿透，不被转成 error StreamEvent", async () => {
    h.createImpl = () => {
      throw new TypeError("unexpected bug");
    };
    await expect(collect(provider().streamMessage([{ id: "u", role: "user", content: "go" }], [], {}))).rejects.toThrow(
      TypeError,
    );
  });
});
