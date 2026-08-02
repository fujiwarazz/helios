import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@helios/ports": resolve(__dirname, "packages/ports/src/index.ts"),
      "@helios/kernel": resolve(__dirname, "packages/kernel/src/index.ts"),
      "@helios/fs-node": resolve(__dirname, "packages/fs-node/src/index.ts"),
      "@helios/llm-anthropic": resolve(
        __dirname,
        "packages/llm-anthropic/src/index.ts",
      ),
      "@helios/memory-fs": resolve(__dirname, "packages/memory-fs/src/index.ts"),
      "@helios/checkpoint-fs": resolve(
        __dirname,
        "packages/checkpoint-fs/src/index.ts",
      ),
      "@helios/compact-default": resolve(
        __dirname,
        "packages/compact-default/src/index.ts",
      ),
      "@helios/teams-mailbox": resolve(
        __dirname,
        "packages/teams-mailbox/src/index.ts",
      ),
      "@helios/capability-fs": resolve(
        __dirname,
        "packages/capability-fs/src/index.ts",
      ),
      "@helios/llm-openai": resolve(__dirname, "packages/llm-openai/src/index.ts"),
      "@helios/checkpoint-git": resolve(
        __dirname,
        "packages/checkpoint-git/src/index.ts",
      ),
      "@helios/cap-cron": resolve(__dirname, "packages/cap-cron/src/index.ts"),
      "@helios/cap-mcp": resolve(__dirname, "packages/cap-mcp/src/index.ts"),
      "@helios/cap-lsp": resolve(__dirname, "packages/cap-lsp/src/index.ts"),
      "@helios/protocol/browser": resolve(
        __dirname,
        "packages/protocol/src/browser.ts",
      ),
      "@helios/protocol": resolve(__dirname, "packages/protocol/src/index.ts"),
      "@helios/ui-chat": resolve(__dirname, "packages/ui-chat/src/index.ts"),
      "@helios/host": resolve(__dirname, "packages/host/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.{ts,tsx}", "apps/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
