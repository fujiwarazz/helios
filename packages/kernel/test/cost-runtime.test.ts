import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { Kernel, type Manifest } from "../src/index";
import type { AgentEvent } from "../src/events";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const noAsk = async (_r: AskQuestionRequest): Promise<AskQuestionResponse> => ({ answers: ["允许"] });
function textOf(m: Message): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}
function agentEnd(events: AgentEvent[]): Extract<AgentEvent, { type: "agent_end" }> {
  const e = [...events].reverse().find((x) => x.type === "agent_end");
  if (!e) throw new Error("no agent_end");
  return e as Extract<AgentEvent, { type: "agent_end" }>;
}

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-cost-"));
  return async () => rm(workDir, { recursive: true, force: true });
});

describe("ModelRouter 接入：按 tier 改写 model", () => {
  it("短输入无工具 → tier0，provider 收到映射表的 tier0 model", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        {
          port: "ModelRouterPort",
          package: "@helios/router-default",
          options: { tiers: ["small", "medium", "large"] },
        },
        { port: "LLMProvider", package: fixture("mockLlmEchoModel.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    await session.sendMessage("hi");
    const history = session.getHistory();
    expect(history.some((m) => textOf(m).includes("MODEL=small"))).toBe(true);
  });

  it("未装 ModelRouter（noop）→ 不改写 model（回显 none）", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "LLMProvider", package: fixture("mockLlmEchoModel.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    await session.sendMessage("hi");
    expect(session.getHistory().some((m) => textOf(m).includes("MODEL=none"))).toBe(true);
  });
});

describe("CostMeter 接入：agent_end 携带成本报告", () => {
  it("装 costmeter-default → 报告累计 usage 与 outcome", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CostMeterPort", package: "@helios/costmeter-default" },
        { port: "LLMProvider", package: fixture("mockLlmEchoModel.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    await session.sendMessage("hi");
    const rep = agentEnd(events).costReport!;
    expect(rep.llmCalls).toBe(1);
    expect(rep.outputTokens).toBe(3);
    expect(rep.uncachedInputTokens).toBe(10);
    expect(rep.outcome).toEqual({ status: "success" });
  });

  it("未装 CostMeter（noop）→ 报告为全零（可插拔回归）", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "LLMProvider", package: fixture("mockLlmEchoModel.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    await session.sendMessage("hi");
    const rep = agentEnd(events).costReport!;
    expect(rep.llmCalls).toBe(0);
    expect(rep.outputTokens).toBe(0);
  });
});

describe("ToolResultCache 接入：同 session 同参第二个 run 命中缓存", () => {
  it("run1 执行工具、run2 命中缓存不再执行；三指标正确", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CostMeterPort", package: "@helios/costmeter-default" },
        { port: "ToolResultCachePort", package: "@helios/toolcache-mem" },
        { port: "CapabilityProvider", package: fixture("capCacheProbe.ts") },
        { port: "LLMProvider", package: fixture("mockLlmCacheProbe.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));

    // run1：真正执行工具（count=1）
    await session.sendMessage("first");
    const run1 = agentEnd(events).costReport!;
    expect(run1.toolExecutions).toBe(1);
    expect(run1.toolCacheHits).toBe(0);
    const firstOutput = events
      .filter((e) => e.type === "tool_execution_end")
      .map((e) => String((e as Extract<AgentEvent, { type: "tool_execution_end" }>).output));
    expect(firstOutput.some((o) => o.includes("count=1"))).toBe(true);

    // run2：同 session、同参 → 命中缓存，工具不再执行（仍返回 count=1）
    events.length = 0;
    await session.sendMessage("second");
    const run2 = agentEnd(events).costReport!;
    expect(run2.toolCacheHits).toBe(1);
    expect(run2.toolExecutions).toBe(0);
    const secondOutput = events
      .filter((e) => e.type === "tool_execution_end")
      .map((e) => String((e as Extract<AgentEvent, { type: "tool_execution_end" }>).output));
    expect(secondOutput.some((o) => o.includes("count=1"))).toBe(true); // 未自增 = 命中缓存
  });

  it("未装 ToolResultCache（noop）→ 每个 run 都执行（count 递增）", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CapabilityProvider", package: fixture("capCacheProbe.ts") },
        { port: "LLMProvider", package: fixture("mockLlmCacheProbe.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    await session.sendMessage("a");
    await session.sendMessage("b");
    // noop 缓存恒 miss → 第二个 run 仍执行（count 继续增长，不会停在同一值）
    const outputs = events
      .filter((e) => e.type === "tool_execution_end")
      .map((e) => String((e as Extract<AgentEvent, { type: "tool_execution_end" }>).output));
    // 两个 run 的输出计数不同（都执行了）
    const uniq = new Set(outputs.filter((o) => o.startsWith("count=")));
    expect(uniq.size).toBeGreaterThanOrEqual(2);
  });
});
