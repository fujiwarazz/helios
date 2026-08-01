import { describe, it, expect } from "vitest";
import type { Transport } from "./transport";
import { RpcServer } from "./server";
import { RpcClient, RpcCallError } from "./client";

/** 两个互联的内存 Transport(无网络):A.send → B.onMessage,反之亦然。 */
function makeLoopbackPair(): { server: Transport; client: Transport } {
  const aMsg = new Set<(d: string) => void>();
  const bMsg = new Set<(d: string) => void>();
  const aClose = new Set<() => void>();
  const bClose = new Set<() => void>();
  let open = true;
  const closeAll = (): void => {
    if (!open) return;
    open = false;
    aClose.forEach((c) => c());
    bClose.forEach((c) => c());
  };
  const server: Transport = {
    send: (d) => open && queueMicrotask(() => bMsg.forEach((cb) => cb(d))),
    onMessage: (cb) => (aMsg.add(cb), { dispose: () => aMsg.delete(cb) }),
    onClose: (cb) => (aClose.add(cb), { dispose: () => aClose.delete(cb) }),
    close: closeAll,
  };
  const client: Transport = {
    send: (d) => open && queueMicrotask(() => aMsg.forEach((cb) => cb(d))),
    onMessage: (cb) => (bMsg.add(cb), { dispose: () => bMsg.delete(cb) }),
    onClose: (cb) => (bClose.add(cb), { dispose: () => bClose.delete(cb) }),
    close: closeAll,
  };
  return { server, client };
}

describe("RpcServer + RpcClient over loopback", () => {
  it("call 返回 handler 结果", async () => {
    const { server, client } = makeLoopbackPair();
    new RpcServer(server, { add: (p) => { const { a, b } = p as { a: number; b: number }; return a + b; } });
    const rpc = new RpcClient(() => client);
    const result = await rpc.call("add", { a: 2, b: 3 });
    expect(result).toBe(5);
    rpc.close();
  });

  it("handler 抛错 → client reject 带 message", async () => {
    const { server, client } = makeLoopbackPair();
    new RpcServer(server, {
      boom: () => {
        throw new Error("炸了");
      },
    });
    const rpc = new RpcClient(() => client);
    await expect(rpc.call("boom")).rejects.toThrow("炸了");
    rpc.close();
  });

  it("未知方法 → code=method_not_found", async () => {
    const { server, client } = makeLoopbackPair();
    new RpcServer(server, {});
    const rpc = new RpcClient(() => client);
    await expect(rpc.call("nope")).rejects.toMatchObject({ code: "method_not_found" });
    rpc.close();
  });

  it("broadcast → client.on 收到 payload,seq 每 channel 独立递增", async () => {
    const { server, client } = makeLoopbackPair();
    const srv = new RpcServer(server, {});
    const rpc = new RpcClient(() => client);
    // 等连接建立(factory 是同步的,但 state open 在 microtask 后)
    await Promise.resolve();
    const received: Array<{ payload: unknown; seq: number }> = [];
    rpc.on("session:s1", (payload, seq) => received.push({ payload, seq }));
    srv.broadcast("session:s1", { n: 1 }, "s1");
    srv.broadcast("session:s1", { n: 2 }, "s1");
    srv.broadcast("session:other", { n: 99 }, "other"); // 不订阅,不应收到
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([
      { payload: { n: 1 }, seq: 1 },
      { payload: { n: 2 }, seq: 2 },
    ]);
    rpc.close();
  });

  it("close 后在途 call 立即 reject(code=disconnected)", async () => {
    const { server, client } = makeLoopbackPair();
    // handler 永不 resolve
    new RpcServer(server, { hang: () => new Promise(() => {}) });
    const rpc = new RpcClient(() => client);
    await Promise.resolve();
    const p = rpc.call("hang");
    rpc.close();
    await expect(p).rejects.toBeInstanceOf(RpcCallError);
    await expect(p).rejects.toMatchObject({ code: "disconnected" });
  });
});
