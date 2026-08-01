// ============================================================================
// packages/protocol/src/envelope.ts
// 协议帧类型 + 编解码。领域无关(不认识 Session/AgentEvent)。纯函数,易单测。
//
// ⚠️ 契约稳定性:本文件的帧字段一旦有客户端/服务端实现依赖,增删改即破坏性变更。
// 因此在 v1 就为"事件重放"和"多会话路由"预留字段(seq / sessionId),
// 现在加是 0 成本(多两个字段),将来加是破坏性变更(需改所有已发布 client)。
// —— 对应审查意见第 1 点。
// ============================================================================

/** 协议版本。major 变更 = 破坏性;客户端连接时可在握手 method 里比对(本期不强制)。 */
export const PROTOCOL_VERSION = 1;

/** 请求帧:客户端 → 服务端调用一个方法。 */
export interface RpcRequest {
  kind: "req";
  /** 客户端自增,用于把 res 关联回 pending 的 call。 */
  id: number;
  method: string;
  params?: unknown;
}

/** 响应帧:服务端 → 客户端返回某个 req 的结果或错误。 */
export interface RpcResponse {
  kind: "res";
  /** 对应 RpcRequest.id。 */
  id: number;
  result?: unknown;
  /** 与 result 互斥;error 归一化为 { message, code? }。 */
  error?: RpcError;
}

/** 事件帧:服务端 → 客户端单向推送(不需要 client 应答)。 */
export interface RpcEvent {
  kind: "evt";
  /**
   * 逻辑频道。领域无关,由上层约定命名。
   * 约定:会话事件用 `session:<sessionId>` 形态,便于一条连接多会话路由。
   * (本期 host 侧只绑一个 session,但 channel 里带 id,将来多会话无需改协议。)
   */
  channel: string;
  /**
   * 该事件所属会话 id。与 channel 冗余是有意的:
   * channel 供订阅路由,sessionId 供 client 无需解析 channel 字符串即可分拣。
   * 单会话场景下 host 可填当前 session.id。
   */
  sessionId?: string;
  /**
   * 单调递增序号(每个 channel 独立计数,从 1 开始)。
   * 本期仅透传、不做重放;但有了 seq,将来重连后 client 能声明"我已收到 seq≤N",
   * server 决定是否补发缺失事件 —— 届时不必改帧格式。
   * —— 对应审查意见第 1 点(断连丢事件的未来解法预留)。
   */
  seq: number;
  payload: unknown;
}

export interface RpcError {
  message: string;
  /** 可选错误码,供 client 分类处理(如 "timeout" / "method_not_found")。 */
  code?: string;
}

export type Envelope = RpcRequest | RpcResponse | RpcEvent;

/** 编码为传输字符串(当前 JSON;传输层只搬字符串,不关心格式)。 */
export function encode(env: Envelope): string {
  return JSON.stringify(env);
}

/**
 * 解码。非法 JSON 或 kind 不识别 → 抛错,由调用方(server/client)决定如何归一化处理,
 * 不在此静默吞掉(避免"坏帧被当成合法帧"的隐蔽 bug)。
 */
export function decode(s: string): Envelope {
  const obj = JSON.parse(s) as { kind?: unknown };
  if (obj.kind !== "req" && obj.kind !== "res" && obj.kind !== "evt") {
    throw new Error(`未知协议帧 kind: ${String(obj.kind)}`);
  }
  return obj as Envelope;
}
