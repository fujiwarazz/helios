import { describe, it, expect } from "vitest";
import { computeRetryDelayMs, DEFAULT_LLM_RETRY } from "./retryBackoff";

describe("computeRetryDelayMs", () => {
  it("无 retryAfterMs 时按指数退避公式计算：min(baseDelayMs × 2^retryCount, maxDelayMs) + jitter(0~25%)", () => {
    for (const retryCount of [0, 1, 2]) {
      const base = Math.min(DEFAULT_LLM_RETRY.baseDelayMs * 2 ** retryCount, DEFAULT_LLM_RETRY.maxDelayMs);
      const delay = computeRetryDelayMs(retryCount);
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThanOrEqual(base * 1.25);
    }
  });

  it("指数增长超过 maxDelayMs 时封顶", () => {
    const delay = computeRetryDelayMs(10); // 500×2^10 远超 32000 上限
    expect(delay).toBeGreaterThanOrEqual(DEFAULT_LLM_RETRY.maxDelayMs);
    expect(delay).toBeLessThanOrEqual(DEFAULT_LLM_RETRY.maxDelayMs * 1.25);
  });

  it("retryAfterMs ≤ maxDelayMs 时优先命中该值（忽略指数退避公式）", () => {
    expect(computeRetryDelayMs(0, DEFAULT_LLM_RETRY, 1000)).toBe(1000);
    expect(computeRetryDelayMs(5, DEFAULT_LLM_RETRY, 32000)).toBe(32000);
  });

  it("retryAfterMs 超过 maxDelayMs 上限时返回 undefined（判定不值得等）", () => {
    expect(computeRetryDelayMs(0, DEFAULT_LLM_RETRY, 32001)).toBeUndefined();
    expect(computeRetryDelayMs(0, DEFAULT_LLM_RETRY, 300000)).toBeUndefined();
  });

  it("可用自定义 opts 覆盖默认策略", () => {
    const custom = { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 1000 };
    const delay = computeRetryDelayMs(0, custom);
    expect(delay).toBeGreaterThanOrEqual(100);
    expect(delay).toBeLessThanOrEqual(125);
  });
});
