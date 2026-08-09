import { describe, it, expect } from "vitest";
import type { Logger } from "@helios/ports";
import { runHookCommand, matchesHook, DEFAULT_HOOK_TIMEOUT_MS } from "../src/hookCommandExecutor";

function capturingLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    logger: { debug() {}, info() {}, warn: (...a) => warns.push(a.join(" ")), error() {} },
  };
}

describe("matchesHook —— 正则匹配 + 降级", () => {
  it("无 matcher 默认匹配所有", () => {
    expect(matchesHook(undefined, "Bash")).toBe(true);
  });

  it("正则命中/不命中", () => {
    expect(matchesHook("Bash|Write", "Bash")).toBe(true);
    expect(matchesHook("Bash|Write", "Read")).toBe(false);
  });

  it("非法正则降级为字符串全等", () => {
    expect(matchesHook("(", "(")).toBe(true);
    expect(matchesHook("(", "Bash")).toBe(false);
  });
});

describe("runHookCommand —— 退出码/stdout 解析", () => {
  it("exitCode 0 + 合法 JSON stdout → 正确解析 decision", async () => {
    const { logger } = capturingLogger();
    const decision = await runHookCommand<{ toolName: string }, { decision: string; reason?: string }>(
      `node -e "process.stdout.write(JSON.stringify({decision:'deny',reason:'no'}))"`,
      { toolName: "Bash" },
      { cwd: process.cwd(), timeoutMs: DEFAULT_HOOK_TIMEOUT_MS, logger },
    );
    expect(decision).toEqual({ decision: "deny", reason: "no" });
  });

  it("exitCode 2 → 判 deny，reason 取 stderr", async () => {
    const { logger } = capturingLogger();
    const decision = await runHookCommand<unknown, { decision: string; reason?: string }>(
      `node -e "process.stderr.write('拒绝原因'); process.exit(2)"`,
      {},
      { cwd: process.cwd(), timeoutMs: DEFAULT_HOOK_TIMEOUT_MS, logger },
    );
    expect(decision).toEqual({ decision: "deny", reason: "拒绝原因" });
  });

  it("其它非零退出码 → 返回 undefined 并 warn，不抛异常", async () => {
    const { logger, warns } = capturingLogger();
    const decision = await runHookCommand(
      `node -e "process.exit(1)"`,
      {},
      { cwd: process.cwd(), timeoutMs: DEFAULT_HOOK_TIMEOUT_MS, logger },
    );
    expect(decision).toBeUndefined();
    expect(warns.some((w) => w.includes("非零退出"))).toBe(true);
  });

  it("stdout 非法 JSON → 返回 undefined", async () => {
    const { logger } = capturingLogger();
    const decision = await runHookCommand(
      `node -e "process.stdout.write('not json')"`,
      {},
      { cwd: process.cwd(), timeoutMs: DEFAULT_HOOK_TIMEOUT_MS, logger },
    );
    expect(decision).toBeUndefined();
  });

  it("无 stdout 输出 → 返回 undefined（无意见，不参与合并）", async () => {
    const { logger } = capturingLogger();
    const decision = await runHookCommand(`node -e ""`, {}, { cwd: process.cwd(), timeoutMs: DEFAULT_HOOK_TIMEOUT_MS, logger });
    expect(decision).toBeUndefined();
  });

  it("命令执行超时 → 返回 undefined 并 warn，不阻塞测试", async () => {
    const { logger, warns } = capturingLogger();
    const decision = await runHookCommand(
      `node -e "setTimeout(()=>{}, 5000)"`,
      {},
      { cwd: process.cwd(), timeoutMs: 100, logger },
    );
    expect(decision).toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
  }, 10_000);
});
