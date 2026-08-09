import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "@helios/ports";

// 用 vi.hoisted 建一个可变持有器，供 mock 工厂与测试共享（规避 vi.mock 提升导致的 TDZ）。
const h = vi.hoisted(() => ({
  captured: undefined as unknown,
  createImpl: undefined as (() => AsyncIterable<unknown>) | undefined,
}));

vi.mock("openai", () => {
  async function* fakeStream() {
    yield { choices: [{ delta: { content: "hi" }, finish_reason: null }] };
    yield { choices: [{ delta: {}, finish_reason: "stop" }] };
  }
  // 最小可用的 APIError/APIUserAbortError 影子实现，形状对齐真实 SDK（status/headers/message）。
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
      chat = {
        completions: {
          create: async (params: unknown) => {
            h.captured = params;
            if (h.createImpl) return h.createImpl();
            return fakeStream();
          },
        },
      };
    },
    APIError: FakeAPIError,
    APIUserAbortError: FakeAPIUserAbortError,
  };
});

// 必须在 vi.mock 之后 import（拿到被 mock 的 SDK）。
import { APIError, APIUserAbortError } from "openai";
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

describe("OpenAIProvider.streamMessage —— issue #10 错误分层", () => {
  it("正常流：不受错误分层改动影响", async () => {
    const events = await collect(provider().streamMessage([{ id: "u", role: "user", content: "go" }], [], {}));
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "message-stop", stopReason: "end_turn", usage: undefined },
    ]);
  });

  it("建连阶段（.create() 本身）抛 429 APIError：变成 error StreamEvent 而不穿透", async () => {
    h.createImpl = () => {
      throw new APIError(429, {}, "rate limited", { "retry-after": "2" });
    };
    const events = await collect(provider().streamMessage([{ id: "u", role: "user", content: "go" }], [], {}));
    expect(events).toEqual([
      { type: "error", error: "rate limited", retryable: true, httpStatus: 429, retryAfterMs: 2000 },
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

  it("APIUserAbortError（用户主动 abort）：显式 retryable=false", async () => {
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
