import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// 代码高亮主题由 @helios/ui-chat 的 Markdown 组件自带引入(highlight.js 是其直接依赖)。
import "./styles/theme.css";
import "./styles/chat.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root 挂载点");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
