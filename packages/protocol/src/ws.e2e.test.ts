import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { Logger, AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { Kernel, type Manifest, type AgentEvent } from "@helios/kernel";
import { RpcServer } from "./server";
import { RpcClient } from "./client";
import { nodeWsServerTransport, nodeWsClientTransport } from "./wsTransport";

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const noAsk = async (_r: AskQuestionRequest): Promise<AskQuestionResponse> => ({ answers: ["允许"] });

function fixture(name: string): string {
  return fileURLToPath(new URL(`../../kernel/test/fixtures/${name}`, import.meta.url));
}

/** 轮询等待条件成立;超时抛错(替代固定 setTimeout,不受机器负载影响)。 */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时:条件未在期限内成立");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let workDir: string;
let wss: WebSocketServer;
let url: string;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-proto-e2e-"));
  const manifest: Manifest = {
    plugins: [
      { port: "FileSystemPort", package: "@helios/fs-node" },
      { port: "CapabilityProvider", package: fixture("mockCapability.ts") },
      { port: "LLMProvider", package: fixture("mockLlmWithTool.ts") },
    ],
  };
  const kernel = new Kernel({ workDir, manifest, logger: silent });
  await kernel.start();

  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as AddressInfo).port;
  url = `ws://127.0.0.1:${port}`;

  // 每个连接绑一个真实 Session —— 这段就是未来 app 要写的 host 胶水(约 20 行)。
  wss.on("connection", (conn) => {
    const session = kernel.createSession({ askQuestion: noAsk });
    const transport = nodeWsServerTransport(conn);
    const server = new RpcServer(transport, {
      sessionId: () => session.id,
      history: () => session.getHistory(),
      sendMessage: (p) => session.sendMessage((p as { text: string }).text),
    });
    const unbind = session.on((e: AgentEvent) =>
      server.broadcast(`session:${session.id}`, e, session.id),
    );
    transport.onClose(() => unbind());
  });
});

afterEach(async () => {
  cleanups.splice(0).forEach((c) => c());
  await new Promise<void>((r) => wss.close(() => r()));
  await rm(workDir, { recursive: true, force: true });
});

describe("protocol WS e2e —— 客户端驱动真实 Kernel Session", () => {
  it("连上 → 拿 sessionId → 订阅事件 → 发消息驱动一个 run → 收到事件流 + history", async () => {
    const rpc = new RpcClient(() => nodeWsClientTransport(url));
    cleanups.push(() => rpc.close());

    const sessionId = (await rpc.call("sessionId")) as string;
    expect(sessionId).toBeTruthy();

    const events: AgentEvent[] = [];
    const seqs: number[] = [];
    rpc.on(`session:${sessionId}`, (payload, seq) => {
      events.push(payload as AgentEvent);
      seqs.push(seq);
    });

    await rpc.call("sendMessage", { text: "go" }, { timeoutMs: 15_000 });
    // 事件经网络异步推送,可能晚于 sendMessage resolve。轮询等 agent_end 到达(不猜固定时间)。
    await waitFor(() => events.some((e) => e.type === "agent_end"), 5_000);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("agent_start");
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    expect(types[types.length - 1]).toBe("agent_end");

    // seq 每个 channel 独立、单调递增
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    expect(seqs[0]).toBe(1);

    const history = (await rpc.call("history")) as Message[];
    expect(history.some((m) => m.role === "assistant")).toBe(true);
  });
});
