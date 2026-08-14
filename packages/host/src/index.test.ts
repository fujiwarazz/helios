import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, Message } from "@helios/ports";
import { Kernel, type Manifest, type AgentEvent } from "@helios/kernel";
import { RpcClient, nodeWsClientTransport } from "@helios/protocol";
import { serveKernelOverWs, type ServeHandle } from "./index";
import { calls as hookCalls } from "../../kernel/test/fixtures/hookCaptureCapability";

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

  it("分支 RPC 往返：rollback 后长出新分支，listBranches 能枚举、switchBranch 能切回", async () => {
    const url = `ws://127.0.0.1:${handle.port}`;
    const rpc = new RpcClient(() => nodeWsClientTransport(url));
    cleanups.push(() => rpc.close());

    const sessionId = (await rpc.call("sessionId")) as string;
    const events: AgentEvent[] = [];
    rpc.on(`session:${sessionId}`, (payload) => events.push(payload as AgentEvent));

    await rpc.call("sendMessage", { text: "第一轮" }, { timeoutMs: 15_000 });
    await waitFor(() => events.filter((e) => e.type === "agent_end").length === 1, 5_000);
    const mainLeafId = ((await rpc.call("displayHistory")) as Message[]).slice(-1)[0].id;

    // 回溯到这一轮之前，再发一条 → 从锚点长出第二条分支
    await rpc.call("rollback", { turnId: `${sessionId}-0-0` });
    await rpc.call("sendMessage", { text: "另一条分支" }, { timeoutMs: 15_000 });
    await waitFor(() => events.filter((e) => e.type === "agent_end").length === 2, 5_000);

    const branches = (await rpc.call("listBranches")) as {
      leafId: string;
      isCurrent: boolean;
      preview: string;
    }[];
    expect(branches).toHaveLength(2);
    expect(branches.map((b) => b.leafId)).toContain(mainLeafId);
    // 旧分支未被删除，且当前不在它上面
    expect(branches.find((b) => b.leafId === mainLeafId)?.isCurrent).toBe(false);

    // 切回旧分支：HEAD 变化会广播 head_changed，历史随之变回主线
    await rpc.call("switchBranch", { leafId: mainLeafId });
    await waitFor(() => events.some((e) => e.type === "head_changed"), 5_000);
    const back = (await rpc.call("displayHistory")) as Message[];
    expect(back.slice(-1)[0].id).toBe(mainLeafId);
  });
});

describe("@helios/host serveKernelOverWs —— 工具渲染描述符（ToolRenderer 注册表接线）", () => {
  it("工具注册了 ToolRenderer 时，tool_execution_end 广播事件带上服务端算好的 descriptor", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CapabilityProvider", package: fixture("mockCapabilityWithRenderer.ts") },
        { port: "LLMProvider", package: fixture("mockLlmWithTool.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const localHandle = await serveKernelOverWs({ kernel, port: 0 });

    const url = `ws://127.0.0.1:${localHandle.port}`;
    const rpc = new RpcClient(() => nodeWsClientTransport(url));
    const sessionId = (await rpc.call("sessionId")) as string;

    const events: AgentEvent[] = [];
    rpc.on(`session:${sessionId}`, (payload) => events.push(payload as AgentEvent));
    await rpc.call("sendMessage", { text: "go" }, { timeoutMs: 15_000 });
    await waitFor(() => events.some((e) => e.type === "agent_end"), 5_000);

    const end = events.find((e) => e.type === "tool_execution_end");
    expect(end).toBeTruthy();
    expect(end).toMatchObject({ descriptor: { label: "Echo(success)", status: "success" } });

    rpc.close();
    await localHandle.close();
  });
});

describe("@helios/host serveKernelOverWs —— 连接关闭触发 SessionEnd", () => {
  it("客户端断开连接后，绑定的 Session.dispose() 被调用，SessionEnd handler 收到通知", async () => {
    hookCalls.length = 0;
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CapabilityProvider", package: fixture("hookCaptureCapability.ts") },
        { port: "LLMProvider", package: fixture("mockLlmWithTool.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const localHandle = await serveKernelOverWs({ kernel, port: 0 });

    const url = `ws://127.0.0.1:${localHandle.port}`;
    const rpc = new RpcClient(() => nodeWsClientTransport(url));
    const sessionId = (await rpc.call("sessionId")) as string;
    expect(sessionId).toBeTruthy();

    rpc.close();
    await waitFor(() => hookCalls.some((c) => c.event === "SessionEnd"), 5_000);

    const ended = hookCalls.find((c) => c.event === "SessionEnd");
    expect(ended?.payload).toMatchObject({ sessionId });

    await localHandle.close();
  });
});
