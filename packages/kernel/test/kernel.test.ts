import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { Kernel, type Manifest } from "../src/index";
import type { AgentEvent } from "../src/events";
import { calls as hookCalls, behavior as hookBehavior } from "./fixtures/hookCaptureCapability";
import { calls as llmCalls } from "./fixtures/mockLlmCapture";

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
  hookCalls.length = 0;
  hookBehavior.userPromptSubmit = undefined;
  hookBehavior.sessionStart = undefined;
  llmCalls.length = 0;
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

async function bootHookCaptureSession() {
  const manifest: Manifest = {
    plugins: [
      { port: "FileSystemPort", package: "@helios/fs-node" },
      { port: "CapabilityProvider", package: fixture("hookCaptureCapability.ts") },
      { port: "LLMProvider", package: fixture("mockLlmCapture.ts") },
    ],
  };
  const { logger } = capturingLogger();
  const kernel = new Kernel({ workDir, manifest, logger });
  await kernel.start();
  const session = kernel.createSession({ askQuestion: noAsk });
  return { kernel, session };
}

describe("UserPromptSubmit —— 循环触发点", () => {
  it("block 时短路返回，不进入 turn 循环", async () => {
    hookBehavior.userPromptSubmit = () => ({ block: true, reason: "denied" });
    const { session } = await bootHookCaptureSession();

    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    const newMessages = await session.sendMessage("hi");

    expect(newMessages).toHaveLength(1);
    expect(newMessages[0]!.role).toBe("system");
    expect(newMessages[0]!.content).toBe("denied");
    expect(events.some((e) => e.type === "turn_start")).toBe(false);
    expect(llmCalls).toHaveLength(0); // 从未进入 LLM 调用
  });

  it("改写 text 与 additionalContext：进入循环的 user 消息已被改写/追加", async () => {
    hookBehavior.userPromptSubmit = () => ({ text: "改写后的文本", additionalContext: "extra-ctx" });
    const { session } = await bootHookCaptureSession();

    await session.sendMessage("原始文本");

    const userMsg = session.getHistory().find((m: Message) => m.role === "user")!;
    expect(userMsg.content).toContain("改写后的文本");
    expect(userMsg.content).toContain("extra-ctx");
    expect(userMsg.content).not.toContain("原始文本");
  });
});

describe("SessionStart —— 懒触发 + 冻结注入", () => {
  it("仅首次 sendMessage() 触发一次；source 反映 restore() 结果", async () => {
    const { session } = await bootHookCaptureSession();

    await session.sendMessage("第一条");
    await session.sendMessage("第二条");

    const starts = hookCalls.filter((c) => c.event === "SessionStart");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.payload).toMatchObject({ sessionId: session.id, source: "startup" });
  });

  it("resumeSession 恢复历史会话时 source === 'resume'", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CapabilityProvider", package: fixture("hookCaptureCapability.ts") },
        { port: "LLMProvider", package: fixture("mockLlmCapture.ts") },
      ],
    };
    const { logger } = capturingLogger();
    const kernel = new Kernel({ workDir, manifest, logger });
    await kernel.start();
    const first = kernel.createSession({ askQuestion: noAsk });
    await first.sendMessage("hi"); // 落盘 turns.jsonl，供 resume 命中

    hookCalls.length = 0;
    const resumed = await kernel.resumeSession(first.id, { askQuestion: noAsk });
    await resumed.sendMessage("继续");

    const starts = hookCalls.filter((c) => c.event === "SessionStart");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.payload).toMatchObject({ source: "resume" });
  });

  it("additionalContext 折入冻结的 systemPrefix，仅计算一次", async () => {
    hookBehavior.sessionStart = () => ({ additionalContext: "sess-ctx" });
    const { session } = await bootHookCaptureSession();

    await session.sendMessage("第一条");
    await session.sendMessage("第二条");

    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[0]!.opts.system).toContain("sess-ctx");
    expect(llmCalls[1]!.opts.system).toBe(llmCalls[0]!.opts.system); // 冻结，第二次不重算
  });
});

describe("SessionEnd —— dispose() 通知", () => {
  it("调用 dispose() 后 SessionEnd handler 被触发一次，payload 携带正确 sessionId/workDir", async () => {
    const { session } = await bootHookCaptureSession();
    await session.dispose();

    const ends = hookCalls.filter((c) => c.event === "SessionEnd");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.payload).toMatchObject({ sessionId: session.id, workDir });
  });
});

describe("sessionId 贯穿所有 Hook 事件（对齐 valos HookBaseStdin）", () => {
  it("UserPromptSubmit/SessionStart/PreToolUse/PostToolUse/Stop/SessionEnd payload 均带正确 sessionId", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CapabilityProvider", package: fixture("hookCaptureCapability.ts") },
        { port: "CapabilityProvider", package: fixture("mockCapability.ts") },
        { port: "LLMProvider", package: fixture("mockLlmWithTool.ts") },
      ],
    };
    const { logger } = capturingLogger();
    const kernel = new Kernel({ workDir, manifest, logger });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });

    await session.sendMessage("go"); // 一轮 mock__echo 工具调用 + 一轮纯文本结束（触发 Stop）
    await session.dispose();

    const events = ["UserPromptSubmit", "SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];
    for (const event of events) {
      const matched = hookCalls.filter((c) => c.event === event);
      expect(matched.length, `事件 ${event} 应至少触发一次`).toBeGreaterThan(0);
      for (const call of matched) {
        expect(call.payload, `${event} payload 应带 sessionId`).toMatchObject({ sessionId: session.id });
      }
    }
  });
});

describe("HookConfigLoader —— 装配到 Kernel.start()", () => {
  it("<workDir>/.helios/hooks.json 里的 PreToolUse 配置能真正拒绝工具调用", async () => {
    await mkdir(join(workDir, ".helios"), { recursive: true });
    await writeFile(
      join(workDir, ".helios", "hooks.json"),
      JSON.stringify({
        hooks: [
          {
            event: "PreToolUse",
            matcher: "mock__echo",
            command: `node -e "process.stdout.write(JSON.stringify({decision:'deny',reason:'blocked-by-config'}))"`,
          },
        ],
      }),
      "utf8",
    );
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
    const session = kernel.createSession({ askQuestion: noAsk });

    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    await session.sendMessage("go");

    const toolEnd = events.find((e) => e.type === "tool_execution_end");
    expect(toolEnd).toMatchObject({ isError: true });
    expect((toolEnd as { output: string }).output).toContain("blocked-by-config");
  });

  it("无 hooks.json 时 start() 正常完成，行为不受影响", async () => {
    const { session } = await bootHookCaptureSession();
    expect(await session.sendMessage("hi")).toHaveLength(2);
  });
});
