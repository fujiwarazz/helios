import type { ConversationState, Message, Summary } from "./types";

export const COMPACT_STRATEGY_PORT_API_VERSION = 1;

/**
 * 上下文压缩策略。降级：不加载 → shouldCompact 恒 false，永不压缩。
 */
export interface CompactStrategyPort {
  shouldCompact(state: ConversationState): boolean;
  compact(messages: Message[]): Promise<Summary>;
}
