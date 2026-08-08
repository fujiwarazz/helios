import { describe, it, expect } from "vitest";
import type { Usage } from "@helios/ports";
import { create } from "./index";

function meter(options: Record<string, unknown> = {}) {
  return create({ options } as never);
}
const usage = (u: Partial<Usage>): Usage => ({
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  ...u,
});

describe("costmeter-default 计量累加与报告", () => {
  it("累加 token 并区分 uncached/cached/write/output；contextLength 不含 write", () => {
    const m = meter();
    m.onLLMCall("r1", {
      provider: "p",
      model: "x",
      usage: usage({ uncachedInputTokens: 100, cachedInputTokens: 40, cacheWriteTokens: 10, outputTokens: 20 }),
    });
    const rep = m.report("r1");
    expect(rep.uncachedInputTokens).toBe(100);
    expect(rep.cachedInputTokens).toBe(40);
    expect(rep.cacheWriteTokens).toBe(10);
    expect(rep.outputTokens).toBe(20);
    expect(rep.contextLength).toBe(140); // uncached + cached，不含 write
    expect(rep.llmCalls).toBe(1);
  });

  it("promptTokens 存在时 contextLength 用权威值；avgContextLength 按调用平均", () => {
    const m = meter();
    m.onLLMCall("r1", { provider: "p", model: "x", usage: usage({ uncachedInputTokens: 10, cachedInputTokens: 5, promptTokens: 200 }) });
    m.onLLMCall("r1", { provider: "p", model: "x", usage: usage({ uncachedInputTokens: 10, cachedInputTokens: 5, promptTokens: 100 }) });
    const rep = m.report("r1");
    expect(rep.avgContextLength).toBe(150); // (200 + 100) / 2
  });

  it("工具三指标分开 + prefixCacheHitRate + cachedInputRatio", () => {
    const m = meter();
    m.onLLMCall("r1", { provider: "p", model: "x", usage: usage({ uncachedInputTokens: 30, cachedInputTokens: 70 }) });
    m.onToolCall("r1", { name: "a", cacheHit: false, executed: true });
    m.onToolCall("r1", { name: "a", cacheHit: true, executed: false });
    m.onToolCall("r1", { name: "b", cacheHit: false, executed: false }); // 被拒/解析失败：既没执行也没命中
    const rep = m.report("r1");
    expect(rep.toolCalls).toBe(3);
    expect(rep.toolExecutions).toBe(1);
    expect(rep.toolCacheHits).toBe(1);
    expect(rep.prefixCacheHitRate).toBeCloseTo(1 / 3);
    expect(rep.cachedInputRatio).toBeCloseTo(0.7); // 70 / (30+70)
  });

  it("outcome 落到报告（支撑 Cost/Successful Task）", () => {
    const m = meter();
    m.setOutcome("r1", { status: "success" });
    expect(m.report("r1").outcome).toEqual({ status: "success" });
  });

  it("有价格表 → estimatedCost + pricingVersion；无价格表 → estimatedCost undefined", () => {
    const withPricing = meter({
      pricingVersion: "v-2026-08",
      pricing: { x: { uncachedInput: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 } }, // 每 1M token
    });
    withPricing.onLLMCall("r1", {
      provider: "p",
      model: "x",
      usage: usage({ uncachedInputTokens: 1_000_000, outputTokens: 1_000_000 }),
    });
    const rep = withPricing.report("r1");
    expect(rep.estimatedCost).toBeCloseTo(3 + 15); // 1M*3 + 1M*15，按 1M 归一
    expect(rep.pricingVersion).toBe("v-2026-08");

    const noPricing = meter();
    noPricing.onLLMCall("r1", { provider: "p", model: "x", usage: usage({ uncachedInputTokens: 100 }) });
    expect(noPricing.report("r1").estimatedCost).toBeUndefined();
  });

  it("getUsage 只回事实（measurement only，无 estimate/budget 判断）", () => {
    const m = meter({ pricing: { x: { uncachedInput: 3, cachedInput: 0, cacheWrite: 0, output: 0 } } });
    m.onLLMCall("r1", { provider: "p", model: "x", usage: usage({ uncachedInputTokens: 1_000_000, cachedInputTokens: 2, outputTokens: 5 }) });
    const u = m.getUsage("r1");
    expect(u).toEqual({ spent: 3, uncachedInputTokens: 1_000_000, cachedInputTokens: 2, outputTokens: 5 });
  });

  it("按 runId 隔离，不同 run 互不串", () => {
    const m = meter();
    m.onLLMCall("r1", { provider: "p", model: "x", usage: usage({ outputTokens: 5 }) });
    m.onLLMCall("r2", { provider: "p", model: "x", usage: usage({ outputTokens: 9 }) });
    expect(m.report("r1").outputTokens).toBe(5);
    expect(m.report("r2").outputTokens).toBe(9);
  });
});
