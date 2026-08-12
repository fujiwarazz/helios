# 三端整合状态（protocol + ui-chat + host + web）

目标：把内核（kernel/Session）从"只能同进程被 CLI 调用"推进到"可被跨进程/跨机器前端消费"，并跑通一条浏览器端到端链路。

## 已建成

| 包 | 职责 | 状态 |
|---|---|---|
| `@helios/protocol` | 领域无关的极简 JSON-RPC（envelope 编解码 + 请求-响应配对 + 事件多路复用 + 断线重连）+ 可替换 Transport 抽象 + WebSocket 传输 | ✅ 完成 |
| `@helios/ui-chat` | 极简 React 对话渲染库（消息流 + 工具卡片 + 输入框 + 连接状态条）+ `IChatClient` 契约 + `RpcChatClient` | ✅ 完成 |
| `@helios/host` | Kernel Session ↔ protocol RpcServer 的领域适配层（`bindSession` + `serveKernelOverWs` + `serveKernelOverElectronIpc`），对应 valos Electron 的 RemoteControlServer | ✅ 完成 |
| `apps/web` | 浏览器客户端（Vite+React）+ Node WS 宿主 runner（`server/host.ts`），对应 valos-web | ✅ 完成 |
| `apps/electron` | Electron 桌面客户端：主进程内直连起 Kernel + `serveKernelOverElectronIpc`，渲染进程走 `@helios/protocol` 的 `ElectronIpcBridge`，对应 valos-view（Electron 渲染层） | ✅ 完成（简化版：单窗口，不含打包/自动更新） |

### 浏览器安全入口（node/browser 传输隔离）

`@helios/protocol` 的 node 传输依赖 `ws`，不能进浏览器 bundle。因此传输按环境物理拆分（对应 valos "ISocket 按环境替换"）：
- `nodeWsTransport.ts`（import `ws`）+ `browserWsTransport.ts`（零 import，用全局 `WebSocket`）。
- 入口：`@helios/protocol`（`.` node 全量）/ `@helios/protocol/browser`（只含协议核心 + 浏览器传输，**绝不引 `ws`**）。
- 浏览器侧（ui-chat `RpcChatClient` / apps/web）一律 import `@helios/protocol/browser`。`vite build` 通过 + bundle 内零 `ws` 引用即证明隔离生效。

### 协议 / 传输分层

- **协议**（`envelope.ts` / `server.ts` / `client.ts`）只认三种帧 `req` / `res` / `evt`，不认识 Session/AgentEvent。
- **传输**（`transport.ts`）是协议底下一个可替换抽象：`send / onMessage / onClose / close`。协议不关心底层是 WS、IPC 还是内存管道。

## 传输矩阵

| 传输 | 用途 | 状态 |
|---|---|---|
| `nodeWsServerTransport(ws)` | 服务端把已 accept 的连接包成 Transport | ✅ 本期 |
| `nodeWsClientTransport(url)` | node 宿主 / 测试客户端 | ✅ 本期 |
| `browserWsClientTransport(url)` | 浏览器宿主客户端 | ✅ 本期 |
| `ElectronIpcTransport` | electron main ↔ renderer（把 `ipcRenderer`/`ipcMain` 包成 Transport） | ✅ 本期（`electronRendererTransport`/`electronMainTransport`，共享同一份 `ElectronIpcBridge` 包装逻辑；按 connectionId 多路复用；不 import `electron`，结构化接口，真实 ipcMain/webContents 接线留在 `apps/electron`） |
| `InProcessTransport` | cli 同进程（连 WS 都不用，直接内存双向管道） | ⏳ 未做 |

新增一个传输只需实现 `Transport` 接口，协议 / RpcServer / RpcClient / ui-chat 全部零改动。

## Session ↔ RPC 胶水（已落地为 `@helios/host`）

协议本体不含"Session 绑定"（保持通用）。这段领域胶水现已抽成可复用的 `@helios/host`（`bindSession` +
`serveKernelOverWs` + `serveKernelOverElectronIpc`），apps/web 与 apps/electron 两个宿主共用同一份
`bindSession`（连接受理方式不同，绑定逻辑零改动）：

```ts
// @helios/host: bindSession —— 每个连接绑一个 Session
const server = new RpcServer(transport, {
  sessionId:   () => session.id,                         // client 据此订阅 session:<id>
  history:     () => session.getHistory(),
  sendMessage: (p) => session.sendMessage((p as { text: string }).text),
  rollback:    (p) => session.rollback((p as { turnId: string }).turnId),
});
const unbind = session.on((e) => server.broadcast(`session:${session.id}`, e, session.id));
transport.onClose(() => unbind());  // 断开必须解绑,否则重连累积监听 → 事件重复广播
```

客户端侧用 `RpcChatClient(rpcClient)` 实现 `IChatClient`，直接喂给 `<ChatView client={...} />`。

### 工具卡片渲染:接上已有的 `ToolRenderer` 注册表

`@helios/ports` 早就定义了 `ToolRenderer{toolName, render()}` + `CapabilityProvider.getRenderers?()`，
`kernel.getRenderer(name)` 也早就把它们收进注册表，但一直没人调用。`bindSession` 现在在广播
`tool_execution_end` 事件前，用一个连接级 `toolUseId → name` 映射查出工具名，命中 `kernel.getRenderer`
就把算好的 `ToolRenderDescriptor` 附到事件的 `descriptor` 字段上随事件下发。两端 UI（`@helios/ui-chat`
的 `useChat`）优先用事件自带的 `descriptor`，未命中才落回本地通用兜底——新增一个工具的专属渲染
样式，只需在其 `CapabilityProvider.getRenderers()` 里注册，`apps/web`/`apps/electron` 零改动同步生效。

## 端到端跑法（apps/web，需真实本地模型网关）

1. 起本地模型网关（`127.0.0.1:8788`，见根 `helios.config.json` 的 `llm-anthropic`）。
2. `pnpm -C <helios> --filter @helios/web host`（Node WS 宿主，默认 8787；可 `HELIOS_WEB_PORT` 覆盖）。
3. `pnpm -C <helios> --filter @helios/web dev`（Vite，:5173）。
4. 浏览器开 `http://localhost:5173/?ws=ws://localhost:8787` → 对话；断开宿主 → 顶部状态条"已断开"，恢复自动重连。

## 端到端跑法（apps/electron，需真实本地模型网关）

1. 起本地模型网关（同上，见根 `helios.config.json`）。
2. `pnpm -C <helios> --filter @helios/electron dev`（先 esbuild 出 `dist-electron/main.js`+`preload.cjs`，
   再并行起 Vite（:5174）+ `electron .`；主进程内直连起 Kernel，不监听端口，不经 WebSocket）。
3. 窗口内直接对话；侧边栏/工具卡片/流式渲染与 web 端行为一致（共用同一份 `@helios/ui-chat`）。

## ui-chat 待补清单（本期极简，不追求样式打磨）

- 虚拟列表（长会话性能）
- 历史分页 / 懒加载（上滑加载更早消息）
- 主题 token（暗色 / 亮色）
- 审批卡片交互深度（AskQuestion 选项、工具审批 UI）
- 多会话切换（当前一个 client 绑一个 session）
- markdown / 代码块渲染（当前纯文本）

## 已知 gap（契约已留位、实现本期不做）

- **断连期间服务端 evt 丢失**：`RpcEvent.seq` 已按 channel 递增落位。将来 client 重连后声明"已收 seq≤N"，server 决定是否补发缺失事件 —— 届时不必改帧格式。本期重连后不补发。
- **多会话路由**：`channel = session:<id>` + `RpcEvent.sessionId` 已留位。本期 host 侧只绑 1 个 session；将来一条连接多会话无需改协议。

## 下一步

1. 视需要补全 ui-chat 待补清单里的能力（审批 UI、虚拟列表、历史分页等）。
2. `apps/web` 可选增强：连接 URL 交互输入、多会话切换、断连补发（seq 已留位）。
3. **多后端扩展位（Local/SSH 远程/云主机，本期只做 Local，不实现）**：`serveKernelOverWs` 已经是
   "在任意 Node 进程里起一个 WS 宿主"的通用胶水（`apps/web/server/host.ts` 就是证明）。未来要支持
   "远程 SSH 主机"后端，只需在远程主机上跑同一个 `serveKernelOverWs`（现成代码），`apps/electron`
   渲染进程侧新增一种 `createTransport`（连远程 WS 而非本机 Electron IPC）即可——`ui-chat`/`kernel`/
   `bindSession` 全部不用动，甚至壳层（`App.tsx`/`Sidebar`）也不用动，只改壳层里构造 transport
   的那一行。`Transport` 接口 + `bindSession` 解耦已经把这个位置留好了。
