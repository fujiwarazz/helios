import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// 与 apps/web/vite.config.ts 同样的别名策略(alias 用精确匹配,subpath 单独配,避免
// "@helios/ui-chat/theme.css" 被前缀匹配吃掉后错误拼接路径)。渲染进程端口用 5174,
// 避免与 apps/web 的 5173 冲突(两个 app 可能同时开着对照调试)。
export default defineConfig({
  root: __dirname,
  server: { port: 5174, strictPort: true },
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@helios\/ui-chat$/, replacement: resolve(__dirname, "../../packages/ui-chat/src/index.ts") },
      { find: "@helios/ui-chat/theme.css", replacement: resolve(__dirname, "../../packages/ui-chat/src/styles/theme.css") },
      { find: "@helios/ui-chat/chat.css", replacement: resolve(__dirname, "../../packages/ui-chat/src/styles/chat.css") },
      { find: /^@helios\/protocol\/browser$/, replacement: resolve(__dirname, "../../packages/protocol/src/browser.ts") },
    ],
  },
});
