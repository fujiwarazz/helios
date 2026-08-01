// ============================================================================
// packages/protocol/src/transport.ts
// 传输抽象 —— 协议底下一个可替换的"管子"。协议本体(server/client)只依赖此接口,
// 不认识 WebSocket / IPC / 进程内直连。本期只实现 WebSocketTransport;
// ElectronIpcTransport / InProcessTransport 作为预留(docs 说明,不实现)。
//
// 契约稳定性:此接口被 server/client 和所有 transport 实现共同依赖,尽量最小、稳定。
// ============================================================================

import type { Disposable } from "@helios/ports";

/**
 * 一条双向、面向消息的字符串管道。
 * "面向消息"= 每次 send 的字符串,对端 onMessage 完整收到一次(不拆包/粘包)。
 * WebSocket 天然满足;若未来某传输是字节流(如裸 TCP),需在其 transport 实现内做分帧。
 */
export interface Transport {
  /** 发送一帧(已由协议层 encode 成字符串)。连接未就绪时的处理由实现决定(缓冲或抛错)。 */
  send(data: string): void;
  /** 订阅收到的每一帧。返回 Disposable 用于取消订阅。 */
  onMessage(cb: (data: string) => void): Disposable;
  /**
   * 订阅连接关闭(对端断开或网络中断)。
   * client 依赖它触发重连;host 侧胶水依赖它解绑 session 订阅(避免泄漏/重复广播)。
   * —— 对应审查意见第 2 点(连接生命周期要可感知,供对称清理)。
   */
  onClose(cb: () => void): Disposable;
  /** 主动关闭。关闭后不应再触发 onMessage;是否触发 onClose 由实现决定(建议触发一次)。 */
  close(): void;
}

/**
 * 传输工厂 —— 供 client 重连时重建一个全新 Transport。
 * (Transport 本身是一次性的:断开即废弃,重连 = 用 factory 造一个新的。)
 */
export type TransportFactory = () => Transport | Promise<Transport>;
