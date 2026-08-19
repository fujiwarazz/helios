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

    // toMatchObject rather than toEqual: the card also carries wall-clock timestamps, which have no
    // fixed value to assert here (they get their own case below).
    expect(model.snapshot()).toMatchObject({
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

  it("stamps tool start and end so the card can show how long it took", () => {
    const model = new SessionViewModel();
    model.apply({ type: "agent_start", runId: "run-1" });
    model.apply({ type: "tool_execution_start", toolUseId: "t1", name: "Bash", input: {} });
    model.apply({ type: "tool_execution_end", toolUseId: "t1", output: "", isError: false });

    const tool = model.snapshot().tools[0]!;
    expect(typeof tool.startedAt).toBe("number");
    expect(tool.endedAt).toBeGreaterThanOrEqual(tool.startedAt);
  });

  it("reports zero elapsed for a tool whose start was never observed", () => {
    const model = new SessionViewModel();
    model.apply({ type: "tool_execution_end", toolUseId: "t1", output: "ok", isError: false });

    const tool = model.snapshot().tools[0]!;
    expect(tool.endedAt).toBe(tool.startedAt);
  });

  function endRun(model: SessionViewModel, runId: string, outputTokens: number): void {
    model.apply({
      type: "agent_end",
      runId,
      turnIds: ["turn-1"],
      newMessages: [],
      costReport: {
        runId,
        uncachedInputTokens: 163,
        cachedInputTokens: 10_240,
        cacheWriteTokens: 0,
        outputTokens,
        contextLength: 10_403,
        llmCalls: 3,
        toolCalls: 0,
        toolExecutions: 0,
        toolCacheHits: 0,
        avgContextLength: 3468,
        cachedInputRatio: 10_240 / 10_403,
      },
    });
  }

  it("reports the cost summary as its own field, not a transcript message", () => {
    // It used to go through notice(), which made it a role:"system" message: that stamped a
    // meaningless `· ›` label on a meter reading and let it scroll away with the conversation.
    const model = new SessionViewModel();
    model.apply({ type: "agent_start", runId: "run-1" });
    endRun(model, "run-1", 412);

    const snapshot = model.snapshot();
    expect(snapshot.costSummary).toBe("↑ 10.4k (98% cached) · ↓ 412 · 3 calls");
    expect(snapshot.messages).toHaveLength(0);
  });

  it("replaces the reading on the next run rather than accumulating lines", () => {
    const model = new SessionViewModel();
    endRun(model, "run-1", 412);
    endRun(model, "run-2", 7);
    expect(model.snapshot().costSummary).toContain("↓ 7");
  });

  it("keeps the last reading when a run reports nothing", () => {
    const model = new SessionViewModel();
    endRun(model, "run-1", 412);
    model.apply({ type: "agent_end", runId: "run-2", turnIds: [], newMessages: [] });
    expect(model.snapshot().costSummary).toContain("↓ 412");
  });

  it("has no reading before any run, and drops it when the transcript is cleared", () => {
    const model = new SessionViewModel();
    expect(model.snapshot().costSummary).toBeUndefined();
    endRun(model, "run-1", 412);
    model.reset();
    expect(model.snapshot().costSummary).toBeUndefined();
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
