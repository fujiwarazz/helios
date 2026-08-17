import type {
  CompactPlan,
  CompactStrategyPort,
  ConversationState,
  Message,
  ContentBlock,
  KernelContext,
} from "@helios/ports";
import { COMPACT_STRATEGY_PORT_API_VERSION } from "@helios/ports";
import { SUMMARIZER_SYSTEM, SUMMARIZE_INSTRUCTION, buildSummarizeRequest } from "./prompt";

// @helios/compact-default —— CompactStrategyPort 官方实现。
// 触发：approxTokens 超阈值。产出一份计划（问什么、覆盖哪些、怎么读结果），由 kernel 执行调用。
// 用户可换成基于真实 tokenizer + 分层压缩的实现。

const DEFAULT_THRESHOLD = 12_000;
const SUMMARY_MAX_TOKENS = 2_048;
/** 单条消息进独立摘要请求时的截断长度。仅 standalone 路线需要——inline 路线复用前缀里的原始消息。 */
const MESSAGE_CHAR_LIMIT = 4_000;

class DefaultCompact implements CompactStrategyPort {
  constructor(
    private readonly threshold: number,
    private readonly useLlm: boolean,
  ) {}

  shouldCompact(state: ConversationState): boolean {
    return state.approxTokens > this.threshold;
  }

  plan(state: ConversationState): CompactPlan {
    const messages = state.messages;
    return {
      coveredMessageIds: messages.map((m) => m.id),
      maxTokens: SUMMARY_MAX_TOKENS,
      inlineInstruction: SUMMARIZE_INSTRUCTION,
      standalone: {
        system: SUMMARIZER_SYSTEM,
        userText: buildSummarizeRequest(renderConversation(messages)),
      },
      // llm:false 或空对话 → 预置产物，kernel 不发请求。
      ...(this.useLlm && messages.length > 0
        ? {}
        : { precomputed: extractiveSummary(messages) }),
    };
  }

  parseSummary(raw: string): string | undefined {
    return raw.trim() || undefined;
  }
}

/**
 * 喂给独立摘要请求的对话正文：保留角色与顺序，逐条按 MESSAGE_CHAR_LIMIT 截断。
 * 只服务 standalone 路线；inline 路线让模型直接读前缀里的原始消息，信息更完整。
 */
function renderConversation(messages: Message[]): string {
  return messages
    .map((m) => `${m.role}: ${truncate(textOf(m.content), MESSAGE_CHAR_LIMIT)}`)
    .join("\n\n");
}

/**
 * 抽取式摘要：不调用 LLM 的产物（首 2 条 + 尾 3 条 + 省略计数）。
 * 信息量很低，只保证"会话能继续"，不保证"能接着干活" —— 因此**只用于 llm:false 的显式场景**
 * （离线、确定性测试），不作为 LLM 摘要失败时的回落：用瞬时故障换一个永久固化的劣质节点是净亏。
 */
export function extractiveSummary(messages: Message[]): string {
  const texts = messages.map((m) => `${m.role}: ${truncate(textOf(m.content), 200)}`);
  const body =
    texts.length > 5
      ? [...texts.slice(0, 2), `… (省略 ${texts.length - 5} 条) …`, ...texts.slice(-3)]
      : texts;
  return `# 对话摘要（${messages.length} 条消息）\n${body.join("\n")}`;
}

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_use") return `[tool_use ${b.name}]`;
      if (b.type === "tool_result") return `[tool_result]`;
      return "";
    })
    .join(" ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export const apiVersion = COMPACT_STRATEGY_PORT_API_VERSION;

export function create(ctx: KernelContext): CompactStrategyPort {
  const threshold = Number((ctx.options?.threshold as number) ?? DEFAULT_THRESHOLD);
  // llm: false 强制走抽取式，供离线场景与需要确定性产物的测试使用。
  const useLlm = ctx.options?.llm !== false;
  return new DefaultCompact(threshold, useLlm);
}

export default { apiVersion, create };
