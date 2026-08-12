import { createRoot } from "react-dom/client";
import { App } from "./App";
// theme.css(设计 token)+ chat.css(ChatView 自身样式)单一源头在 @helios/ui-chat,
// 两端(web/electron)共用同一份,不各自维护一份色板/工具卡片样式。
import "@helios/ui-chat/theme.css";
import "@helios/ui-chat/chat.css";
// shell.css:electron 端专属外壳样式(侧边栏/导航/会话列表/占位页),不随 ui-chat 共享。
import "./styles/shell.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root 挂载点");

// ⚠️ 不用 <StrictMode>:App.tsx 里建立连接的 effect 会 new RpcClient(...),其构造函数同步
// 触发真实副作用(IPC connect + 后端 session resume)。StrictMode dev 模式下"挂载→清理→
// 再挂载"的双调用会导致同一 session 被 resume 两次(实测复现:同一 sessionId 打印两条
// resume 日志),且两个 RpcClient 短暂并存期间,Sidebar/ChatView 两处独立的 connection
// 状态订阅可能锁定到不同实例上,出现"已连接"与"连接已断开"同屏矛盾的界面表现。
// RpcClient 的连接生命周期目前是"构造即连接",不是可安全重复调用的惰性资源,在这层做好
// cancel 语义前不引入 StrictMode。
createRoot(root).render(<App />);
