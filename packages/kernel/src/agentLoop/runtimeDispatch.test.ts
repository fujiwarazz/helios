import { describe, it, expect, vi } from "vitest";
import type { Runtime, RouteContext, ToolCacheKey } from "@helios/ports";
import {
  dispatchRunStart,
  dispatchTurnStart,
  dispatchLLMResponse,
  dispatchCacheVersion,
  dispatchBeforeTool,
  dispatchAfterTool,
  dispatchRunEnd,
} from "./runtimeDispatch";

const routeCtx: RouteContext = {
  sessionId: "s1",
  turnIndex: 0,
  signals: {
    contextTokens: 0,
    toolUseCountSoFar: 0,
    lastTurnHadError: false,
    lastTurnParseError: false,
    retriedLastTurn: false,
    repeatedToolCall: false,
  },
  contextStats: { inputTokens: 0, toolCount: 0, messageCount: 0, hasCode: false },
};

describe("dispatchTurnStart", () => {
  it("空数组返回空对象", async () => {
    expect(await dispatchTurnStart([], routeCtx)).toEqual({});
  });

  it("逐字段合并：后面的 runtime 覆盖前面已设置的字段，未设置字段不覆盖", async () => {
    const a: Runtime = { onTurnStart: () => ({ model: "a-model", provider: "a-provider" }) };
    const b: Runtime = { onTurnStart: () => ({ model: "b-model" }) }; // 只改 model，不动 provider
    const decision = await dispatchTurnStart([a, b], routeCtx);
    expect(decision).toEqual({ model: "b-model", provider: "a-provider" });
  });

  it("未实现 onTurnStart 的 runtime 跳过，不影响其他 runtime 的结果", async () => {
    const noop: Runtime = {};
    const a: Runtime = { onTurnStart: () => ({ model: "a-model" }) };
    expect(await dispatchTurnStart([noop, a], routeCtx)).toEqual({ model: "a-model" });
  });
});

describe("dispatchLLMResponse / dispatchRunStart / dispatchAfterTool", () => {
  it("纯副作用：全部依次调用，不收集返回值", async () => {
    const calls: string[] = [];
    const a: Runtime = { onLLMResponse: () => void calls.push("a") };
    const b: Runtime = { onLLMResponse: () => void calls.push("b") };
    await dispatchLLMResponse([a, b], "run1", {
      provider: "p",
      model: "m",
      usage: { uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    });
    expect(calls).toEqual(["a", "b"]);
  });

  it("dispatchRunStart 依次调用所有 runtime", async () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    await dispatchRunStart([{ onRunStart: fn1 }, { onRunStart: fn2 }], "run1");
    expect(fn1).toHaveBeenCalledWith("run1");
    expect(fn2).toHaveBeenCalledWith("run1");
  });

  it("dispatchAfterTool 依次调用所有 runtime（含未定义 cache 参数）", async () => {
    const fn = vi.fn();
    await dispatchAfterTool([{ onAfterTool: fn }], "run1", { name: "Read", cacheHit: false, executed: true });
    expect(fn).toHaveBeenCalledWith("run1", { name: "Read", cacheHit: false, executed: true }, undefined);
  });
});

describe("dispatchCacheVersion / dispatchBeforeTool", () => {
  it("查询语义：依次调用，第一个非 undefined 结果短路返回", async () => {
    const calls: string[] = [];
    const a: Runtime = {
      getCacheVersion: () => {
        calls.push("a");
        return undefined;
      },
    };
    const b: Runtime = {
      getCacheVersion: () => {
        calls.push("b");
        return "v1";
      },
    };
    const c: Runtime = {
      getCacheVersion: () => {
        calls.push("c");
        return "v2";
      },
    };
    expect(await dispatchCacheVersion([a, b, c], "workspace")).toBe("v1");
    expect(calls).toEqual(["a", "b"]); // c 不应被调用（已短路）
  });

  it("全部未命中时返回 undefined", async () => {
    expect(await dispatchCacheVersion([{}, {}], "workspace")).toBeUndefined();
  });

  it("dispatchBeforeTool 第一个命中（非 undefined）短路返回", async () => {
    const key: ToolCacheKey = { toolName: "Read", argsCanonical: "{}", scope: "run", scopeId: "r1" };
    const miss: Runtime = { onBeforeTool: () => undefined };
    const hit: Runtime = { onBeforeTool: () => ({ output: "cached" }) };
    expect(await dispatchBeforeTool([miss, hit], key)).toEqual({ output: "cached" });
  });
});

describe("dispatchRunEnd", () => {
  it("全部依次 await，最后一个非 undefined 返回值作为最终报告", async () => {
    const reportA = { runId: "r1", uncachedInputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, contextLength: 1, llmCalls: 1, toolCalls: 0, toolExecutions: 0, toolCacheHits: 0, avgContextLength: 1 };
    const reportB = { ...reportA, llmCalls: 2 };
    const a: Runtime = { onRunEnd: () => reportA };
    const b: Runtime = { onRunEnd: () => reportB };
    const report = await dispatchRunEnd([a, b], "r1", { status: "success" });
    expect(report).toEqual(reportB);
  });

  it("无 runtime 实现 onRunEnd 时返回 undefined", async () => {
    expect(await dispatchRunEnd([{}], "r1", { status: "success" })).toBeUndefined();
  });
});
