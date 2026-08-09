/** LLM 调用重试策略配置；`RunLoopDeps.llmRetry` 可覆盖，未传时用 {@link DEFAULT_LLM_RETRY}。 */
export interface LlmRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * maxRetries 默认收紧为 3（不是 CC 公开文档里的 10）：issue #10 未要求与 CC 完全对齐，3 次已覆盖
 * 绝大多数瞬时抖动，且可通过 `RunLoopDeps.llmRetry` 覆盖，不锁死。
 */
export const DEFAULT_LLM_RETRY: LlmRetryOptions = { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 32000 };

/**
 * 计算第 `retryCount` 次重试前应等待的毫秒数。公式取自 shareai s11 深潜对 CC `withRetry.ts:530-548`
 * 的还原：`min(baseDelayMs × 2^retryCount, maxDelayMs) + random(0~25%)`。
 *
 * 若服务端给了 `retryAfterMs`（`Retry-After` 响应头），优先遵从该值——但设了上限保护：超过
 * `maxDelayMs` 时返回 `undefined`，代表"不应该重试"（等这么久不如直接判定失败），调用方据此转向
 * fatal 路径，而不是无条件遵从服务端可能过长的建议值。
 */
export function computeRetryDelayMs(
  retryCount: number,
  opts: LlmRetryOptions = DEFAULT_LLM_RETRY,
  retryAfterMs?: number,
): number | undefined {
  if (retryAfterMs !== undefined) {
    return retryAfterMs <= opts.maxDelayMs ? retryAfterMs : undefined;
  }
  const base = Math.min(opts.baseDelayMs * 2 ** retryCount, opts.maxDelayMs);
  return base + Math.random() * base * 0.25;
}

export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
