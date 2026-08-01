// ============================================================================
// packages/protocol/src/wsTransport.ts
// Node 侧 barrel:同时导出 node 与 browser 传输(node 环境可全用)。
// ⚠️ 引用本文件即拉入 `ws`(Node 库);浏览器入口请用 ./browser(只含 browser 传输)。
// ============================================================================

export { nodeWsServerTransport, nodeWsClientTransport } from "./nodeWsTransport";
export { browserWsClientTransport } from "./browserWsTransport";
