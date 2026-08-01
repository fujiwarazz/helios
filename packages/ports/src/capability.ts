import type { KernelContext, Tool, HookBinding } from "./types";
import type { ToolRenderer } from "./renderer";

export const CAPABILITY_PROVIDER_API_VERSION = 1;

/**
 * 所有可插拔模块的公共基座。Skill / Extension / LSP / MCP / Cron 全部是它的实现。
 * 降级：一个都不加载 → kernel 只剩六件套内建工具，对话照常。
 */
export interface CapabilityProvider {
  /** provider 命名空间前缀，如 'lsp' / 'mcp:filesystem'（六件套内建例外，不加前缀） */
  readonly name: string;
  activate(ctx: KernelContext): void | Promise<void>;
  getTools?(): Tool[];
  getHookHandlers?(): HookBinding[];
  getRenderers?(): ToolRenderer[];
  dispose?(): void | Promise<void>;
}
