import { describe, it, expect } from "vitest";
import { HookRunner } from "../src/hookRunner";
import { ToolRegistry } from "../src/toolRegistry";
import type { Tool, HookBinding } from "@helios/ports";

const dummyTool = (name: string): Tool => ({
  name,
  description: "",
  inputSchema: { type: "object" },
  async execute() {
    return { output: "" };
  },
});

describe("ToolRegistry —— namespace 前缀", () => {
  it("非豁免加前缀，豁免不加前缀", () => {
    const reg = new ToolRegistry();
    reg.add("builtin", [dummyTool("Bash")], true);
    reg.add("mock", [dummyTool("echo")], false);
    const names = reg.list().map((t) => t.name);
    expect(names).toContain("Bash");
    expect(names).toContain("mock__echo");
  });

  it("最终名冲突报错", () => {
    const reg = new ToolRegistry();
    reg.add("a", [dummyTool("x")], true);
    expect(() => reg.add("a", [dummyTool("x")], true)).toThrow(/冲突/);
  });
});

describe("HookRunner —— PreToolUse 合并优先级 deny>ask>allow", () => {
  it("任一 deny → deny", async () => {
    const r = new HookRunner();
    const bindings: HookBinding[] = [
      { event: "PreToolUse", handler: () => ({ decision: "allow" }) },
      { event: "PreToolUse", handler: () => ({ decision: "deny", reason: "no" }) },
      { event: "PreToolUse", handler: () => ({ decision: "ask" }) },
    ];
    r.register(bindings);
    const d = await r.runPreToolUse({ toolName: "t", input: {} });
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("no");
  });

  it("无 deny 有 ask → ask；allow 可改写 input", async () => {
    const r = new HookRunner();
    r.register([
      { event: "PreToolUse", handler: () => ({ decision: "allow", input: { a: 1 } }) },
      { event: "PreToolUse", handler: () => ({ decision: "ask" }) },
    ]);
    const d = await r.runPreToolUse({ toolName: "t", input: {} });
    expect(d.decision).toBe("ask");
    expect(d.input).toEqual({ a: 1 });
  });

  it("handler 抛错不影响其它 handler（allSettled）", async () => {
    const r = new HookRunner();
    r.register([
      {
        event: "PreToolUse",
        handler: () => {
          throw new Error("boom");
        },
      },
      { event: "PreToolUse", handler: () => ({ decision: "deny" }) },
    ]);
    const d = await r.runPreToolUse({ toolName: "t", input: {} });
    expect(d.decision).toBe("deny");
  });
});

describe("HookRunner —— Stop 合并", () => {
  it("任一 block → block，message 拼接", async () => {
    const r = new HookRunner();
    r.register([
      { event: "Stop", handler: () => ({ block: true, message: "继续 A" }) },
      { event: "Stop", handler: () => ({ block: true, message: "继续 B" }) },
      { event: "Stop", handler: () => undefined },
    ]);
    const d = await r.runStop({ turnCount: 1 });
    expect(d.block).toBe(true);
    expect(d.message).toContain("继续 A");
    expect(d.message).toContain("继续 B");
  });
});

describe("HookRunner —— PostToolUse 输出改写", () => {
  it("后一个 handler 的 output 覆盖前一个，block 生效", async () => {
    const r = new HookRunner();
    r.register([
      { event: "PostToolUse", handler: () => ({ output: "v1" }) },
      { event: "PostToolUse", handler: () => ({ output: "v2", block: true }) },
    ]);
    const d = await r.runPostToolUse({ toolName: "t", input: {}, output: "orig" });
    expect(d.output).toBe("v2");
    expect(d.block).toBe(true);
  });
});

describe("HookRunner —— UserPromptSubmit 合并", () => {
  it("任一 block → block；text 取最后一个非 undefined；additionalContext 拼接", async () => {
    const r = new HookRunner();
    r.register([
      { event: "UserPromptSubmit", handler: () => ({ text: "改写1", additionalContext: "ctx-A" }) },
      { event: "UserPromptSubmit", handler: () => ({ block: true, reason: "拒绝" }) },
      { event: "UserPromptSubmit", handler: () => ({ additionalContext: "ctx-B" }) },
    ]);
    const d = await r.runUserPromptSubmit({ text: "原文" });
    expect(d.block).toBe(true);
    expect(d.reason).toBe("拒绝");
    expect(d.text).toBe("改写1"); // 后续 handler 未改写 text，保留最后一个非 undefined
    expect(d.additionalContext).toBe("ctx-A\nctx-B");
  });

  it("无 handler 时原样返回 payload.text，additionalContext 为 undefined", async () => {
    const r = new HookRunner();
    const d = await r.runUserPromptSubmit({ text: "原文" });
    expect(d.block).toBe(false);
    expect(d.text).toBe("原文");
    expect(d.additionalContext).toBeUndefined();
  });
});

describe("HookRunner —— SessionStart 合并", () => {
  it("多 handler 的 additionalContext 拼接", async () => {
    const r = new HookRunner();
    r.register([
      { event: "SessionStart", handler: () => ({ additionalContext: "A" }) },
      { event: "SessionStart", handler: () => undefined },
      { event: "SessionStart", handler: () => ({ additionalContext: "B" }) },
    ]);
    const d = await r.runSessionStart({ sessionId: "s1", workDir: "/tmp", source: "startup" });
    expect(d.additionalContext).toBe("A\nB");
  });

  it("无 handler 时返回 undefined", async () => {
    const r = new HookRunner();
    const d = await r.runSessionStart({ sessionId: "s1", workDir: "/tmp", source: "startup" });
    expect(d.additionalContext).toBeUndefined();
  });
});

describe("HookRunner —— SessionEnd 通知", () => {
  it("多 handler 全部执行；一个抛错不影响其它 handler（allSettled）", async () => {
    const r = new HookRunner();
    const calls: string[] = [];
    r.register([
      {
        event: "SessionEnd",
        handler: () => {
          throw new Error("boom");
        },
      },
      {
        event: "SessionEnd",
        handler: () => {
          calls.push("second");
        },
      },
    ]);
    await r.runSessionEnd({ sessionId: "s1", workDir: "/tmp" });
    expect(calls).toEqual(["second"]);
  });
});
