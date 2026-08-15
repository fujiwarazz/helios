import type { ConversationState, Message, Summary } from "./types";

export const COMPACT_STRATEGY_PORT_API_VERSION = 1;

/**
 * 上下文压缩策略。降级：不加载 → shouldCompact 恒 false，永不压缩。
 */
export interface CompactStrategyPort {
  shouldCompact(state: ConversationState): boolean;
  /**
   * @param runId 触发本次压缩的 run。实现若自己调 LLM，须用它把开销上报
   *   `CostMeterPort.onLLMCall(runId, …)`：计量 API 全部以 runId 为键，而压缩发生在 turn 循环
   *   之外（Session 先 maybeCompact 再进 runTurnLoop），够不到循环内的 Runtime 分发点。
   *
   * 加参数不算破坏性变更、无需 bump apiVersion：TS 里少声明形参的函数仍可赋给多形参的签名，
   * 既有不调 LLM 的实现（含 NoopCompact 与各 fixture）保持 `compact(messages)` 即可。
   */
  compact(messages: Message[], runId: string): Promise<Summary>;
}
