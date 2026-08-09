import { describe, it, expect } from "vitest";
import { LlmProviderError, normalizeLlmError } from "./errors";

describe("normalizeLlmError", () => {
  it("已是 LlmProviderError 时原样返回，不重复包装", () => {
    const original = new LlmProviderError("原始错误", new Error("底层"));
    expect(normalizeLlmError(original)).toBe(original);
  });

  it("其它 Error 包一层 LlmProviderError，message 沿用、cause 保留原始错误", () => {
    const original = new TypeError("provider bug");
    const wrapped = normalizeLlmError(original);
    expect(wrapped).toBeInstanceOf(LlmProviderError);
    expect(wrapped.message).toBe("provider bug");
    expect(wrapped.cause).toBe(original);
    expect(wrapped.code).toBe("llm_provider");
  });

  it("非 Error 值也能转成消息字符串，cause 保留原始值", () => {
    const wrapped = normalizeLlmError("字符串异常");
    expect(wrapped).toBeInstanceOf(LlmProviderError);
    expect(wrapped.message).toBe("字符串异常");
    expect(wrapped.cause).toBe("字符串异常");
  });
});
