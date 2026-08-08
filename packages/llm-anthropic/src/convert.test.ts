import { describe, it, expect } from "vitest";
import type { Message } from "@helios/ports";
import { toAnthropicMessages } from "./convert";

describe("toAnthropicMessages —— 连续同角色合并（Anthropic 角色交替约束）", () => {
  it("压缩 summary(user) 紧跟 run 的 userMsg(user) 合并为一条 user 消息", () => {
    const msgs: Message[] = [
      { id: "s", role: "user", content: "<compacted_history>\n摘要\n</compacted_history>" },
      { id: "u", role: "user", content: "新问题" },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    const blocks = out[0].content as { type: string; text: string }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain("摘要");
    expect(blocks[1].text).toBe("新问题");
  });

  it("assistant → toolResult(user) → user 保持交替不误并；连续 toolResult 合并", () => {
    const msgs: Message[] = [
      { id: "u1", role: "user", content: "做事" },
      { id: "a1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
      { id: "tr1", role: "toolResult", content: [{ type: "tool_result", toolUseId: "t1", output: "ok", isError: false }] },
      { id: "tr2", role: "toolResult", content: [{ type: "tool_result", toolUseId: "t2", output: "ok2", isError: false }] },
    ];
    const out = toAnthropicMessages(msgs);
    // user / assistant / (toolResult+toolResult 合并为一条 user)
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const lastBlocks = out[2].content as unknown[];
    expect(lastBlocks).toHaveLength(2); // 两个 tool_result 块合并进一条 user 消息
  });

  it("正常交替消息不受影响", () => {
    const msgs: Message[] = [
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "yo" }] },
      { id: "u2", role: "user", content: "再问" },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("toAnthropicMessages —— thinking 块回传", () => {
  it("带 signature 的 thinking 块保真回传，且置于 text/tool_use 之前", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "reasoned", signature: "sig-abc" },
          { type: "tool_use", id: "t1", name: "Read", input: { p: "x" } },
        ],
      },
    ];
    const out = toAnthropicMessages(messages);
    expect(out).toHaveLength(1);
    const content = out[0].content as unknown as Array<{ type: string; [k: string]: unknown }>;
    // thinking 排第一
    expect(content[0]).toEqual({ type: "thinking", thinking: "reasoned", signature: "sig-abc" });
    // 其余按原顺序跟随
    expect(content[1]).toMatchObject({ type: "text", text: "answer" });
    expect(content[2]).toMatchObject({ type: "tool_use", id: "t1", name: "Read" });
  });

  it("无 signature 的 thinking 块被丢弃（无法通过 Anthropic 回传校验）", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "no sig" },
          { type: "text", text: "hi" },
        ],
      },
    ];
    const out = toAnthropicMessages(messages);
    const content = out[0].content as unknown as Array<{ type: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "text", text: "hi" });
  });
});
