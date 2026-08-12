// @helios/protocol —— 领域无关的极简 JSON-RPC + 可替换传输。
// 协议核心(envelope/transport)是契约;RpcServer/RpcClient 是实现;
// wsTransport 是本期唯一落地的传输(WebSocket)。

export * from "./envelope";
export * from "./transport";
export { RpcServer } from "./server";
export type { RpcHandler } from "./server";
export { RpcClient, RpcCallError } from "./client";
export type { ConnectionState, RpcClientOptions } from "./client";
export {
  nodeWsServerTransport,
  nodeWsClientTransport,
  browserWsClientTransport,
} from "./wsTransport";
export {
  electronRendererTransport,
  electronMainTransport,
} from "./electronTransport";
export type { ElectronIpcBridge } from "./electronTransport";
