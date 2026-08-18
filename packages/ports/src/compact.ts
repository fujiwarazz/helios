import type { ConversationState } from "./types";

export const COMPACT_STRATEGY_PORT_API_VERSION = 2;

/**
 * 一次压缩的执行计划。Port 只描述"压什么、怎么问、怎么读结果"，**不负责发请求** ——
 * LLM 调用由 kernel 执行，因为复用主会话前缀（省 ~90% 输入成本 + 免 prefill 延迟）需要
 * system / tools / 缓存断点 / 模型选择，而这些只有 kernel 手上有。
 */
export interface CompactPlan {
  /**
   * 本次覆盖哪些消息。允许是真子集 —— 未覆盖的留在摘要之后作为原文尾巴。
   * kernel 会对切点做安全吸附（首个保留节点绝不为 toolResult，杜绝孤儿 tool_result）。
   */
  coveredMessageIds: string[];
  /** 摘要输出预算。 */
  maxTokens: number;
  /**
   * 追加到**主会话前缀之后**的一条 user 消息正文。对话已经在前缀里，此处只放指令、
   * 不重复对话内容 —— 这是复用前缀路线（inline）的请求尾部。
   */
  inlineInstruction: string;
  /** 独立调用所需的 system 与单条 user 正文（含渲染后的对话）；窗口装不下 inline 时的兜底路线。 */
  standalone: { system: string; userText: string };
  /**
   * 预置摘要：非空时 kernel 直接采用它、**不发任何 LLM 请求**。
   * 供离线场景与需要确定性产物的测试使用 —— 它是显式逃生舱，不是失败回落。
   */
  precomputed?: string;
}

/**
 * 上下文压缩策略。降级：不加载 → shouldCompact 恒 false，永不压缩。
 */
export interface CompactStrategyPort {
  shouldCompact(state: ConversationState): boolean;
  /** 纯函数：只产出计划，不调 LLM、无副作用、不抛。 */
  plan(state: ConversationState): CompactPlan;
  /**
   * 把模型原始输出解析/校验成最终摘要文本。
   *
   * @returns undefined = 产物不可用（空串、明显截断、不满足验收规则）。kernel 据此判定本次
   *   压缩失败，从而**什么都不改写**（不装节点、不落盘、不移 HEAD），而不是安装一个劣质摘要 ——
   *   劣质节点一旦进树就是祖先链的一部分，还会成为下次压缩的输入，信息永久回不来。
   */
  parseSummary(raw: string, state: ConversationState): string | undefined;
}
