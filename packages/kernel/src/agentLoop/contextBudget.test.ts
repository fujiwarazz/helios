import { describe, it, expect } from "vitest";
import type { Message, Logger } from "@helios/ports";
import { warnIfMessagePathExceeds } from "./contextBudget";

function recordingLogger(): { logger: Logger; warnCalls: string[] } {
  const warnCalls: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      warnCalls.push(args.map((a) => String(a)).join(" "));
    },
    error: () => {},
  };
  return { logger, warnCalls };
}

const longPath: Message[] = [{ id: "m1", role: "user", content: "x".repeat(400) }];

describe("warnIfMessagePathExceeds —— 上下文预算可观测性纯函数", () => {
  it("thresholdTokens 未配置：不记录，返回 false", () => {
    const { logger, warnCalls } = recordingLogger();
    expect(warnIfMessagePathExceeds(longPath, "t1", undefined, logger)).toBe(false);
    expect(warnCalls).toHaveLength(0);
  });

  it("thresholdTokens 为 0：视为关闭检查，不记录", () => {
    const { logger, warnCalls } = recordingLogger();
    expect(warnIfMessagePathExceeds(longPath, "t1", 0, logger)).toBe(false);
    expect(warnCalls).toHaveLength(0);
  });

  it("thresholdTokens 为负数：视为关闭检查，不记录", () => {
    const { logger, warnCalls } = recordingLogger();
    expect(warnIfMessagePathExceeds(longPath, "t1", -10, logger)).toBe(false);
    expect(warnCalls).toHaveLength(0);
  });

  it("thresholdTokens 为 NaN：视为关闭检查，不记录", () => {
    const { logger, warnCalls } = recordingLogger();
    expect(warnIfMessagePathExceeds(longPath, "t1", Number.NaN, logger)).toBe(false);
    expect(warnCalls).toHaveLength(0);
  });

  it("thresholdTokens 为 Infinity：视为关闭检查，不记录", () => {
    const { logger, warnCalls } = recordingLogger();
    expect(warnIfMessagePathExceeds(longPath, "t1", Number.POSITIVE_INFINITY, logger)).toBe(false);
    expect(warnCalls).toHaveLength(0);
  });

  it("估算值等于阈值：不记录（严格大于才记录，避免临界抖动）", () => {
    const { logger, warnCalls } = recordingLogger();
    // longPath 估算值 = ceil(400/4) = 100
    expect(warnIfMessagePathExceeds(longPath, "t1", 100, logger)).toBe(false);
    expect(warnCalls).toHaveLength(0);
  });

  it("估算值大于阈值：记录一次，返回 true，日志包含 turnId 与说明文案", () => {
    const { logger, warnCalls } = recordingLogger();
    expect(warnIfMessagePathExceeds(longPath, "t1", 99, logger)).toBe(true);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("t1");
    expect(warnCalls[0]).toContain("message path");
    expect(warnCalls[0]).toContain("不含 system/tools");
  });

  it("空 path（估算值为 0）：不误报", () => {
    const { logger, warnCalls } = recordingLogger();
    expect(warnIfMessagePathExceeds([], "t1", 1, logger)).toBe(false);
    expect(warnCalls).toHaveLength(0);
  });

  it("logger.warn 内部抛错时：函数本身不抛，仍返回超阈值语义的 true", () => {
    const throwingLogger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {
        throw new Error("logger 坏了");
      },
      error: () => {},
    };
    expect(() => warnIfMessagePathExceeds(longPath, "t1", 99, throwingLogger)).not.toThrow();
    expect(warnIfMessagePathExceeds(longPath, "t1", 99, throwingLogger)).toBe(true);
  });
});
