import { describe, it, expect } from "vitest";
import { flattenContent } from "./index";

describe("cap-mcp flattenContent", () => {
  it("压平 text 块数组", () => {
    expect(flattenContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  it("非 text 块回退到 JSON", () => {
    expect(flattenContent([{ type: "image", data: "x" }])).toBe('{"type":"image","data":"x"}');
  });

  it("非数组 content 原样/JSON 化", () => {
    expect(flattenContent("hi")).toBe("hi");
    expect(flattenContent({ ok: true })).toBe('{"ok":true}');
  });
});
