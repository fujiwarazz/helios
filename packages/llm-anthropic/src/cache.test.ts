import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { cachedSystem, applyCacheBreakpoints } from "./convert";

type Msg = Anthropic.MessageParam;

describe("prompt cache 断点（缓存纪律二）", () => {
  it("cachedSystem 把 system 包成带 ephemeral cache_control 的 text block", () => {
    const [block] = cachedSystem("你是助手");
    expect(block).toEqual({
      type: "text",
      text: "你是助手",
      cache_control: { type: "ephemeral" },
    });
  });

  it("applyCacheBreakpoints 在倒数第二个 message 的最后一个块打断点", () => {
    const msgs: Msg[] = [
      { role: "user", content: "问题一" },
      { role: "assistant", content: [{ type: "text", text: "回答一" }] },
      { role: "user", content: "问题二" },
    ];
    applyCacheBreakpoints(msgs);
    // 倒数第二个 = index 1（assistant），字符串内容不受影响
    const target = msgs[1].content as { type: string; cache_control?: unknown }[];
    expect(target[target.length - 1].cache_control).toEqual({ type: "ephemeral" });
    // 其它 message 不打断点
    expect(typeof msgs[2].content).toBe("string");
  });

  it("字符串内容的倒数第二 message 被转成带 cache_control 的 text block", () => {
    const msgs: Msg[] = [
      { role: "user", content: "只有两条-一" },
      { role: "assistant", content: "只有两条-二" },
    ];
    applyCacheBreakpoints(msgs);
    const target = msgs[0].content as { type: string; text: string; cache_control?: unknown }[];
    expect(Array.isArray(target)).toBe(true);
    expect(target[0]).toEqual({
      type: "text",
      text: "只有两条-一",
      cache_control: { type: "ephemeral" },
    });
  });

  it("单条 message 时退化为对最后一条打断点；空数组不报错", () => {
    const single: Msg[] = [{ role: "user", content: "唯一" }];
    applyCacheBreakpoints(single);
    const target = single[0].content as { cache_control?: unknown }[];
    expect(target[target.length - 1].cache_control).toEqual({ type: "ephemeral" });

    expect(() => applyCacheBreakpoints([])).not.toThrow();
  });
});
