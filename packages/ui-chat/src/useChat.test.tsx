// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, renderHook, cleanup } from "@testing-library/react";
import type { AgentEvent } from "@helios/kernel";
import type { Message } from "@helios/ports";
import { useChat, reduce, initialState, type ChatState } from "./useChat";
import type { IChatClient, ConnectionState } from "./types";

afterEach(cleanup);

/** 可手动 emit 事件 / 切状态的 mock client。 */
function makeMockClient(history: Message[] = []): {
  client: IChatClient;
  emit: (e: AgentEvent) => void;
  setState: (s: ConnectionState) => void;
  sent: string[];
} {
  const eventCbs = new Set<(e: AgentEvent) => void>();
  const stateCbs = new Set<(s: ConnectionState) => void>();
  const sent: string[] = [];
  const client: IChatClient = {
    getHistory: async () => history,
    sendMessage: async (t) => {
      sent.push(t);
    },
    onEvent: (cb) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    onState: (cb) => (stateCbs.add(cb), () => stateCbs.delete(cb)),
  };
  return {
    client,
    emit: (e) => eventCbs.forEach((cb) => cb(e)),
    setState: (s) => stateCbs.forEach((cb) => cb(s)),
    sent,
  };
}

const runStart: AgentEvent = { type: "agent_start", runId: "r1" };
// turnId 用真实格式 `${sessionId}-${runIndex}-${turnIndex}`,便于 runIndex 解析。
const TURN = "sess-0-0";
const msgStart: AgentEvent = { type: "message_start", messageId: "m1", role: "assistant", turnId: TURN };
const delta = (text: string): AgentEvent => ({ type: "message_update", messageId: "m1", delta: { type: "text-delta", text } });
const toolStart: AgentEvent = { type: "tool_execution_start", toolUseId: "u1", name: "Read", input: { path: "a" } };
const toolEnd: AgentEvent = { type: "tool_execution_end", toolUseId: "u1", output: "ok", isError: false };
const runEnd: AgentEvent = { type: "agent_end", runId: "r1", turnIds: [TURN], newMessages: [] };

describe("useChat", () => {
  it("文本累加 + 工具卡片状态流转 + isStreaming 翻转", async () => {
    const { client, emit } = makeMockClient();
    const { result } = renderHook(() => useChat(client));

    act(() => emit(runStart));
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      emit(msgStart);
      emit(delta("Hel"));
      emit(delta("lo"));
      emit(toolStart);
    });
    expect(result.current.messages[0].text).toBe("Hello");
    expect(result.current.messages[0].tools[0].status).toBe("running");

    act(() => emit(toolEnd));
    expect(result.current.messages[0].tools[0].status).toBe("success");

    act(() => emit(runEnd));
    expect(result.current.isStreaming).toBe(false);
  });

  it("connection 随 onState 变化", () => {
    const { client, setState } = makeMockClient();
    const { result } = renderHook(() => useChat(client));
    expect(result.current.connection).toBe("open");
    act(() => setState("connecting"));
    expect(result.current.connection).toBe("connecting");
    act(() => setState("closed"));
    expect(result.current.connection).toBe("closed");
  });

  it("挂载拉历史 → 重建视图", async () => {
    const history: Message[] = [
      { id: "h1", role: "user", content: "hi" },
      { id: "h2", role: "assistant", content: [{ type: "text", text: "hey" }] },
    ];
    const { client } = makeMockClient(history);
    const { result } = renderHook(() => useChat(client));
    // getHistory 是 async,等一个 tick
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.messages.map((m) => m.text)).toEqual(["hi", "hey"]);
  });
});

describe("reduce —— 幂等 / 容忍乱序 / 重复", () => {
  function apply(events: AgentEvent[]): ChatState {
    return events.reduce((s, e) => reduce(s, e), initialState);
  }

  it("重复 message_start 不产生重复消息", () => {
    const s = apply([msgStart, msgStart, delta("x")]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].text).toBe("x");
  });

  it("乱序:tool_execution_end 早于 start 不抛错、不产生重复卡片", () => {
    // 打乱顺序:start → 先 end 再 start(重放)→ 再来一次重复 start
    const s = apply([msgStart, toolEnd, toolStart, toolStart]);
    const tools = s.messages.flatMap((m) => m.tools);
    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe("u1");
    expect(tools[0].status).toBe("success"); // end 已把状态定为 success
  });

  it("乱序:message_update 早于 message_start 仍拼出正确文本", () => {
    const s = apply([delta("A"), delta("B"), msgStart, delta("C")]);
    // update 早到时先建消息;后来的 message_start 命中同 id 被忽略(幂等),文本按到达顺序拼接
    const m = s.messages.find((x) => x.id === "m1")!;
    expect(m.text).toBe("ABC");
  });

  it("agent_end 只在 run 最后一条 assistant 打回溯入口,目标为该 run 首 turn", () => {
    const s = apply([
      { type: "message_start", messageId: "m1", role: "assistant", turnId: "sess-0-0" },
      { type: "message_update", messageId: "m1", delta: { type: "text-delta", text: "步骤1" } },
      { type: "turn_end", turnId: "sess-0-0", toolResults: [] },
      { type: "message_start", messageId: "m2", role: "assistant", turnId: "sess-0-1" },
      { type: "message_update", messageId: "m2", delta: { type: "text-delta", text: "步骤2" } },
      { type: "turn_end", turnId: "sess-0-1", toolResults: [] },
      { type: "agent_end", runId: "r1", turnIds: ["sess-0-0", "sess-0-1"], newMessages: [] },
    ]);
    const m1 = s.messages.find((x) => x.id === "m1")!;
    const m2 = s.messages.find((x) => x.id === "m2")!;
    expect(m1.isRunBoundary).toBeFalsy();
    expect(m2.isRunBoundary).toBe(true);
    expect(m2.rollbackTurnId).toBe("sess-0-0");
  });

  it("thinking-delta 累积到 thinking 字段,与正文分开", () => {
    const s = apply([
      { type: "message_start", messageId: "m1", role: "assistant", turnId: "sess-0-0" },
      { type: "message_update", messageId: "m1", delta: { type: "thinking-delta", text: "先想想…" } },
      { type: "message_update", messageId: "m1", delta: { type: "thinking-delta", text: "再想想。" } },
      { type: "message_update", messageId: "m1", delta: { type: "text-delta", text: "答案是 42" } },
    ]);
    const m = s.messages.find((x) => x.id === "m1")!;
    expect(m.thinking).toBe("先想想…再想想。");
    expect(m.text).toBe("答案是 42");
  });
});
