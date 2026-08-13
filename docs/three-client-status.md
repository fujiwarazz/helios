# 三端整合状态（Workspace Platform + protocol + ui-chat + host）

目标：把内核（kernel/Session）从"只能同进程被 CLI 调用"推进到"可被跨进程/跨机器前端消费"，并跑通一条浏览器端到端链路。

## 已建成

| 包 | 职责 | 状态 |
|---|---|---|
| `@helios/protocol` | 领域无关的极简 JSON-RPC（envelope 编解码 + 请求-响应配对 + 事件多路复用 + 断线重连）+ 可替换 Transport 抽象 + WebSocket 传输 | ✅ 完成 |
| `@helios/ui-chat` | 极简 React 对话渲染库（消息流 + 工具卡片 + 输入框 + 连接状态条）+ `IChatClient` 契约 + `RpcChatClient` | ✅ 完成 |
| `@helios/host` | Kernel Session ↔ protocol RpcServer 的领域适配层（`bindSession` + `serveKernelOverWs` + `serveKernelOverElectronIpc`），对应 valos Electron 的 RemoteControlServer | ✅ 完成 |
| `@helios/workspace` | 三端共用的 Workspace Catalog、本地导入/Git Clone、direct/worktree 物化、Session binding、Memory、EditRecord 和 Runtime Registry | ✅ 首期单仓完成 |
| `apps/web` | 浏览器客户端（Vite+React）+ Node WS 宿主 runner（`server/host.ts`），对应 valos-web | ✅ 完成 |
| `apps/electron` | Electron 桌面客户端：主进程内直连起 Kernel + `serveKernelOverElectronIpc`，渲染进程走 `@helios/protocol` 的 `ElectronIpcBridge`，对应 valos-view（Electron 渲染层） | ✅ 完成（简化版：单窗口，不含打包/自动更新） |
| `apps/cli` | Workspace flags、旧会话迁移、恢复 binding 和同进程 Runtime | ✅ 完成 |

## Chat/Code 产品状态

- Electron/Web 默认 Chat；`HELIOS_CODE_MODE=1` 后可在主页面切换 Code，Sidebar 保持一致。
- Electron 通过原生目录选择器授权本地目录，Renderer 只得到 `WorkspaceSummary`，不获得或提交真实路径。
- Web 本地目录受 `HELIOS_WORKSPACE_ROOTS` allowlist 限制，Host 强制 loopback；Git Clone 始终在 Host 执行。
- CLI 支持 `--code`、`--clone`、`--workspace`、`--worktree`、`--resume` 和 `--legacy-workdir`。
- `direct` 是默认行为且会真实修改原仓库；Git `worktree` 使用独立 `helios/<materializationId>` 分支。
- 首发后 binding 锁定；Workspace Platform 的 rollback 固定为 conversation-only。
- Write/Edit 有逐文件 EditRecord；direct run 通过前后 fingerprint 检测 Helios 外部修改并写入 audit gap。Workspace Runtime 当前禁用 Bash，待补齐 Sandbox confinement 与外部进程审计后再开放。

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

## 端到端跑法（apps/web，需真实模型配置）

1. 起本地模型网关（`127.0.0.1:8788`，见根 `helios.config.json` 的 `llm-anthropic`）。
2. `HELIOS_CODE_MODE=1 HELIOS_WORKSPACE_ROOTS=<allowed-root> pnpm -C <helios> --filter @helios/web dev`。
3. 浏览器打开 Vite 输出的地址；页面默认 Chat，切换 Code 后可选择 Host allowlist 内目录或 Git Clone。

## 端到端跑法（apps/electron，需真实模型配置）

1. 起本地模型网关（同上，见根 `helios.config.json`）。
2. `HELIOS_CODE_MODE=1 pnpm -C <helios> --filter @helios/electron dev`（先构建受限 preload，再并行启动 Vite 与 Electron；主进程内运行 Workspace Host，不监听端口）。
3. 窗口默认 Chat；切换 Code 后通过原生目录选择器或 Git Clone 选择仓库。

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
