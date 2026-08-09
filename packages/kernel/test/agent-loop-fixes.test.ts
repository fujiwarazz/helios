import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { Kernel, type Manifest, LlmProviderError } from "../src/index";
import type { AgentEvent } from "../src/events";
import type { LlmRetryOptions } from "../src/agentLoop/retryBackoff";
import { callLog as parallelCallLog } from "./fixtures/mockCapabilityParallel";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const noAsk = async (_r: AskQuestionRequest): Promise<AskQuestionResponse> => ({ answers: ["允许"] });

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-loopfix-"));
  return async () => {
    await rm(workDir, { recursive: true, force: true });
  };
});

async function bootSession(
  llmFixture: string,
  extraPlugins: Manifest["plugins"] = [],
  maxTurns?: number,
  sessionOpts: { llmRetry?: LlmRetryOptions; sleep?: (ms: number) => Promise<void> } = {},
) {
  const manifest: Manifest = {
    plugins: [
      { port: "FileSystemPort", package: "@helios/fs-node" },
      ...extraPlugins,
      { port: "LLMProvider", package: fixture(llmFixture) },
    ],
  };
  const kernel = new Kernel({ workDir, manifest, logger: silentLogger });
  await kernel.start();
  const events: AgentEvent[] = [];
  const session = kernel.createSession({ askQuestion: noAsk, maxTurns, ...sessionOpts });
  session.on((e) => events.push(e));
  return { session, events };
}

describe("Bug 3 —— LLM 流错误优雅收尾（不 throw 穿透）", () => {
  it("流中途报错：sendMessage 不 reject，agent_end 一定 emit 且带 error", async () => {
    const { session, events } = await bootSession("mockLlmStreamError.ts");

    // 不再穿透抛出
    await expect(session.sendMessage("hi")).resolves.toBeDefined();

    const last = events[events.length - 1];
    expect(last?.type).toBe("agent_end");
    expect(last).toMatchObject({ error: "网络超时" });

    // message_start 有配对 message_end（事件不悬空）
    expect(events.some((e) => e.type === "message_start")).toBe(true);
    expect(events.some((e) => e.type === "message_end")).toBe(true);
    expect(events.some((e) => e.type === "turn_end")).toBe(true);

    // 报错后残缺内容被截断：只保留已累计文本，且未跑到 "不该出现"
    const history = session.getHistory();
    const assistant = history.find((m: Message) => m.role === "assistant");
    expect(JSON.stringify(assistant?.content ?? "")).toContain("部分");
    expect(JSON.stringify(assistant?.content ?? "")).not.toContain("不该出现");
  });
});

describe("Bug 4 —— tool_use 参数 JSON 解析失败回传错误而非静默 {}", () => {
  it("非法参数不执行工具，回传 isError 的 tool_result 让 LLM 重试", async () => {
    const { session, events } = await bootSession("mockLlmBadArgs.ts", [
      { port: "CapabilityProvider", package: fixture("mockCapability.ts") },
    ]);

    await session.sendMessage("go");

    const toolEnd = events.find((e) => e.type === "tool_execution_end");
    expect(toolEnd).toMatchObject({ isError: true });
    expect(JSON.stringify(toolEnd)).toContain("解析失败");

    // start/end 成对
    const starts = events.filter((e) => e.type === "tool_execution_start").length;
    const ends = events.filter((e) => e.type === "tool_execution_end").length;
    expect(starts).toBe(ends);
  });
});

describe("Bug 5 —— 达到 turn 上限优雅结束并标注", () => {
  it("永不结束的工具循环撞上 maxTurns：agent_end.reachedMaxTurns=true", async () => {
    const { session, events } = await bootSession(
      "mockLlmLoop.ts",
      [{ port: "CapabilityProvider", package: fixture("mockCapability.ts") }],
      3,
    );

    await session.sendMessage("go");

    const last = events[events.length - 1];
    expect(last?.type).toBe("agent_end");
    expect(last).toMatchObject({ reachedMaxTurns: true });
    if (last?.type === "agent_end") expect(last.turnIds).toHaveLength(3);

    // 历史末尾是 tool_result（与 tool_use 配对），不留孤儿 tool_use
    const history = session.getHistory();
    expect(history[history.length - 1]?.role).toBe("toolResult");
  });
});

describe("工具执行 —— 默认串行，声明 executionMode:'parallel' 才并发", () => {
  it("两个都声明 parallel 的工具确实并发执行（执行区间重叠），结果仍按模型给出顺序组装", async () => {
    parallelCallLog.length = 0;
    const { session, events } = await bootSession("mockLlmParallel.ts", [
      { port: "CapabilityProvider", package: fixture("mockCapabilityParallel.ts") },
    ]);

    await session.sendMessage("go");

    expect(parallelCallLog).toHaveLength(2);
    const [a, b] = parallelCallLog;
    // 并发执行 = 两者执行区间有重叠（串行时后者 start 必然 >= 前者 end）。
    const overlap = a.start < b.end && b.start < a.end;
    expect(overlap).toBe(true);

    // 结果消息仍按 toolUseBlocks 原始顺序（模型给出的顺序：toolA 先于 toolB）组装。
    const history = session.getHistory();
    const toolResult = history.find((m: Message) => m.role === "toolResult");
    const blocks = toolResult?.content;
    expect(Array.isArray(blocks) ? blocks.map((b: { toolUseId?: string }) => b.toolUseId) : []).toEqual([
      "a1",
      "b1",
    ]);

    const ends = events.filter((e) => e.type === "tool_execution_end");
    expect(ends).toHaveLength(2);
  });
});

describe("输出截断（stopReason: max_tokens）—— 工具调用整批判失败，不执行", () => {
  it("参数碰巧是合法 JSON 也不执行，回传截断错误让 LLM 重试", async () => {
    const { session, events } = await bootSession("mockLlmMaxTokens.ts", [
      { port: "CapabilityProvider", package: fixture("mockCapability.ts") },
    ]);

    await session.sendMessage("go");

    const toolEnd = events.find((e) => e.type === "tool_execution_end");
    expect(toolEnd).toMatchObject({ isError: true });
    expect(JSON.stringify(toolEnd)).toContain("截断");
    // 未被真的执行：不应出现工具的正常输出格式 "echo:hi"。
    expect(JSON.stringify(toolEnd)).not.toContain("echo:hi");
  });
});

describe("Bug 7 —— 空 assistant 消息不入历史", () => {
  it("既无文本也无工具的回复：不产生 content:[] 空消息", async () => {
    const { session } = await bootSession("mockLlmEmpty.ts");

    const newMessages = await session.sendMessage("hi");
    // 只有 user 一条，空 assistant 被丢弃
    expect(newMessages.every((m: Message) => !(m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0))).toBe(true);
    const history = session.getHistory();
    expect(history.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0)).toBe(false);
  });
});

describe("issue #10 —— LLM 错误分层重试 harness", () => {
  it("前 2 次可重试错误，第 3 次成功：最终成功，llm_retry 事件出现 2 次且 retryCount 递增，sleep 被调用但不真实等待", async () => {
    const sleepCalls: number[] = [];
    const { session, events } = await bootSession("mockLlmRetryable.ts", [], undefined, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    await session.sendMessage("hi");

    const retryEvents = events.filter((e) => e.type === "llm_retry");
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents.map((e) => (e as { retryCount: number }).retryCount)).toEqual([1, 2]);
    expect(sleepCalls).toHaveLength(2);

    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "agent_end", error: undefined });
    const history = session.getHistory();
    const assistant = history.find((m: Message) => m.role === "assistant");
    expect(JSON.stringify(assistant?.content ?? "")).toContain("重试后成功");
  });

  it("一直可重试错误：重试耗尽（默认 maxRetries=3）后落到 agent_end.error 优雅结束路径", async () => {
    const sleepCalls: number[] = [];
    const { session, events } = await bootSession("mockLlmExhaustRetries.ts", [], undefined, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    await expect(session.sendMessage("hi")).resolves.toBeDefined();

    expect(sleepCalls).toHaveLength(3); // 默认 maxRetries=3，耗尽后不再重试
    const retryEvents = events.filter((e) => e.type === "llm_retry");
    expect(retryEvents).toHaveLength(3);

    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "agent_end", error: "服务暂不可用" });
  });

  it("Retry-After 超过 maxDelayMs 上限：不重试，直接判定失败，sleep 从未被调用", async () => {
    const sleepCalls: number[] = [];
    const { session, events } = await bootSession("mockLlmHugeRetryAfter.ts", [], undefined, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    await expect(session.sendMessage("hi")).resolves.toBeDefined();

    expect(sleepCalls).toHaveLength(0);
    expect(events.some((e) => e.type === "llm_retry")).toBe(false);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "agent_end", error: "限流" });
  });

  it("既有 mockLlmStreamError（未设置 retryable）零改动通过：默认不重试的向后兼容承诺", async () => {
    const sleepCalls: number[] = [];
    const { session, events } = await bootSession("mockLlmStreamError.ts", [], undefined, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    await expect(session.sendMessage("hi")).resolves.toBeDefined();

    expect(sleepCalls).toHaveLength(0);
    expect(events.some((e) => e.type === "llm_retry")).toBe(false);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "agent_end", error: "网络超时" });
  });

  it("provider 内部抛非预期异常（非 SDK APIError）：session.sendMessage() reject，且是归一化的 LlmProviderError，cause 保留原始异常", async () => {
    const { session } = await bootSession("mockLlmUnexpectedThrow.ts");

    let caught: unknown;
    try {
      await session.sendMessage("hi");
      expect.unreachable();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmProviderError);
    const llmErr = caught as LlmProviderError;
    expect(llmErr.cause).toBeInstanceOf(TypeError);
    expect((llmErr.cause as TypeError).message).toBe("provider 内部 bug");
  });
});
