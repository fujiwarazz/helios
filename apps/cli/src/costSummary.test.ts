import { describe, expect, it } from "vitest";
import type { TaskCostReport } from "@helios/ports";
import { formatCostSummary } from "./costSummary";

function report(overrides: Partial<TaskCostReport> = {}): TaskCostReport {
  return {
    runId: "r1",
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    contextLength: 0,
    llmCalls: 1,
    toolCalls: 0,
    toolExecutions: 0,
    toolCacheHits: 0,
    avgContextLength: 0,
    ...overrides,
  };
}

describe("formatCostSummary", () => {
  it("给出输入规模、缓存占比、调用数与金额", () => {
    const line = formatCostSummary(
      report({
        contextLength: 10_403,
        cachedInputTokens: 10_240,
        uncachedInputTokens: 163,
        outputTokens: 412,
        llmCalls: 3,
        cachedInputRatio: 10_240 / 10_403,
        estimatedCost: 0.0021,
      }),
    );
    expect(line).toBe("↑ 10.4k (98% cached) · ↓ 412 · 3 calls · $0.0021");
  });

  it("没装 CostMeterPort 时不打任何东西", () => {
    expect(formatCostSummary(undefined)).toBeUndefined();
  });

  it("这一轮没有 LLM 调用时不打一行全是 0 的噪音", () => {
    // 例如被 UserPromptSubmit hook 拦下：run 有始有终，但一次模型都没调。
    expect(formatCostSummary(report({ llmCalls: 0 }))).toBeUndefined();
  });

  it("没有价格表时省掉金额，其余照常", () => {
    const line = formatCostSummary(
      report({ contextLength: 800, outputTokens: 12, cachedInputRatio: 0 }),
    );
    expect(line).toBe("↑ 800 (0% cached) · ↓ 12 · 1 call");
  });

  it("极小金额不四舍五入成 $0.00（否则看着像免费）", () => {
    const line = formatCostSummary(report({ contextLength: 100, estimatedCost: 0.00006 }));
    expect(line).toContain("$0.0001");
  });
});
