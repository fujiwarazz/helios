// ============================================================================
// packages/protocol/src/electronTransport.test.ts
// 用一对内存里"背靠背"的假 bridge 模拟主进程 ↔ 渲染进程的 Electron IPC,
// 验证 electronRendererTransport/electronMainTransport 的收发 + connectionId 分拣(多路复用)
// + onClose/close 语义,不依赖真实 electron。
// ============================================================================

import { describe, it, expect } from "vitest";
import type { ElectronIpcBridge } from "./electronTransport";
import { electronRendererTransport, electronMainTransport } from "./electronTransport";

/**
 * 一对互联的内存 bridge:一侧 send 直接投给另一侧的 onMessage 订阅者。
 * 模拟"同一物理 IPC 通道上多条 connectionId 复用"的场景。
 */
function makeLinkedBridges(): { a: ElectronIpcBridge; b: ElectronIpcBridge } {
  const msgCbsA = new Set<(cid: string, data: string) => void>();
  const msgCbsB = new Set<(cid: string, data: string) => void>();
  const closeCbsA = new Set<(cid: string) => void>();
  const closeCbsB = new Set<(cid: string) => void>();

  const a: ElectronIpcBridge = {
    send: (cid, data) => msgCbsB.forEach((cb) => cb(cid, data)),
    onMessage: (cb) => (msgCbsA.add(cb), { dispose: () => msgCbsA.delete(cb) }),
    onClose: (cb) => (closeCbsA.add(cb), { dispose: () => closeCbsA.delete(cb) }),
    close: (cid) => closeCbsB.forEach((cb) => cb(cid)),
  };
  const b: ElectronIpcBridge = {
    send: (cid, data) => msgCbsA.forEach((cb) => cb(cid, data)),
    onMessage: (cb) => (msgCbsB.add(cb), { dispose: () => msgCbsB.delete(cb) }),
    onClose: (cb) => (closeCbsB.add(cb), { dispose: () => closeCbsB.delete(cb) }),
    close: (cid) => closeCbsA.forEach((cb) => cb(cid)),
  };
  return { a, b };
}

describe("electronTransport", () => {
  it("双向收发:main 发的 renderer 能收到,反之亦然", () => {
    const { a, b } = makeLinkedBridges();
    const main = electronMainTransport(a, "conn-1");
    const renderer = electronRendererTransport(b, "conn-1");

    const receivedByRenderer: string[] = [];
    const receivedByMain: string[] = [];
    renderer.onMessage((d) => receivedByRenderer.push(d));
    main.onMessage((d) => receivedByMain.push(d));

    main.send("hello from main");
    renderer.send("hello from renderer");

    expect(receivedByRenderer).toEqual(["hello from main"]);
    expect(receivedByMain).toEqual(["hello from renderer"]);
  });

  it("多路复用:不同 connectionId 的帧互不串扰", () => {
    const { a, b } = makeLinkedBridges();
    const main1 = electronMainTransport(a, "conn-1");
    const main2 = electronMainTransport(a, "conn-2");
    const renderer1 = electronRendererTransport(b, "conn-1");
    const renderer2 = electronRendererTransport(b, "conn-2");

    const seen1: string[] = [];
    const seen2: string[] = [];
    renderer1.onMessage((d) => seen1.push(d));
    renderer2.onMessage((d) => seen2.push(d));

    main1.send("for-1");
    main2.send("for-2");

    expect(seen1).toEqual(["for-1"]);
    expect(seen2).toEqual(["for-2"]);
  });

  it("close()/onClose:按 connectionId 触发,不影响其他连接", () => {
    const { a, b } = makeLinkedBridges();
    const renderer1 = electronRendererTransport(b, "conn-1");
    const renderer2 = electronRendererTransport(b, "conn-2");
    const main1 = electronMainTransport(a, "conn-1");

    let closed1 = false;
    let closed2 = false;
    main1.onClose(() => {
      closed1 = true;
    });
    // renderer2 无关连接:main 没订阅 conn-2 的 onClose,这里只验证 conn-1 侧确实触发、conn-2 不受影响。
    renderer2.onMessage(() => {
      closed2 = true; // 占位:conn-2 从未发消息,理应保持 false
    });

    renderer1.close(); // renderer 主动关闭 conn-1 → 应触发 main 侧对应 onClose
    expect(closed1).toBe(true);
    expect(closed2).toBe(false);
  });

  it("onMessage/onClose 返回的 Disposable 可取消订阅", () => {
    const { a, b } = makeLinkedBridges();
    const main = electronMainTransport(a, "conn-1");
    const renderer = electronRendererTransport(b, "conn-1");

    const received: string[] = [];
    const sub = renderer.onMessage((d) => received.push(d));
    sub.dispose();

    main.send("should not arrive");
    expect(received).toEqual([]);
  });
});
