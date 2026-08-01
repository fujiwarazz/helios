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
