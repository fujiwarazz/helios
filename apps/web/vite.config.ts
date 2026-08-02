import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// 别名把 @helios 包指向源码(TS),由 esbuild 直接转译。
// ⚠️ 只走浏览器安全入口 @helios/protocol/browser,绝不引 @helios/protocol(会拉入 `ws`)。
// ui-chat 对 @helios/kernel、@helios/ports 全是 `import type`,esbuild 剥离,不入 bundle。
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      "@helios/ui-chat": resolve(__dirname, "../../packages/ui-chat/src/index.ts"),
      "@helios/protocol/browser": resolve(
        __dirname,
        "../../packages/protocol/src/browser.ts",
      ),
    },
  },
});
