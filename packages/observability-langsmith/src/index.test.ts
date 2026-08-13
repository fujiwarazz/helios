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
});
