import type {
  CostMeterPort,
  LLMCallRecord,
  ToolCallRecord,
  TaskOutcome,
  TaskCostReport,
  CostUsage,
  KernelContext,
} from "@helios/ports";
import { COST_METER_PORT_API_VERSION } from "@helios/ports";

// @helios/costmeter-default —— CostMeterPort 官方实现：内存累加 + 可选价格表。
// 只做 measurement：report()/getUsage() 只回事实，不做预算判断（治理在 ModelRouter.Policy）。

/** 单模型价格（单位：每 1M token 的货币金额）。key 用 model 名，缺省回落 "*"。 */
export interface ModelPricing {
  uncachedInput: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface CostMeterOptions {
  pricingVersion?: string;
  pricing?: Record<string, ModelPricing>;
}

interface RunAcc {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  contextLengthSum: number;
  llmCalls: number;
  toolCalls: number;
  toolExecutions: number;
  toolCacheHits: number;
  spent: number;
  hasPricing: boolean;
  outcome?: TaskOutcome;
  pricingVersion?: string;
}

function emptyAcc(): RunAcc {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    contextLengthSum: 0,
    llmCalls: 0,
    toolCalls: 0,
    toolExecutions: 0,
    toolCacheHits: 0,
    spent: 0,
    hasPricing: false,
  };
}

class DefaultCostMeter implements CostMeterPort {
  // TODO(eviction): runs 按 runId 无限累积，长生命周期宿主（多租户/常驻）需在 report() 后删条目或加 LRU/TTL。
  // MVP（每连接一 session 的本地宿主）增长缓慢，暂不驱逐。
  private readonly runs = new Map<string, RunAcc>();

  constructor(private readonly opts: CostMeterOptions) {}

  private acc(runId: string): RunAcc {
    let a = this.runs.get(runId);
    if (!a) {
      a = emptyAcc();
      this.runs.set(runId, a);
    }
    return a;
  }

  onLLMCall(runId: string, rec: LLMCallRecord): void {
    const a = this.acc(runId);
    const u = rec.usage;
    a.uncachedInputTokens += u.uncachedInputTokens;
    a.cachedInputTokens += u.cachedInputTokens;
    a.cacheWriteTokens += u.cacheWriteTokens;
    a.outputTokens += u.outputTokens;
    // context length 用 provider 权威值，缺省 uncached+cached（不含 cacheWrite）。
    a.contextLengthSum += u.promptTokens ?? u.uncachedInputTokens + u.cachedInputTokens;
    a.llmCalls += 1;

    const price = this.opts.pricing?.[rec.model] ?? this.opts.pricing?.["*"];
    if (price) {
      a.hasPricing = true;
      a.spent +=
        (u.uncachedInputTokens * price.uncachedInput +
          u.cachedInputTokens * price.cachedInput +
          u.cacheWriteTokens * price.cacheWrite +
          u.outputTokens * price.output) /
        1_000_000;
      a.pricingVersion = rec.pricingVersion ?? this.opts.pricingVersion;
    }
  }

  onToolCall(runId: string, rec: ToolCallRecord): void {
    const a = this.acc(runId);
    a.toolCalls += 1;
    if (rec.executed) a.toolExecutions += 1;
    if (rec.cacheHit) a.toolCacheHits += 1;
  }

  setOutcome(runId: string, outcome: TaskOutcome): void {
    this.acc(runId).outcome = outcome;
  }

  report(runId: string): TaskCostReport {
    const a = this.acc(runId);
    const inputTotal = a.uncachedInputTokens + a.cachedInputTokens;
    return {
      runId,
      outcome: a.outcome,
      uncachedInputTokens: a.uncachedInputTokens,
      cachedInputTokens: a.cachedInputTokens,
      cacheWriteTokens: a.cacheWriteTokens,
      outputTokens: a.outputTokens,
      contextLength: inputTotal,
      llmCalls: a.llmCalls,
      toolCalls: a.toolCalls,
      toolExecutions: a.toolExecutions,
      toolCacheHits: a.toolCacheHits,
      avgContextLength: a.llmCalls > 0 ? a.contextLengthSum / a.llmCalls : 0,
      prefixCacheHitRate: a.toolCalls > 0 ? a.toolCacheHits / a.toolCalls : undefined,
      cachedInputRatio: inputTotal > 0 ? a.cachedInputTokens / inputTotal : undefined,
      estimatedCost: a.hasPricing ? a.spent : undefined,
      pricingVersion: a.pricingVersion,
    };
  }

  getUsage(runId: string): CostUsage {
    const a = this.acc(runId);
    return {
      spent: a.spent,
      uncachedInputTokens: a.uncachedInputTokens,
      cachedInputTokens: a.cachedInputTokens,
      outputTokens: a.outputTokens,
    };
  }
}

export const apiVersion = COST_METER_PORT_API_VERSION;

export function create(ctx: KernelContext): CostMeterPort {
  return new DefaultCostMeter((ctx.options ?? {}) as CostMeterOptions);
}

export default { apiVersion, create };
