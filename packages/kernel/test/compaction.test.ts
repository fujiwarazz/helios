import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { Kernel, type Manifest } from "../src/index";
import type { AgentEvent } from "../src/events";

// kernel 侧压缩行为：调用由 kernel 发（不是 Port 自己发）、计量、以及失败时"什么都不改写"。
// Port 层的 plan/parseSummary 单测在 p1-impls.test.ts。

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const noAsk = async (_r: AskQuestionRequest): Promise<AskQuestionResponse> => ({ answers: ["允许"] });

function textOf(m: Message): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}
type CompactEnd = Extract<AgentEvent, { type: "compact_end" }>;
const compactEnds = (events: AgentEvent[]): CompactEnd[] =>
  events.filter((e): e is CompactEnd => e.type === "compact_end");

/** 装 mockCompactViaLlm（无 precomputed → kernel 必须真发请求）+ 能区分压缩请求的假 provider。 */
function manifestViaLlm(): Manifest {
  return {
    plugins: [
      { port: "FileSystemPort", package: "@helios/fs-node" },
      { port: "CompactStrategyPort", package: fixture("mockCompactViaLlm.ts") },
      { port: "LLMProvider", package: fixture("mockLlmCompactAware.ts") },
    ],
  };
}

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-compaction-"));
  return async () => rm(workDir, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.HELIOS_TEST_COMPACT_MODE;
});

describe("kernel 发起压缩调用", () => {
  it("Port 不给 precomputed → kernel 发摘要请求，产物进 summary 节点", async () => {
    const kernel = new Kernel({ workDir, manifest: manifestViaLlm(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));

    await session.sendMessage("第一条消息包含关键词FIRST");
    await session.sendMessage("第二条消息");

    expect(compactEnds(events).map((e) => e.status)).toContain("ok");
    const history = session.getHistory();
    expect(history.some((m) => textOf(m).includes("COMPACTED_VIA_LLM"))).toBe(true);
    expect(history.some((m) => textOf(m).includes("FIRST"))).toBe(false);
  });

  it("压缩开销计入本 run 的成本报告（kernel 侧上报，Port 不再自报）", async () => {
    const manifest = manifestViaLlm();
    manifest.plugins.push({ port: "CostMeterPort", package: "@helios/costmeter-default" });
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));

    await session.sendMessage("第一条"); // 不触发压缩
    events.length = 0;
    await session.sendMessage("第二条"); // 触发压缩

    const end = events.find(
      (e): e is Extract<AgentEvent, { type: "agent_end" }> => e.type === "agent_end",
    );
    const rep = end!.costReport!;
    // 只有压缩调用会吐 usage（900 uncached / 40 output），所以这些数字出现即证明
    // 压缩开销被记在了本 run 名下 —— 而调用是 kernel 发的，Port 已不再自报。
    expect(rep.llmCalls).toBeGreaterThanOrEqual(1);
    expect(rep.uncachedInputTokens).toBeGreaterThanOrEqual(900);
    expect(rep.outputTokens).toBeGreaterThanOrEqual(40);
  });
});

describe("压缩选路：复用主会话前缀 vs 独立调用", () => {
  /** 跑到触发一次成功压缩，返回 summary 节点文本（内含 route= 标记）。 */
  async function summaryTextOf(opts: Parameters<Kernel["createSession"]>[0]): Promise<string> {
    const kernel = new Kernel({ workDir, manifest: manifestViaLlm(), logger: silent });
    await kernel.start();
    const session = kernel.createSession(opts);
    await session.sendMessage("第一条消息包含关键词FIRST");
    await session.sendMessage("第二条消息");
    const summary = session.getHistory().find((m) => textOf(m).includes("COMPACTED_VIA_LLM"));
    return summary ? textOf(summary) : "";
  }

  it("缓存还热且装得下 → inline：历史与 tools 原样在请求里", async () => {
    const text = await summaryTextOf({ askQuestion: noAsk });
    expect(text).toContain("route=inline");
  });

  it("超过 compactInlineMaxTokens → 回落 standalone（inline 装不下就是 prompt_too_long）", async () => {
    const text = await summaryTextOf({ askQuestion: noAsk, compactInlineMaxTokens: 1 });
    expect(text).toContain("route=standalone");
    // standalone 刻意不带 tools：独立调用不需要工具定义，白发一份是纯浪费。
    expect(text).toContain("tools=0");
  });

  it("距上次 LLM 调用超过 cacheTtlMs → 回落 standalone（冷缓存下 inline 更贵）", async () => {
    const text = await summaryTextOf({ askQuestion: noAsk, cacheTtlMs: 0 });
    expect(text).toContain("route=standalone");
  });

  it("inline 失败不自动改走 standalone：直接进失败路径，不重复付一次全量输入", async () => {
    process.env.HELIOS_TEST_COMPACT_MODE = "error";
    const kernel = new Kernel({ workDir, manifest: manifestViaLlm(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));

    await session.sendMessage("第一条");
    await session.sendMessage("第二条");

    // 一次 compact_start 对应恰好一次 compact_end(failed)：中间没有第二次调用。
    expect(events.filter((e) => e.type === "compact_start")).toHaveLength(1);
    expect(compactEnds(events).map((e) => e.status)).toEqual(["failed"]);
  });
});

describe("压缩失败时什么都不改写", () => {
  it.each(["error", "throw", "empty"] as const)(
    "provider %s → 不装节点、不改历史，status=failed",
    async (mode) => {
      process.env.HELIOS_TEST_COMPACT_MODE = mode;
      const kernel = new Kernel({ workDir, manifest: manifestViaLlm(), logger: silent });
      await kernel.start();
      const session = kernel.createSession({ askQuestion: noAsk });
      const events: AgentEvent[] = [];
      session.on((e) => events.push(e));

      await session.sendMessage("第一条消息包含关键词FIRST");
      const before = session.getHistory().length;
      await session.sendMessage("第二条消息");

      const ends = compactEnds(events);
      expect(ends.map((e) => e.status)).toContain("failed");
      // 历史只因这一轮正常对话增长，没有 summary 节点混进来。
      const history = session.getHistory();
      expect(history.length).toBeGreaterThan(before);
      expect(history.some((m) => textOf(m).includes("compacted_history"))).toBe(false);
      // 被"压缩"的旧节点仍在当前路径上（未被移出）。
      expect(history.some((m) => textOf(m).includes("FIRST"))).toBe(true);
      // run 本身正常收尾。
      expect(events.some((e) => e.type === "agent_end")).toBe(true);
    },
  );

  it("失败不写 log.jsonl：重启后仍无压缩视图", async () => {
    process.env.HELIOS_TEST_COMPACT_MODE = "error";
    const kernel = new Kernel({ workDir, manifest: manifestViaLlm(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    await session.sendMessage("第一条");
    await session.sendMessage("第二条");

    const log = await readFile(join(workDir, ".helios", "sessions", session.id, "log.jsonl"), "utf8");
    expect(log).not.toContain("compacted_history");
  });

  it("连续失败达上限后熔断：不再发压缩请求，status=blocked，会话继续可用", async () => {
    process.env.HELIOS_TEST_COMPACT_MODE = "error";
    const kernel = new Kernel({ workDir, manifest: manifestViaLlm(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));

    // 第 1 条不触发压缩（历史为空）；之后每一轮都触发一次。
    for (let i = 0; i < 6; i++) await session.sendMessage(`第 ${i} 条`);

    const statuses = compactEnds(events).map((e) => e.status);
    expect(statuses.filter((s) => s === "failed")).toHaveLength(3);
    expect(statuses).toContain("blocked");
    // blocked 只在"未发请求"的分支 emit，故它本身即"没再调 provider"的证据。
    const blocked = compactEnds(events).find((e) => e.status === "blocked");
    expect(blocked!.summaryLength).toBe(0);
    expect(blocked!.reason).toContain("暂停自动压缩");
    // 熔断后会话照常对话。
    expect(events.filter((e) => e.type === "agent_end")).toHaveLength(6);
  });

  it("失败后一次成功则计数归零（不会因历史失败而提前熔断）", async () => {
    process.env.HELIOS_TEST_COMPACT_MODE = "error";
    const kernel = new Kernel({ workDir, manifest: manifestViaLlm(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));

    await session.sendMessage("第一条");
    await session.sendMessage("第二条"); // failed #1
    await session.sendMessage("第三条"); // failed #2

    delete process.env.HELIOS_TEST_COMPACT_MODE; // 恢复正常
    await session.sendMessage("第四条"); // ok → 归零

    process.env.HELIOS_TEST_COMPACT_MODE = "error";
    await session.sendMessage("第五条"); // failed #1（若未归零，这里已是第 3 次）
    await session.sendMessage("第六条"); // failed #2

    const statuses = compactEnds(events).map((e) => e.status);
    expect(statuses).not.toContain("blocked");
    expect(statuses.filter((s) => s === "ok")).toHaveLength(1);
  });
});
