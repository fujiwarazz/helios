import type {
  CompactStrategyPort,
  ConversationState,
  Message,
  Summary,
  ContentBlock,
  KernelContext,
  PortRegistry,
  Logger,
} from "@helios/ports";
import { COMPACT_STRATEGY_PORT_API_VERSION } from "@helios/ports";
import { SUMMARIZER_SYSTEM, buildSummarizeRequest } from "./prompt";

// @helios/compact-default —— CompactStrategyPort 官方实现。
// 触发：approxTokens 超阈值。压缩：调 LLM 产出结构化摘要，失败时回落到朴素抽取。
// 用户可换成基于真实 tokenizer + 分层压缩的实现。

const DEFAULT_THRESHOLD = 12_000;
const SUMMARY_MAX_TOKENS = 2_048;
/** 单条消息进摘要请求时的截断长度。比抽取式的 200 宽松得多，但仍需设限防单条巨型 tool_result 打满上下文。 */
const MESSAGE_CHAR_LIMIT = 4_000;

class DefaultCompact implements CompactStrategyPort {
  /**
   * 持有整个 ports 注册表而不是在构造时取出 `ports.llm`：createLivePortRegistry 用的是 getter，
   * LLMProvider 在 manifest 里排在 CompactStrategyPort 之后加载，构造期取值会拿到尚未注册的状态。
   * 延迟到 compact() 调用时解析，就无需为此调整 manifest 顺序，也不必改 Port 签名。
   */
  constructor(
    private readonly threshold: number,
    private readonly ports: PortRegistry,
    private readonly logger: Logger,
    private readonly useLlm: boolean,
  ) {}

  shouldCompact(state: ConversationState): boolean {
    return state.approxTokens > this.threshold;
  }

  async compact(messages: Message[], runId: string): Promise<Summary> {
    const coveredMessageIds = messages.map((m) => m.id);
    const text = (await this.llmSummary(messages, runId)) ?? extractiveSummary(messages);
    return { text, coveredMessageIds };
  }

  /**
   * LLM 摘要。任何失败都返回 undefined 交由调用方回落——压缩是为了让会话能继续，
   * 没有 provider、限流、或模型返回空都不该让整轮 run 挂掉。
   *
   * 开销自行上报 CostMeterPort：压缩在 turn 循环之外发生，够不到 runTurnLoop 里的
   * Runtime.onLLMResponse 分发点，不自报就会系统性漏记——而压缩恰好是把整段对话当输入的
   * 大调用，只在长会话触发，漏掉它等于成本统计在最该准的时候偏低。
   */
  private async llmSummary(messages: Message[], runId: string): Promise<string | undefined> {
    if (!this.useLlm || messages.length === 0) return undefined;
    try {
      const provider = this.ports.llm.get();
      const request: Message = {
        id: "compact-request",
        role: "user",
        content: buildSummarizeRequest(renderConversation(messages)),
      };
      let out = "";
      for await (const ev of provider.streamMessage([request], [], {
        system: SUMMARIZER_SYSTEM,
        maxTokens: SUMMARY_MAX_TOKENS,
      })) {
        if (ev.type === "text-delta") out += ev.text;
        // provider 把预期错误走 Result 通道（StreamEvent.error）而非 throw，这里必须显式识别，
        // 否则会把"限流失败"当成"模型返回了空摘要"。
        else if (ev.type === "error") throw new Error(ev.error);
        else if (ev.type === "message-stop" && ev.usage) {
          // purpose 让成本报告能把压缩开销与正常 turn 调用区分开。
          this.ports.costMeter.onLLMCall(runId, {
            provider: provider.id,
            model: "",
            usage: ev.usage,
            purpose: "compaction",
          });
        }
      }
      return out.trim() || undefined;
    } catch (err) {
      this.logger.warn(
        `压缩摘要调用 LLM 失败，回落抽取式摘要：${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
}

/** 喂给摘要模型的对话正文：保留角色与顺序，逐条按 MESSAGE_CHAR_LIMIT 截断。 */
function renderConversation(messages: Message[]): string {
  return messages
    .map((m) => `${m.role}: ${truncate(textOf(m.content), MESSAGE_CHAR_LIMIT)}`)
    .join("\n\n");
}

/**
 * 抽取式摘要：不调用 LLM 的兜底产物（首 2 条 + 尾 3 条 + 省略计数）。
 * 信息量很低，只保证"会话能继续"，不保证"能接着干活"。
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
  return new DefaultCompact(threshold, ctx.ports, ctx.logger, useLlm);
}

export default { apiVersion, create };
