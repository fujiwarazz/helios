// ============================================================================
// packages/protocol/src/server.ts
// RpcServer —— 领域无关的请求派发 + 事件广播。不认识 Session。
// 收到 req → 查 handler → 回 res(handler 抛错 / decode 抛错都归一化成 res.error)。
// broadcast(channel, payload, sessionId?) 发 evt 帧,内部为每个 channel 维护独立 seq。
// ============================================================================

import type { Transport } from "./transport";
import type { RpcError } from "./envelope";
import { decode, encode } from "./envelope";

/** 一个方法处理器:入参 params(未知类型,handler 自行断言),返回结果(可 async)。 */
export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

function toRpcError(err: unknown): RpcError {
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

export class RpcServer {
  /** 每个 channel 独立的事件序号计数器,从 1 递增。 */
  private readonly seqByChannel = new Map<string, number>();
  private readonly disposeMessage: () => void;

  constructor(
    private readonly transport: Transport,
    private readonly handlers: Record<string, RpcHandler>,
  ) {
    const sub = this.transport.onMessage((data) => {
      void this.onData(data);
    });
    this.disposeMessage = sub.dispose;
  }

  private async onData(data: string): Promise<void> {
    // 坏帧:无法定位 req.id,只能忽略(不能回一个没有 id 的 res)。
    let id: number | undefined;
    try {
      const env = decode(data);
      if (env.kind !== "req") return; // server 只处理 req
      id = env.id;
      const handler = this.handlers[env.method];
      if (!handler) {
        this.reply(id, undefined, {
          message: `未知方法: ${env.method}`,
          code: "method_not_found",
        });
        return;
      }
      const result = await handler(env.params);
      this.reply(id, result, undefined);
    } catch (err) {
      if (id !== undefined) this.reply(id, undefined, toRpcError(err));
    }
  }

  private reply(id: number, result: unknown, error: RpcError | undefined): void {
    this.transport.send(encode({ kind: "res", id, result, error }));
  }

  /** 向某个 channel 推送事件;seq 由 server 内部按 channel 递增填入。 */
  broadcast(channel: string, payload: unknown, sessionId?: string): void {
    const seq = (this.seqByChannel.get(channel) ?? 0) + 1;
    this.seqByChannel.set(channel, seq);
    this.transport.send(encode({ kind: "evt", channel, sessionId, seq, payload }));
  }

  /** 停止监听(不主动关闭 transport,连接生命周期归 host)。 */
  dispose(): void {
    this.disposeMessage();
  }
}
