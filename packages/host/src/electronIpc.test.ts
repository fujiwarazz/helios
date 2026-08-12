// ============================================================================
// packages/host/src/electronIpc.test.ts
// serveKernelOverElectronIpc 端到端：用一对内存里"背靠背"的假 ElectronIpcBridge
// 模拟主进程 ↔ 渲染进程（不依赖真实 electron），验证连接受理循环与 serveKernelOverWs
// 语义等价（bindSession 本身是同一份代码，这里只验证"受理方式换了但行为不变"）。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, Message, Disposable } from "@helios/ports";
import { Kernel, type Manifest, type AgentEvent } from "@helios/kernel";
import { RpcClient, electronRendererTransport, type ElectronIpcBridge } from "@helios/protocol";
import { serveKernelOverElectronIpc, type ElectronConnectRequest } from "./index";

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

/** 一对互联的内存 bridge，模拟主进程(main)/渲染进程(renderer)两侧。 */
function makeLinkedBridges(): { main: ElectronIpcBridge; renderer: ElectronIpcBridge } {
  const msgCbsMain = new Set<(cid: string, data: string) => void>();
  const msgCbsRenderer = new Set<(cid: string, data: string) => void>();
  const closeCbsMain = new Set<(cid: string) => void>();
  const closeCbsRenderer = new Set<(cid: string) => void>();

  const main: ElectronIpcBridge = {
    send: (cid, data) => msgCbsRenderer.forEach((cb) => cb(cid, data)),
    onMessage: (cb) => (msgCbsMain.add(cb), { dispose: () => msgCbsMain.delete(cb) }),
    onClose: (cb) => (closeCbsMain.add(cb), { dispose: () => closeCbsMain.delete(cb) }),
    close: (cid) => closeCbsRenderer.forEach((cb) => cb(cid)),
  };
  const renderer: ElectronIpcBridge = {
    send: (cid, data) => msgCbsMain.forEach((cb) => cb(cid, data)),
    onMessage: (cb) => (msgCbsRenderer.add(cb), { dispose: () => msgCbsRenderer.delete(cb) }),
    onClose: (cb) => (closeCbsRenderer.add(cb), { dispose: () => closeCbsRenderer.delete(cb) }),
    close: (cid) => closeCbsMain.forEach((cb) => cb(cid)),
  };
  return { main, renderer };
}

/** 模拟 `ipcMain.handle('helios:connect', ...)`：暴露一个可被测试直接调用的 dispatch。 */
function makeConnectChannel(): {
  onConnect: (handler: (req: ElectronConnectRequest) => Promise<void>) => Disposable;
  dispatch: (req: ElectronConnectRequest) => Promise<void>;
} {
  let handler: ((req: ElectronConnectRequest) => Promise<void>) | undefined;
  return {
    onConnect(h) {
      handler = h;
      return { dispose: () => (handler = undefined) };
    },
    dispatch(req) {
      if (!handler) throw new Error("尚未订阅 onConnect");
      return handler(req);
    },
  };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-host-electron-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("@helios/host serveKernelOverElectronIpc —— 与 serveKernelOverWs 同构的连接受理循环", () => {
  it("connect → sessionId → sendMessage 驱动 run → 事件流 + history（不经 WebSocket）", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CapabilityProvider", package: fixture("mockCapability.ts") },
        { port: "LLMProvider", package: fixture("mockLlmWithTool.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();

    const { main, renderer } = makeLinkedBridges();
    const { onConnect, dispatch } = makeConnectChannel();
    const handle = serveKernelOverElectronIpc({ kernel, bridge: main, onConnect });

    const connectionId = "conn-1";
    await dispatch({ connectionId }); // 模拟 renderer 的 connect() 调用等到 ack 才继续

    const rpc = new RpcClient(() => electronRendererTransport(renderer, connectionId));
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

    rpc.close();
    handle.dispose();
  });

  it("同一 bridge 上两条 connectionId 互不串扰（多路复用）", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CapabilityProvider", package: fixture("mockCapability.ts") },
        { port: "LLMProvider", package: fixture("mockLlmWithTool.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();

    const { main, renderer } = makeLinkedBridges();
    const { onConnect, dispatch } = makeConnectChannel();
    const handle = serveKernelOverElectronIpc({ kernel, bridge: main, onConnect });

    await dispatch({ connectionId: "conn-a" });
    await dispatch({ connectionId: "conn-b" });

    const rpcA = new RpcClient(() => electronRendererTransport(renderer, "conn-a"));
    const rpcB = new RpcClient(() => electronRendererTransport(renderer, "conn-b"));
    const sidA = (await rpcA.call("sessionId")) as string;
    const sidB = (await rpcB.call("sessionId")) as string;

    expect(sidA).toBeTruthy();
    expect(sidB).toBeTruthy();
    expect(sidA).not.toBe(sidB); // 每条 connectionId 各自一个新 Session（对齐"一连接一会话"）

    rpcA.close();
    rpcB.close();
    handle.dispose();
  });
});
