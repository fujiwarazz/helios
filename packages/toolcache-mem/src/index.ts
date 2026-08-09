import type {
  ToolResultCachePort,
  ToolCacheKey,
  ToolResult,
  KernelContext,
} from "@helios/ports";
import { TOOL_RESULT_CACHE_PORT_API_VERSION } from "@helios/ports";

// @helios/toolcache-mem —— ToolResultCachePort 官方实现：内存 Map + TTL。
// key 由 scope+scopeId+version 唯一确定：workspace 被 Edit 后 version 变 → 自然 miss（比 TTL 更准）。

interface Entry {
  result: ToolResult;
  expiresAt?: number; // undefined = 不过期
}

/** key 序列化：version 参与，确保版本变化即视为不同条目。 */
function serialize(key: ToolCacheKey): string {
  return JSON.stringify([key.scope, key.scopeId, key.toolName, key.argsCanonical, key.version ?? ""]);
}

class MemToolCache implements ToolResultCachePort {
  // TODO(eviction): store 只在 get 时惰性清理过期项；global/session 无 TTL 的条目永不驱逐。
  // 长生命周期宿主需加 LRU 或全局上限。MVP 增长缓慢，暂不处理。
  private readonly store = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: ToolCacheKey): Promise<ToolResult | undefined> {
    const k = serialize(key);
    const entry = this.store.get(k);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && this.now() >= entry.expiresAt) {
      this.store.delete(k); // 过期清理
      return undefined;
    }
    return entry.result;
  }

  async set(key: ToolCacheKey, result: ToolResult, ttlMs?: number): Promise<void> {
    this.store.set(serialize(key), {
      result,
      expiresAt: ttlMs && ttlMs > 0 ? this.now() + ttlMs : undefined,
    });
  }
}

export const apiVersion = TOOL_RESULT_CACHE_PORT_API_VERSION;

export function create(_ctx: KernelContext): ToolResultCachePort {
  return new MemToolCache();
}

export default { apiVersion, create };
