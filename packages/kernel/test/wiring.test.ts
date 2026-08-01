import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
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
  if (typeof m.content === "string") return m.content;
  return JSON.stringify(m.content);
}

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-wiring-"));
  return async () => rm(workDir, { recursive: true, force: true });
});

describe("CompactStrategyPort 接入 turn 循环", () => {
  it("shouldCompact 命中 → 截断历史 + 摘要注入 system + emit compact 事件", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CompactStrategyPort", package: fixture("mockCompact.ts") },
        { port: "LLMProvider", package: fixture("mockLlmEchoSystem.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));

    // run1：历史为空，不触发压缩
    await session.sendMessage("第一条消息包含关键词FIRST");
    expect(events.some((e) => e.type === "compact_start")).toBe(false);

    // run2：历史已有 2 条（user1+assistant1）→ shouldCompact 命中
    await session.sendMessage("第二条消息");

    expect(events.some((e) => e.type === "compact_start")).toBe(true);
    expect(events.some((e) => e.type === "compact_end")).toBe(true);

    // 被覆盖的旧消息（含 FIRST）应从历史移除
    const history = session.getHistory();
    expect(history.some((m) => textOf(m).includes("FIRST"))).toBe(false);

    // run2 的 assistant 回显了 system → 应包含注入的摘要
    const assistant = history.find((m) => m.role === "assistant");
    expect(assistant && textOf(assistant)).toContain("COMPACTED_SUMMARY");
  });
});

describe("内建 Task 工具消费 MultiAgentPort", () => {
  it("装有 teams-mailbox → 派发成功并落地邮箱文件", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "MultiAgentPort", package: "@helios/teams-mailbox" },
        { port: "LLMProvider", package: fixture("mockLlmTask.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));

    await session.sendMessage("去分析日志");

    const end = events.find((e) => e.type === "tool_execution_end") as
      | Extract<AgentEvent, { type: "tool_execution_end" }>
      | undefined;
    expect(end).toBeDefined();
    expect(end!.isError).toBe(false);
    expect(String(end!.output)).toContain("worker");

    // 邮箱文件确实写入 worker inbox
    const inbox = join(workDir, ".helios", "mailbox", "worker", "inbox");
    const files = await readdir(inbox);
    expect(files.filter((f) => f.endsWith(".json")).length).toBeGreaterThanOrEqual(1);
  });

  it("未装 MultiAgentPort（noop）→ Task 返回结构化错误，run 不崩", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "LLMProvider", package: fixture("mockLlmTask.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));

    await session.sendMessage("去分析日志");

    const end = events.find((e) => e.type === "tool_execution_end") as
      | Extract<AgentEvent, { type: "tool_execution_end" }>
      | undefined;
    expect(end).toBeDefined();
    expect(end!.isError).toBe(true);
    // 仍能正常收尾
    expect(events.some((e) => e.type === "agent_end")).toBe(true);
  });
});
