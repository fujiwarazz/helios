import { describe, it, expect } from "vitest";
import type { Message } from "@helios/ports";
import { toAnthropicMessages } from "./convert";

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
