import { describe, it, expect } from "vitest";
import type { RouteContext, RouteSignals, RouteContextStats } from "@helios/ports";
import { create } from "./index";

interface CtxOverride {
  sessionId?: string;
  turnIndex?: number;
  purpose?: string;
  signals?: Partial<RouteSignals>;
  contextStats?: Partial<RouteContextStats>;
  agentOverride?: { provider?: string; model?: string };
}

function ctx(over: CtxOverride = {}): RouteContext {
  const signals: RouteSignals = {
    contextTokens: 1000,
    toolUseCountSoFar: 0,
    lastTurnHadError: false,
    lastTurnParseError: false,
    retriedLastTurn: false,
    repeatedToolCall: false,
    ...over.signals,
  };
  return {
    sessionId: over.sessionId ?? "s1",
    turnIndex: over.turnIndex ?? 0,
    purpose: over.purpose ?? "main",
    signals,
    contextStats: {
      inputTokens: signals.contextTokens,
      toolCount: 5,
      messageCount: 3,
      hasCode: false,
      ...over.contextStats,
    },
    agentOverride: over.agentOverride,
  };
}

const tiers: [string, string, string] = ["small", "medium", "large"];

describe("router-default Strategy: purpose/难度 → tier → model", () => {
  it("辅助用途（compact/recall/…）→ tier0 便宜档", () => {
    const r = create({ options: { tiers } } as never);
    expect(r.route(ctx({ purpose: "compact" }))).toEqual({ model: "small" });
    expect(r.route(ctx({ purpose: "recall", sessionId: "s2" }))).toEqual({ model: "small" });
  });

  it("无 tool_use + 短输入 + 无代码 → tier0", () => {
    const r = create({ options: { tiers } } as never);
    expect(r.route(ctx({ signals: { contextTokens: 500 }, contextStats: { inputTokens: 500 } }))).toEqual({
      model: "small",
    });
  });

  it("含代码 → 至少 medium（tier1）", () => {
    const r = create({ options: { tiers } } as never);
    expect(
      r.route(ctx({ signals: { contextTokens: 500 }, contextStats: { inputTokens: 500, hasCode: true } })),
    ).toEqual({ model: "medium" });
  });

  it("超长上下文 → tier2 large", () => {
    const r = create({ options: { tiers } } as never);
    expect(
      r.route(ctx({ signals: { contextTokens: 50_000 }, contextStats: { inputTokens: 50_000 } })),
    ).toEqual({ model: "large" });
  });

  it("expectedOutput=long → tier2", () => {
    const r = create({ options: { tiers } } as never);
    expect(
      r.route(ctx({ contextStats: { inputTokens: 500, expectedOutput: "long" } })),
    ).toEqual({ model: "large" });
  });
});

describe("router-default Model Affinity + 映射表纪律", () => {
  it("配了 provider → 输出带首选 provider（能不跨就不跨）", () => {
    const r = create({ options: { provider: "anthropic", tiers } } as never);
    expect(r.route(ctx({ purpose: "compact" }))).toEqual({ provider: "anthropic", model: "small" });
  });

  it("未配 tiers → 不覆盖 model（模型名只在映射表里）", () => {
    const r = create({ options: {} } as never);
    expect(r.route(ctx())).toEqual({});
  });
});

describe("router-default 棘轮：升快降慢 + 升档次数上限 + 新 run 重置", () => {
  it("失败信号 → 升档，并锁定到本 run 结束（后续 turn 即使无信号也不降）", () => {
    const r = create({ options: { tiers } } as never);
    // turn0：中等上下文（4k~30k）→ medium
    expect(r.route(ctx({ turnIndex: 0, signals: { contextTokens: 10_000 } }))).toEqual({ model: "medium" });
    // turn1：上轮报错 → 升到 large
    expect(
      r.route(ctx({ turnIndex: 1, signals: { contextTokens: 10_000, lastTurnHadError: true } })),
    ).toEqual({ model: "large" });
    // turn2：无信号 → 仍保持 large（升快降慢）
    expect(r.route(ctx({ turnIndex: 2, signals: { contextTokens: 10_000 } }))).toEqual({ model: "large" });
  });

  it("升档次数上限：maxEscalations=1 时只升一档", () => {
    const r = create({ options: { tiers, maxEscalations: 1 } } as never);
    // 从 tier0 起步（短输入无工具）
    expect(r.route(ctx({ turnIndex: 0, signals: { contextTokens: 500 }, contextStats: { inputTokens: 500 } }))).toEqual({
      model: "small",
    });
    // 连续失败：第一次升到 medium
    expect(
      r.route(ctx({ turnIndex: 1, signals: { contextTokens: 500, repeatedToolCall: true }, contextStats: { inputTokens: 500 } })),
    ).toEqual({ model: "medium" });
    // 再失败：已达上限，不再升到 large
    expect(
      r.route(ctx({ turnIndex: 2, signals: { contextTokens: 500, repeatedToolCall: true }, contextStats: { inputTokens: 500 } })),
    ).toEqual({ model: "medium" });
  });

  it("新 run（turnIndex=0）重置棘轮", () => {
    const r = create({ options: { tiers } } as never);
    r.route(ctx({ turnIndex: 0, signals: { contextTokens: 10_000 } }));
    r.route(ctx({ turnIndex: 1, signals: { contextTokens: 10_000, lastTurnHadError: true } })); // → large 锁定
    // 新 run：turnIndex 归 0 → 重置回 medium
    expect(r.route(ctx({ turnIndex: 0, signals: { contextTokens: 10_000 } }))).toEqual({ model: "medium" });
  });
});

describe("router-default agentOverride 最高优先级", () => {
  it("有 agentOverride 直接返回，忽略难度/棘轮", () => {
    const r = create({ options: { tiers } } as never);
    expect(
      r.route(ctx({ agentOverride: { provider: "openai", model: "gpt-x" }, signals: { contextTokens: 99999 } })),
    ).toEqual({ provider: "openai", model: "gpt-x" });
  });
});
