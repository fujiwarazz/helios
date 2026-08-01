import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, Message } from "@helios/ports";
import { Kernel, type Manifest, type AgentEvent } from "@helios/kernel";
import { RpcClient, nodeWsClientTransport } from "@helios/protocol";
import { serveKernelOverWs, type ServeHandle } from "./index";

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function fixture(name: string): string {
  return fileURLToPath(new URL(`../../kernel/test/fixtures/${name}`, import.meta.url));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时:条件未在期限内成立");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let workDir: string;
let handle: ServeHandle;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-host-"));
  const manifest: Manifest = {
    plugins: [
      { port: "FileSystemPort", package: "@helios/fs-node" },
      { port: "CapabilityProvider", package: fixture("mockCapability.ts") },
      { port: "LLMProvider", package: fixture("mockLlmWithTool.ts") },
    ],
  };
  const kernel = new Kernel({ workDir, manifest, logger: silent });
  await kernel.start();
  handle = await serveKernelOverWs({ kernel, port: 0 });
});

afterEach(async () => {
  cleanups.splice(0).forEach((c) => c());
  await handle.close();
  await rm(workDir, { recursive: true, force: true });
});

describe("@helios/host serveKernelOverWs —— 客户端驱动真实 Kernel Session", () => {
  it("连上 → sessionId → 订阅 → sendMessage 驱动 run → 事件流 + history", async () => {
    const url = `ws://127.0.0.1:${handle.port}`;
    const rpc = new RpcClient(() => nodeWsClientTransport(url));
    cleanups.push(() => rpc.close());

    const sessionId = (await rpc.call("sessionId")) as string;
    expect(sessionId).toBeTruthy();

    const events: AgentEvent[] = [];
    rpc.on(`session:${sessionId}`, (payload) => events.push(payload as AgentEvent));

    await rpc.call("sendMessage", { text: "go" }, { timeoutMs: 15_000 });
    await waitFor(() => events.some((e) => e.type === "agent_end"), 5_000);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("agent_start");
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    expect(types[types.length - 1]).toBe("agent_end");

    const history = (await rpc.call("history")) as Message[];
    expect(history.some((m) => m.role === "assistant")).toBe(true);
  });
});
