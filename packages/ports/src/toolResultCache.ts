// ToolResultCachePort —— 包在工具执行外：hash(toolName + 规范化args + scope + version) 命中直接返回。
// 只对 cacheable:true 的工具生效。见 docs/cost-optimization-layer.md 四。
import type { ToolResult } from "./types";

export const TOOL_RESULT_CACHE_PORT_API_VERSION = 1;

export interface ToolCacheKey {
  toolName: string;
  argsCanonical: string; // 稳定排序 JSON
  scope: "run" | "session" | "global"; // 复用范围
  scopeId: string; // run→runId / session→sessionId / global→固定
  /** VersionProvider 按 cacheVersionKind 注入，如 workspace snapshot hash / url rev / index ver。 */
  version?: string;
}

export interface ToolResultCachePort {
  get(key: ToolCacheKey): Promise<ToolResult | undefined>;
  set(key: ToolCacheKey, result: ToolResult, ttlMs?: number): Promise<void>;
}
