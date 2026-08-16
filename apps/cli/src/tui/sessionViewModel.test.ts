import { describe, expect, it } from "vitest";
import { SessionViewModel } from "./sessionViewModel";

describe("SessionViewModel", () => {
  it("hydrates display history and accumulates assistant text and thinking deltas", () => {
    const model = new SessionViewModel();
    model.hydrate([
      { id: "user-1", role: "user", content: "hello" },
      {
        id: "assistant-previous",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "previous reasoning" },
          { type: "text", text: "previous answer" },
        ],
      },
    ]);

    model.apply({ type: "agent_start", runId: "run-1" });
    model.apply({ type: "message_start", messageId: "assistant-1", role: "assistant", turnId: "turn-1" });
    model.apply({
      type: "message_update",
      messageId: "assistant-1",
      delta: { type: "text-delta", text: "Hi" },
    });
    model.apply({
      type: "message_update",
      messageId: "assistant-1",
      delta: { type: "thinking-delta", text: "reason" },
    });

    expect(model.snapshot()).toMatchObject({
      busy: true,
      messages: [
        { id: "user-1", role: "user", text: "hello", thinking: "", complete: true },
        {
          id: "assistant-previous",
          role: "assistant",
          text: "previous answer",
          thinking: "previous reasoning",
          complete: true,
        },
        { id: "assistant-1", role: "assistant", text: "Hi", thinking: "reason", complete: false },
      ],
    });
  });

  it("tracks generic tools, retry status, and completion without knowing a Port", () => {
    const model = new SessionViewModel();

    model.apply({ type: "agent_start", runId: "run-1" });
    model.apply({
      type: "tool_execution_start",
      toolUseId: "tool-1",
      name: "plugin__custom_search",
      input: { query: "helios" },
    });
    model.apply({ type: "llm_retry", turnId: "turn-1", retryCount: 2, delayMs: 500 });
    model.apply({
      type: "tool_execution_end",
      toolUseId: "tool-1",
      output: { count: 2 },
      isError: false,
    });
    model.apply({ type: "agent_end", runId: "run-1", turnIds: ["turn-1"], newMessages: [] });

    expect(model.snapshot()).toEqual({
      busy: false,
      status: "Completed",
      messages: [],
      tools: [
        {
          toolUseId: "tool-1",
          name: "plugin__custom_search",
          input: { query: "helios" },
          output: { count: 2 },
          isError: false,
          status: "success",
        },
      ],
    });
  });

  it("marks failed tools and failed runs as errors", () => {    const model = new SessionViewModel();

    model.apply({ type: "agent_start", runId: "run-1" });
    model.apply({ type: "tool_execution_start", toolUseId: "tool-1", name: "read", input: {} });
    model.apply({ type: "tool_execution_end", toolUseId: "tool-1", output: "missing", isError: true });
    model.apply({
      type: "agent_end",
      runId: "run-1",
      turnIds: [],
      newMessages: [],
      error: "provider unavailable",
    });

    expect(model.snapshot()).toMatchObject({
      busy: false,
      status: "Error: provider unavailable",
      tools: [{ toolUseId: "tool-1", status: "error", output: "missing", isError: true }],
    });
  });

  it("resets only the local projection and rehydrates from a new branch history", () => {
    const model = new SessionViewModel();
    model.hydrate([{ id: "user-1", role: "user", content: "first branch" }]);
    model.apply({ type: "tool_execution_start", toolUseId: "tool-1", name: "read", input: {} });

    model.reset();
    expect(model.snapshot()).toMatchObject({ messages: [], tools: [] });

    // head_changed replays the selected branch: rehydrate must not keep stale tool cards.
    model.apply({ type: "tool_execution_start", toolUseId: "tool-2", name: "read", input: {} });
    model.hydrate([{ id: "user-2", role: "user", content: "other branch" }]);
    expect(model.snapshot()).toMatchObject({
      messages: [{ id: "user-2", text: "other branch" }],
      tools: [],
    });
  });

  it("keeps local notices in the transcript as system messages", () => {
    const model = new SessionViewModel();
    model.notice("命令输出");
    model.setStatus("Cleared");

    expect(model.snapshot()).toMatchObject({
      status: "Cleared",
      messages: [{ role: "system", text: "命令输出", complete: true }],
    });
  });
});
