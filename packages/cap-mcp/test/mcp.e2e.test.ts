import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import type { KernelContext, Logger, Tool } from "@helios/ports";
import { create } from "../src/index";

// 外部进程集成测试：默认跳过，HELIOS_MCP_E2E=1 时启用（会 spawn node 子进程跑 echo-server）。
const ENABLED = process.env.HELIOS_MCP_E2E === "1";
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const server = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const noCtx = {} as unknown as Parameters<Tool["execute"]>[1];

describe.skipIf(!ENABLED)("cap-mcp stdio 集成", () => {
  it("连接 echo-server → 映射工具 → 调用", async () => {
    const ctx = {
      workDir: process.cwd(),
      logger: silent,
      options: { server: "echo", command: process.execPath, args: [server] },
    } as unknown as KernelContext;

    const provider = create(ctx);
    await provider.activate(ctx);
    expect(provider.name).toBe("mcp:echo");

    const tools = provider.getTools!();
    const echo = tools.find((t) => t.name === "echo");
    expect(echo).toBeDefined();

    const res = await echo!.execute({ text: "hi" }, noCtx);
    expect(res.output).toBe("echo:hi");
    expect(res.isError).toBeFalsy();

    await provider.dispose!();
  });
});
