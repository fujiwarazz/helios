import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Logger,
  KernelContext,
  PortRegistry,
  AgentMessage,
  Message,
  LLMOptions,
  LLMCallRecord,
  StreamEvent,
  Usage,
} from "@helios/ports";
import * as fsNode from "@helios/fs-node";
import * as memoryFs from "@helios/memory-fs";
import * as checkpointFs from "@helios/checkpoint-fs";
import * as compactDefault from "@helios/compact-default";
import * as teamsMailbox from "@helios/teams-mailbox";
import * as capabilityFs from "@helios/capability-fs";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function ctxFor(workDir: string, options?: Record<string, unknown>): KernelContext {
  const ports = {} as PortRegistry;
  const ctx: KernelContext = { workDir, logger: silent, ports, options };
  (ports as { fileSystem: unknown }).fileSystem = fsNode.create(ctx);
  return ctx;
}

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-impl-"));
  return async () => rm(workDir, { recursive: true, force: true });
});

describe("@helios/memory-fs", () => {
  it("remember 写主题文件并进索引，recall 返回索引全文", async () => {
    const mem = memoryFs.create(ctxFor(workDir));
    expect(await mem.recall("x")).toBe(""); // 尚无记忆时降级为空串
    await mem.remember({ key: "topic1", text: "hello world", ts: 1, tags: ["t"] });
    const recalled = await mem.recall("anything");
    expect(recalled).toContain("topic1");
    const topic = await readFile(join(workDir, ".helios/memory/topic1.md"), "utf8");
    expect(topic).toBe("hello world");
  });
});

describe("@helios/checkpoint-fs", () => {
  it("turn 内改文件 → restore → 还原", async () => {
    await writeFile(join(workDir, "a.txt"), "v1", "utf8");
    const cp = checkpointFs.create(ctxFor(workDir));
    const ref = await cp.snapshot("sess-0-0");
    await writeFile(join(workDir, "a.txt"), "v2-modified", "utf8");
    expect(await readFile(join(workDir, "a.txt"), "utf8")).toBe("v2-modified");
    await cp.restore(ref);
    expect(await readFile(join(workDir, "a.txt"), "utf8")).toBe("v1");
  });
});

describe("@helios/compact-default", () => {
  const messages: Message[] = [
    { id: "m1", role: "user", content: "hi" },
    { id: "m2", role: "assistant", content: [{ type: "text", text: "yo" }] },
  ];

  it("按阈值触发，compact 覆盖全部消息 id", async () => {
    const compact = compactDefault.create(ctxFor(workDir, { threshold: 10 }));
    expect(compact.shouldCompact({ messages: [], approxTokens: 100 })).toBe(true);
    expect(compact.shouldCompact({ messages: [], approxTokens: 5 })).toBe(false);
    const summary = await compact.compact(messages, "run-1");
    expect(summary.coveredMessageIds).toEqual(["m1", "m2"]);
  });

  it("无 LLM 可用时回落抽取式摘要，不抛错", async () => {
    // ctxFor 只装了 fileSystem，ports.llm 为 undefined —— 模拟未配置 provider 的情况。
    const compact = compactDefault.create(ctxFor(workDir));
    const summary = await compact.compact(messages, "run-1");
    expect(summary.text).toContain("对话摘要");
  });

  it("有 LLM 时产出模型摘要，且请求带摘要器 system 与对话正文", async () => {
    const seen: LLMOptions[] = [];
    const ctx = ctxFor(workDir);
    let request = "";
    stubLlm(ctx, async function* (msgs, opts) {
      seen.push(opts);
      request = String(msgs[0]!.content);
      yield { type: "text-delta", text: "## Goal\nship it" };
    });
    const summary = await compactDefault.create(ctx).compact(messages, "run-1");
    expect(summary.text).toBe("## Goal\nship it");
    expect(summary.coveredMessageIds).toEqual(["m1", "m2"]);
    expect(seen[0]!.system).toContain("Do not continue the conversation");
    expect(request).toContain("<conversation>");
    expect(request).toContain("user: hi");
  });

  it("把压缩自身的 token 开销上报 CostMeter，标记 purpose=compaction", async () => {
    const calls: { runId: string; rec: LLMCallRecord }[] = [];
    const ctx = ctxFor(workDir);
    const usage: Usage = {
      uncachedInputTokens: 900,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 40,
    };
    stubLlm(ctx, async function* () {
      yield { type: "text-delta", text: "## Goal\nx" };
      yield { type: "message-stop", stopReason: "end_turn", usage };
    });
    (ctx.ports as { costMeter: unknown }).costMeter = {
      onLLMCall: (runId: string, rec: LLMCallRecord) => calls.push({ runId, rec }),
    };
    await compactDefault.create(ctx).compact(messages, "run-42");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.runId).toBe("run-42");
    expect(calls[0]!.rec.purpose).toBe("compaction");
    expect(calls[0]!.rec.usage).toEqual(usage);
  });

  it("provider 走 Result 通道报错时回落抽取式摘要", async () => {
    const ctx = ctxFor(workDir);
    stubLlm(ctx, async function* () {
      yield { type: "error", error: "rate limited", retryable: true };
    });
    const summary = await compactDefault.create(ctx).compact(messages, "run-1");
    expect(summary.text).toContain("对话摘要");
  });

  it("options.llm=false 强制走抽取式，不碰 provider", async () => {
    const ctx = ctxFor(workDir, { llm: false });
    (ctx.ports as { llm: unknown }).llm = {
      list: () => ["fake"],
      get: () => {
        throw new Error("不应被调用");
      },
    };
    const summary = await compactDefault.create(ctx).compact(messages, "run-1");
    expect(summary.text).toContain("对话摘要");
  });

  /** 把一个假 provider 挂到 ctx.ports.llm 上，只需给出要吐的事件流。 */
  function stubLlm(
    ctx: KernelContext,
    stream: (msgs: Message[], opts: LLMOptions) => AsyncGenerator<StreamEvent>,
  ): void {
    (ctx.ports as { llm: unknown }).llm = {
      list: () => ["fake"],
      get: () => ({
        id: "fake",
        streamMessage: (msgs: Message[], _tools: unknown[], opts: LLMOptions) => stream(msgs, opts),
      }),
    };
  }
});

describe("@helios/teams-mailbox", () => {
  it("spawn → send → onMessage 轮询收到消息", async () => {
    const ma = teamsMailbox.create(ctxFor(workDir));
    const handle = await ma.spawn({ name: "bob", prompt: "" });
    const received = new Promise<AgentMessage>((resolve) => {
      const sub = ma.onMessage(handle, (msg) => {
        sub.dispose();
        resolve(msg);
      });
    });
    await ma.send(handle, { from: "a", to: "bob", type: "ping", payload: { n: 1 }, ts: 1 });
    const msg = await received;
    expect(msg.type).toBe("ping");
    expect(msg.payload).toEqual({ n: 1 });
  });
});

describe("@helios/capability-fs", () => {
  it("扫描 SKILL.md 产出工具，调用返回全文", async () => {
    await mkdir(join(workDir, ".helios/capabilities/demo"), { recursive: true });
    await writeFile(join(workDir, ".helios/capabilities/demo/SKILL.md"), "# Demo Skill\ncontent", "utf8");
    const ctx = ctxFor(workDir);
    const cap = capabilityFs.create(ctx);
    await cap.activate(ctx);
    const tools = cap.getTools!();
    expect(tools.map((t) => t.name)).toContain("demo");
    const res = await tools.find((t) => t.name === "demo")!.execute({}, {
      workDir,
      logger: silent,
      askQuestion: async () => ({ answers: [] }),
    });
    expect(res.output).toContain("Demo Skill");
  });
});
