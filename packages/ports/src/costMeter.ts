// CostMeterPort —— 观察者：订阅 run 内用量/调用事件，产出 Cost/Task 指标。
// 只做 measurement，不做 policy（治理在 ModelRouter.Policy）。见 docs/cost-optimization-layer.md 三。
import type { Usage } from "./types";

export const COST_METER_PORT_API_VERSION = 1;

export interface LLMCallRecord {
  provider: string;
  model: string;
  usage: Usage;
  purpose?: string;
  /** 价格版本，用于可审计/可复算（价格会变，只存 estimatedCost 事后会对不上）。 */
  pricingId?: string;
  pricingVersion?: string; // 如 "anthropic-2026-08"
}

/** 工具调用记录：区分"发起 / 执行 / 命中"三个概念。 */
export interface ToolCallRecord {
  name: string;
  cacheHit: boolean; // 命中缓存
  executed: boolean; // 是否真正执行（命中即 false）
}

/** run 结束时的任务结果，支撑 Cost/Successful Task。 */
export interface TaskOutcome {
  status: "success" | "failure" | "cancelled";
  reason?: string;
}

export interface TaskCostReport {
  runId: string;
  outcome?: TaskOutcome; // 无 outcome 只能算 Cost/Task
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /**
   * 本 run 全部 LLM 调用的 prompt token 总和（**不是**最后一次调用的上下文长度）。
   * 单次取 `promptTokens ?? (uncached + cached + cacheWrite)`；关心"上下文涨到多大"
   * 应看 `avgContextLength`。
   */
  contextLength: number;
  llmCalls: number;
  // 工具三指标分开：否则 toolCalls↓ 分不清是 agent 少调还是 cache 挡掉
  toolCalls: number; // agent 发起的工具请求数
  toolExecutions: number; // 真正执行次数
  toolCacheHits: number; // 缓存命中次数（toolCalls = executions + cacheHits）
  avgContextLength: number; // contextLength / llmCalls
  // Context 层 ↔ Cost 层的桥：证明 Context Reuse → cache↑ → Cost/Task↓。
  // 两个比率是不同的问题，都要看：
  /**
   * **按调用计**：有多少比例的 LLM 调用命中了前缀缓存（`cachedInputTokens > 0`）。
   * 回答"缓存是不是经常整体失效"—— 一次前缀漂移会让这个数直接掉下来，而
   * `cachedInputRatio` 可能因为其余调用命中良好而看不出异常。
   *
   * ⚠️ 与工具结果缓存无关。工具那笔账看 `toolCacheHits / toolCalls`。
   */
  prefixCacheHitRate?: number;
  /**
   * **按 token 计**：`cachedInput / (uncached + cached + cacheWrite)`，即 prompt 里
   * 有多大比例是按便宜的缓存读价拿到的。分母含 cacheWrite —— 那部分同样是发出去的
   * prompt，只是按写入价计费，漏掉它会把命中率算高。
   */
  cachedInputRatio?: number;
  estimatedCost?: number; // 由可选价格表算出
  pricingVersion?: string;
}

/** 纯 measured 事实，供 Policy 做预算/切换成本判断（不含任何 decision/estimate）。 */
export interface CostUsage {
  spent: number; // 已花（价格表可用时）
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface CostMeterPort {
  onLLMCall(runId: string, rec: LLMCallRecord): void;
  onToolCall(runId: string, rec: ToolCallRecord): void;
  setOutcome(runId: string, outcome: TaskOutcome): void;
  report(runId: string): TaskCostReport;
  /** measurement only：只回已测事实，预算判断/切换成本估算都在 Router.Policy。 */
  getUsage(runId: string): CostUsage;
}
