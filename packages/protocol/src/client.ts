// ============================================================================
// packages/protocol/src/client.ts
// RpcClient —— 请求-响应配对 + 事件多路复用 + 断线重连。领域无关。
//   call(method, params, {timeoutMs}) : 自增 id + pending map,超时/断连 reject。
//   on(channel, cb)                   : 订阅某 channel 的 evt(重连后回调表不清空,持续有效)。
//   onState(cb)                       : 暴露 connecting|open|closed。
//   close()                           : 主动关闭,不再重连。
// ============================================================================

import type { Disposable } from "@helios/ports";
import type { Transport, TransportFactory } from "./transport";
import { decode, encode } from "./envelope";

export type ConnectionState = "connecting" | "open" | "closed";

export interface RpcClientOptions {
  /** 单次 call 默认超时(ms)。 */
  defaultTimeoutMs?: number;
  /** 断线重连最大次数。 */
  maxReconnects?: number;
  /** 重连间隔(ms)。 */
  reconnectDelayMs?: number;
}

/** call 失败时抛出,带 code 供上层分类("timeout" / "disconnected" / server 返回的 code)。 */
export class RpcCallError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RpcCallError";
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: RpcCallError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class RpcClient {
  private transport: Transport | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly channelSubs = new Map<string, Set<(payload: unknown, seq: number) => void>>();
  private readonly stateSubs = new Set<(s: ConnectionState) => void>();
  private state: ConnectionState = "connecting";
  private closed = false;
  private reconnectCount = 0;
  private readonly openWaiters: Array<{
    resolve: (t: Transport) => void;
    reject: (e: RpcCallError) => void;
  }> = [];
  private readonly defaultTimeoutMs: number;
  private readonly maxReconnects: number;
  private readonly reconnectDelayMs: number;
  private disposeTransport: (() => void) | undefined;

  constructor(
    private readonly factory: TransportFactory,
    opts: RpcClientOptions = {},
  ) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.maxReconnects = opts.maxReconnects ?? 5;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 2_000;
    void this.connect();
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    for (const cb of this.stateSubs) cb(s);
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.setState("connecting");
    let transport: Transport;
    try {
      transport = await this.factory();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.closed) {
      transport.close();
      return;
    }
    this.transport = transport;
    this.reconnectCount = 0;
    const msgSub = transport.onMessage((data) => this.onData(data));
    const closeSub = transport.onClose(() => this.onClose());
    this.disposeTransport = () => {
      msgSub.dispose();
      closeSub.dispose();
    };
    this.setState("open");
    // 唤醒等待连接就绪的 call。
    const waiters = this.openWaiters.splice(0);
    for (const w of waiters) w.resolve(transport);
  }

  /** 等待连接就绪(返回可用 transport);已关闭 / 重连耗尽则 reject。 */
  private whenOpen(): Promise<Transport> {
    if (this.transport) return Promise.resolve(this.transport);
    if (this.closed || this.state === "closed") {
      return Promise.reject(new RpcCallError("连接已关闭", "disconnected"));
    }
    return new Promise<Transport>((resolve, reject) => {
      this.openWaiters.push({ resolve, reject });
    });
  }

  private rejectOpenWaiters(code: string, message: string): void {
    const waiters = this.openWaiters.splice(0);
    for (const w of waiters) w.reject(new RpcCallError(message, code));
  }

  private onClose(): void {
    this.transport = undefined;
    this.disposeTransport?.();
    this.disposeTransport = undefined;
    // 断连:所有在途 call 立即 reject。
    this.rejectAllPending("disconnected", "连接已断开");
    if (this.closed) {
      this.setState("closed");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectCount >= this.maxReconnects) {
      this.setState("closed");
      this.rejectOpenWaiters("disconnected", "重连已耗尽");
      return;
    }
    this.reconnectCount += 1;
    this.setState("connecting");
    setTimeout(() => void this.connect(), this.reconnectDelayMs);
  }

  private rejectAllPending(code: string, message: string): void {
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcCallError(message, code));
      this.pending.delete(id);
    }
  }

  private onData(data: string): void {
    let env;
    try {
      env = decode(data);
    } catch {
      return; // 坏帧忽略
    }
    if (env.kind === "res") {
      const p = this.pending.get(env.id);
      if (!p) return;
      this.pending.delete(env.id);
      if (p.timer) clearTimeout(p.timer);
      if (env.error) p.reject(new RpcCallError(env.error.message, env.error.code));
      else p.resolve(env.result);
    } else if (env.kind === "evt") {
      const subs = this.channelSubs.get(env.channel);
      if (!subs) return;
      for (const cb of subs) cb(env.payload, env.seq);
    }
  }

  /** 调用一个远端方法。 */
  async call(
    method: string,
    params?: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const transport = await this.whenOpen();
    // 等待期间可能已被 close/断连(await 引入的时间窗)。
    if (this.closed || !this.transport) {
      throw new RpcCallError("连接已关闭", "disconnected");
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new RpcCallError(`调用超时: ${method}`, "timeout"));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        transport.send(encode({ kind: "req", id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new RpcCallError(err instanceof Error ? err.message : String(err), "send_failed"));
      }
    });
  }

  /** 订阅某 channel 的事件。重连后回调表保留,订阅持续有效。 */
  on(channel: string, cb: (payload: unknown, seq: number) => void): Disposable {
    let set = this.channelSubs.get(channel);
    if (!set) {
      set = new Set();
      this.channelSubs.set(channel, set);
    }
    set.add(cb);
    return {
      dispose: () => {
        set?.delete(cb);
        if (set && set.size === 0) this.channelSubs.delete(channel);
      },
    };
  }

  /** 订阅连接状态变化。 */
  onState(cb: (s: ConnectionState) => void): Disposable {
    this.stateSubs.add(cb);
    return { dispose: () => this.stateSubs.delete(cb) };
  }

  /** 当前连接状态。 */
  get connectionState(): ConnectionState {
    return this.state;
  }

  /** 主动关闭,不再重连。 */
  close(): void {
    this.closed = true;
    this.rejectAllPending("disconnected", "客户端已关闭");
    this.rejectOpenWaiters("disconnected", "客户端已关闭");
    this.disposeTransport?.();
    this.disposeTransport = undefined;
    this.transport?.close();
    this.transport = undefined;
    this.setState("closed");
  }
}
