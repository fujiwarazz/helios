import { describe, expect, it, vi } from "vitest";
import { createLangSmithTracer } from "./index";

describe("createLangSmithTracer", () => {
  it("returns a no-op tracer when tracing is disabled", async () => {
    const tracer = createLangSmithTracer({ LANGSMITH_TRACING: "false" });
    const run = tracer.startRun({ name: "helios.agent_turn", runType: "chain" });

    await expect(run.end({ status: "success" })).resolves.toBeUndefined();
  });

  it("redacts secrets and truncates oversized values before sending them", async () => {
    const createRun = vi.fn().mockResolvedValue(undefined);
    const updateRun = vi.fn().mockResolvedValue(undefined);
    const tracer = createLangSmithTracer(
      {
        LANGSMITH_TRACING: "true",
        LANGSMITH_API_KEY: "test-key",
        LANGSMITH_PROJECT: "helios",
      },
      { client: { createRun, updateRun } },
    );

    tracer.startRun({
      name: "helios.tool.fetch",
      runType: "tool",
      input: { Authorization: "Bearer secret", body: "x".repeat(20_000) },
    });

    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: {
          Authorization: "[REDACTED]",
          body: expect.stringMatching(/…$/),
        },
      }),
    );
  });

  it("supplies hierarchical dotted order values required by the LangSmith API", () => {
    const createRun = vi.fn().mockResolvedValue(undefined);
    const tracer = createLangSmithTracer(
      {
        LANGSMITH_TRACING: "true",
        LANGSMITH_API_KEY: "test-key",
        LANGSMITH_PROJECT: "helios",
      },
      { client: { createRun, updateRun: vi.fn().mockResolvedValue(undefined) }, now: () => new Date("2026-08-13T00:00:00.000Z") },
    );

    const root = tracer.startRun({ name: "root", runType: "chain" });
    root.startChild({ name: "child", runType: "llm" });

    const [rootPayload, childPayload] = createRun.mock.calls.map(([payload]) => payload as Record<string, string>);
    expect(rootPayload.dotted_order).toMatch(/^20260813T000000000001Z[0-9a-f-]{36}$/);
    expect(childPayload.dotted_order).toMatch(new RegExp(`^${rootPayload.dotted_order}\\.20260813T000000000001Z[0-9a-f-]{36}$`));
  });

  it("keeps token usage visible while redacting credentials", async () => {
    const createRun = vi.fn().mockResolvedValue(undefined);
    const updateRun = vi.fn().mockResolvedValue(undefined);
    const tracer = createLangSmithTracer(
      { LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "test-key" },
      { client: { createRun, updateRun } },
    );

    const run = tracer.startRun({ name: "llm", runType: "llm" });
    await run.end({ status: "success", output: { outputTokens: 42, apiKey: "secret" } });

    expect(updateRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outputs: { outputTokens: 42, apiKey: "[REDACTED]" } }),
    );
  });
});
