import { StrictMode } from "react";
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

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
