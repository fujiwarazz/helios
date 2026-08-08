// ============================================================================
// packages/ui-chat/src/RpcChatClient.ts
// 用 @helios/protocol 的 RpcClient 实现 IChatClient(跨进程宿主用)。
// 连上后 call("sessionId") 解析 id → on(`session:<id>`) 转 onEvent。
// ============================================================================

import type { AgentEvent } from "@helios/kernel";
import type { Message } from "@helios/ports";
import { RpcClient } from "@helios/protocol/browser";
import type { ConnectionState } from "@helios/protocol/browser";
import type { IChatClient, AskQuestion } from "./types";

export class RpcChatClient implements IChatClient {
  /** 缓存 sessionId 的 Promise,避免重复 call。 */
  private sessionIdPromise: Promise<string> | undefined;

  constructor(private readonly rpc: RpcClient) {}

  private sessionId(): Promise<string> {
    if (!this.sessionIdPromise) {
      this.sessionIdPromise = this.rpc.call("sessionId").then((v) => v as string);
    }
    return this.sessionIdPromise;
  }

  async getHistory(): Promise<Message[]> {
    return (await this.rpc.call("history")) as Message[];
  }

  async sendMessage(text: string): Promise<void> {
    await this.rpc.call("sendMessage", { text });
  }

  onEvent(cb: (e: AgentEvent) => void): () => void {
    // 订阅需要 sessionId;在解析出来前先缓存,解析完再真正订阅。
    let disposed = false;
    let dispose: (() => void) | undefined;
    void this.sessionId().then((id) => {
      if (disposed) return;
      const sub = this.rpc.on(`session:${id}`, (payload) => cb(payload as AgentEvent));
      dispose = sub.dispose;
    });
    return () => {
      disposed = true;
      dispose?.();
    };
  }

  onState(cb: (s: ConnectionState) => void): () => void {
    const sub = this.rpc.onState(cb);
    return () => sub.dispose();
  }

  async rollback(turnId: string): Promise<void> {
    await this.rpc.call("rollback", { turnId });
  }

  async cancel(): Promise<void> {
    await this.rpc.call("cancel");
  }

  onAsk(cb: (q: AskQuestion) => void): () => void {
    // 与 onEvent 同构:订阅 ask:<sessionId> 频道,收到审批提问转给回调。
    let disposed = false;
    let dispose: (() => void) | undefined;
    void this.sessionId().then((id) => {
      if (disposed) return;
      const sub = this.rpc.on(`ask:${id}`, (payload) => cb(payload as AskQuestion));
      dispose = sub.dispose;
    });
    return () => {
      disposed = true;
      dispose?.();
    };
  }

  async answer(questionId: string, answers: string[]): Promise<void> {
    await this.rpc.call("answerQuestion", { questionId, answers });
  }
}
