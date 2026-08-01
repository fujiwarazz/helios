// @helios/protocol/browser —— 浏览器安全入口。
// 只含协议核心(envelope/transport/RpcClient/RpcServer,均无 `ws` 依赖)+ 浏览器 WS 传输。
// 绝不 import node 传输(nodeWsTransport.ts),故不会把 `ws` 打进浏览器 bundle。

export * from "./envelope";
export * from "./transport";
export { RpcServer } from "./server";
export type { RpcHandler } from "./server";
export { RpcClient, RpcCallError } from "./client";
export type { ConnectionState, RpcClientOptions } from "./client";
export { browserWsClientTransport } from "./browserWsTransport";
