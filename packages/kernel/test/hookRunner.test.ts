import { describe, it, expect } from "vitest";
import { HookRunner } from "../src/hookRunner";
import type { HookBinding, Logger } from "@helios/ports";

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

describe("HookRunner —— handler 异常记录（不再静默丢弃）", () => {
  it("一个 handler reject：日志包含事件名 + 原始 message", async () => {
    const { logger, warnCalls } = recordingLogger();
    const r = new HookRunner(logger);
    const bindings: HookBinding[] = [
      {
        event: "PreToolUse",
        handler: () => {
          throw new Error("boom");
        },
      },
    ];
    r.register(bindings);
    await r.runPreToolUse({ sessionId: "s1", toolName: "t", input: {} });

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("PreToolUse");
    expect(warnCalls[0]).toContain("boom");
  });

  it("非 Error 的 reject（如 reject 一个字符串）不崩、能被安全 stringify", async () => {
    const { logger, warnCalls } = recordingLogger();
    const r = new HookRunner(logger);
    r.register([
      {
        event: "Stop",
        handler: () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw "plain string reason";
        },
      },
    ]);
    const d = await r.runStop({ sessionId: "s1", turnCount: 1 });

    expect(d.block).toBe(false);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("Stop");
    expect(warnCalls[0]).toContain("plain string reason");
  });

  it("一个 handler reject 不影响另一个 handler 的正常返回值参与合并", async () => {
    const { logger } = recordingLogger();
    const r = new HookRunner(logger);
    r.register([
      {
        event: "PreToolUse",
        handler: () => {
          throw new Error("boom");
        },
      },
      { event: "PreToolUse", handler: () => ({ decision: "allow" as const }) },
    ]);
    const d = await r.runPreToolUse({ sessionId: "s1", toolName: "t", input: { a: 1 } });

    expect(d.decision).toBe("allow");
  });

  it("所有 handler 都 reject 时，返回该事件类型的默认决策（当前 fail-open 行为不变）", async () => {
    const { logger } = recordingLogger();
    const r = new HookRunner(logger);
    r.register([
      {
        event: "PreToolUse",
        handler: () => {
          throw new Error("boom1");
        },
      },
      {
        event: "PreToolUse",
        handler: () => {
          throw new Error("boom2");
        },
      },
    ]);
    const d = await r.runPreToolUse({ sessionId: "s1", toolName: "t", input: { a: 1 } });

    expect(d.decision).toBe("allow");
    expect(d.input).toEqual({ a: 1 });
  });

  it("logger.warn 本身抛异常时，settleAll 依然正常 resolve（safeWarn 的自我保护）", async () => {
    const throwingLogger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {
        throw new Error("logger 自己也坏了");
      },
      error: () => {},
    };
    const r = new HookRunner(throwingLogger);
    r.register([
      {
        event: "PreToolUse",
        handler: () => {
          throw new Error("boom");
        },
      },
    ]);

    await expect(r.runPreToolUse({ sessionId: "s1", toolName: "t", input: {} })).resolves.toMatchObject({
      decision: "allow",
    });
  });

  it("reject 的 reason 是自定义 toString() 会抛异常的对象时，settleAll 依然正常 resolve", async () => {
    const { logger } = recordingLogger();
    const r = new HookRunner(logger);
    const badReason = {
      toString() {
        throw new Error("toString 也坏了");
      },
    };
    r.register([
      {
        event: "PreToolUse",
        handler: () => {
          throw badReason;
        },
      },
    ]);

    await expect(r.runPreToolUse({ sessionId: "s1", toolName: "t", input: {} })).resolves.toMatchObject({
      decision: "allow",
    });
  });

  it("不传 logger（如 new HookRunner()）默认 no-op，不抛异常", async () => {
    const r = new HookRunner();
    r.register([
      {
        event: "PreToolUse",
        handler: () => {
          throw new Error("boom");
        },
      },
    ]);

    await expect(r.runPreToolUse({ sessionId: "s1", toolName: "t", input: {} })).resolves.toMatchObject({
      decision: "allow",
    });
  });
});
