import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { Kernel, type Manifest } from "../src/index";
import type { AgentEvent } from "../src/events";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function capturingLogger(): { logger: Logger; errors: string[]; infos: string[] } {
  const errors: string[] = [];
  const infos: string[] = [];
  return {
    errors,
    infos,
    logger: {
      debug: () => {},
      info: (...a) => infos.push(a.join(" ")),
      warn: () => {},
      error: (...a) => errors.push(a.join(" ")),
    },
  };
}

const noAsk = async (_r: AskQuestionRequest): Promise<AskQuestionResponse> => ({ answers: ["允许"] });

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-test-"));
  return async () => {
    await rm(workDir, { recursive: true, force: true });
  };
});

describe("Kernel 集成 —— 纯文本 turn", () => {
  it("跑通 agent_start→turn→agent_end，产出 user+assistant 两条消息并持久化 turn", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "LLMProvider", package: fixture("mockLlmTextOnly.ts") },
      ],
    };
    const { logger } = capturingLogger();
    const kernel = new Kernel({ workDir, manifest, logger });
    await kernel.start();

    const events: AgentEvent[] = [];
    const session = kernel.createSession({ askQuestion: noAsk });
    session.on((e) => events.push(e));

    const newMessages = await session.sendMessage("hi");

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("agent_start");
    expect(types).toContain("turn_start");
    expect(types).toContain("message_start");
    expect(types).toContain("message_end");
    expect(types).toContain("turn_end");
    expect(types[types.length - 1]).toBe("agent_end");

    expect(newMessages).toHaveLength(2);
    const assistant = newMessages.find((m: Message) => m.role === "assistant")!;
    expect(assistant.content).toEqual([{ type: "text", text: "Hello world" }]);

    const jsonl = await readFile(
      join(workDir, ".helios", "sessions", session.id, "turns.jsonl"),
      "utf8",
    );
    expect(jsonl.trim().split("\n")).toHaveLength(1);
  });
});

describe("Kernel 集成 —— 工具调用 turn 循环", () => {
  it("发起工具调用 → 执行 → 结果喂回 → 第二 turn 文本结束", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CapabilityProvider", package: fixture("mockCapability.ts") },
        { port: "LLMProvider", package: fixture("mockLlmWithTool.ts") },
      ],
    };
    const { logger } = capturingLogger();
    const kernel = new Kernel({ workDir, manifest, logger });
    await kernel.start();

    // 工具带 provider 前缀
    expect(kernel.listTools()).toContain("mock__echo");
    // 六件套内建豁免前缀
    expect(kernel.listTools()).toContain("Bash");
    expect(kernel.listTools()).toContain("Read");

    const events: AgentEvent[] = [];
    const session = kernel.createSession({ askQuestion: noAsk });
    session.on((e) => events.push(e));

    const newMessages = await session.sendMessage("go");

    const toolStart = events.find((e) => e.type === "tool_execution_start");
    expect(toolStart).toMatchObject({ name: "mock__echo" });
    const toolEnd = events.find((e) => e.type === "tool_execution_end");
    expect(toolEnd).toMatchObject({ output: "echo:hi", isError: false });

    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(2);

    const last = newMessages[newMessages.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(last.content).toEqual([{ type: "text", text: "done" }]);
  });
});

describe("Kernel 装配 —— 必须实现的 Port", () => {
  it("无 LLMProvider → start 中止", async () => {
    const manifest: Manifest = {
      plugins: [{ port: "FileSystemPort", package: "@helios/fs-node" }],
    };
    const { logger } = capturingLogger();
    const kernel = new Kernel({ workDir, manifest, logger });
    await expect(kernel.start()).rejects.toThrow(/LLMProvider/);
  });

  it("无 FileSystemPort → start 中止", async () => {
    const manifest: Manifest = {
      plugins: [{ port: "LLMProvider", package: fixture("mockLlmTextOnly.ts") }],
    };
    const { logger } = capturingLogger();
    const kernel = new Kernel({ workDir, manifest, logger });
    await expect(kernel.start()).rejects.toThrow(/FileSystemPort/);
  });
});

describe("Kernel 装配 —— 降级：可选 Port 全不加载仍正常对话", () => {
  it("只配 fs + llm，无 memory/multiAgent/compact/checkpoint，对话照常", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "LLMProvider", package: fixture("mockLlmTextOnly.ts") },
      ],
    };
    const { logger } = capturingLogger();
    const kernel = new Kernel({ workDir, manifest, logger });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const newMessages = await session.sendMessage("hi");
    expect(newMessages).toHaveLength(2);
  });
});

describe("PluginLoader —— 版本与 shape 校验", () => {
  it("apiVersion 不符的 LLM 被拒载（且无其它 LLM → start 中止）", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "LLMProvider", package: fixture("badVersionLlm.ts") },
      ],
    };
    const cap = capturingLogger();
    const kernel = new Kernel({ workDir, manifest, logger: cap.logger });
    await expect(kernel.start()).rejects.toThrow(/LLMProvider/);
    expect(cap.errors.some((e) => /apiVersion/.test(e))).toBe(true);
  });

  it("shape 校验失败的插件被跳过，kernel 仍能启动", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CompactStrategyPort", package: fixture("malformedCompact.ts") },
        { port: "LLMProvider", package: fixture("mockLlmTextOnly.ts") },
      ],
    };
    const cap = capturingLogger();
    const kernel = new Kernel({ workDir, manifest, logger: cap.logger });
    await kernel.start();
    expect(cap.errors.some((e) => /compact/.test(e))).toBe(true);
    const session = kernel.createSession({ askQuestion: noAsk });
    expect(await session.sendMessage("hi")).toHaveLength(2);
  });

  it("单实例 Port 重复声明报错并被记录", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "LLMProvider", package: fixture("mockLlmTextOnly.ts") },
      ],
    };
    const cap = capturingLogger();
    const kernel = new Kernel({ workDir, manifest, logger: cap.logger });
    await kernel.start();
    expect(cap.errors.some((e) => /重复声明/.test(e))).toBe(true);
  });
});
