// VersionProviderPort —— runtime 按 kind 提供缓存版本串，使 Tool Port 不必知道 workspace。
// Read/Grep/Glob→workspace snapshot；WebFetch→url revision；search→index 版本。
// 见 docs/cost-optimization-layer.md §1.2。
export const VERSION_PROVIDER_PORT_API_VERSION = 1;

export type VersionKind = "workspace" | "url" | "index";

export interface VersionProviderPort {
  /**
   * 返回给定 kind 的当前版本串（用于组 ToolCacheKey.version）。
   * hint 可携带工具入参（如被 fetch 的 url），实现按需使用。
   * 无法提供时返回 undefined（缓存退化为仅按 scope/TTL）。
   */
  get(kind: VersionKind, hint?: unknown): string | undefined | Promise<string | undefined>;
}
