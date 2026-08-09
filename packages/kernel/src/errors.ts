/**
 * kernel 层归一化错误类型（issue #10 review 意见）。当前唯一会触发这条"非预期 throw"路径的来源
 * 是 `LLMProvider.streamMessage` 里非 SDK `APIError` 的异常——预期错误（429/5xx/401/网络类）由
 * provider 自己转成 `StreamEvent{type:"error",...}` Result 通道（见 llm-anthropic/llm-openai），
 * 不会走到这里。
 *
 * 命名/结构对齐仓内既有的 `MultiAgentNotEnabledError`（见 `noop.ts`）：具名 Error 子类 + 从
 * `kernel/src/index.ts` 导出，调用方只需认这一个类型，不用关心底下具体是哪个 SDK/哪一行代码炸的。
 */
export class LlmProviderError extends Error {
  readonly code = "llm_provider" as const;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LlmProviderError";
  }
}

/** 已是 `LlmProviderError` 原样返回；其它 Error/非 Error 值包一层，`cause` 保留原始错误。 */
export function normalizeLlmError(err: unknown): LlmProviderError {
  if (err instanceof LlmProviderError) return err;
  return new LlmProviderError(err instanceof Error ? err.message : String(err), err);
}
