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

  const state = (msgs: Message[], approxTokens = 100) => ({ messages: msgs, approxTokens });

  it("按阈值触发，plan 覆盖全部消息 id", () => {
    const compact = compactDefault.create(ctxFor(workDir, { threshold: 10 }));
    expect(compact.shouldCompact(state([], 100))).toBe(true);
    expect(compact.shouldCompact(state([], 5))).toBe(false);
    expect(compact.plan(state(messages)).coveredMessageIds).toEqual(["m1", "m2"]);
  });

  it("plan 产出两条路线：inline 只给指令，standalone 带摘要器 system 与对话正文", () => {
    const plan = compactDefault.create(ctxFor(workDir)).plan(state(messages));
    // inline 路线复用主会话前缀，因此指令里不该重复对话正文。
    expect(plan.inlineInstruction).toContain("must be compressed into a checkpoint");
    expect(plan.inlineInstruction).not.toContain("<conversation>");
    expect(plan.standalone.system).toContain("Do not continue the conversation");
    expect(plan.standalone.userText).toContain("<conversation>");
    expect(plan.standalone.userText).toContain("user: hi");
    expect(plan.maxTokens).toBeGreaterThan(0);
    // 有 LLM 可用时不预置产物，交由 kernel 发请求。
    expect(plan.precomputed).toBeUndefined();
  });

  it("plan 是纯函数：连调两次同值，且不触碰 ports.llm", () => {
    const ctx = ctxFor(workDir);
    (ctx.ports as { llm: unknown }).llm = {
      list: () => ["fake"],
      get: () => {
        throw new Error("plan() 不应触碰 ports.llm");
      },
    };
    const compact = compactDefault.create(ctx);
    const a = compact.plan(state(messages));
    const b = compact.plan(state(messages));
    expect(a).toEqual(b);
  });

  it("options.llm=false 时给出预置抽取式摘要（kernel 据此不发请求）", () => {
    const plan = compactDefault.create(ctxFor(workDir, { llm: false })).plan(state(messages));
    expect(plan.precomputed).toContain("对话摘要");
  });

  it("空对话同样预置产物，不让 kernel 白发一次请求", () => {
    const plan = compactDefault.create(ctxFor(workDir)).plan(state([]));
    expect(plan.precomputed).toBeDefined();
  });

  it("parseSummary：空白视为产物不可用（undefined），有内容则 trim 后返回", () => {
    const compact = compactDefault.create(ctxFor(workDir));
    expect(compact.parseSummary("   \n ", state(messages))).toBeUndefined();
    expect(compact.parseSummary("  ## Goal\nship it  ", state(messages))).toBe("## Goal\nship it");
  });
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
