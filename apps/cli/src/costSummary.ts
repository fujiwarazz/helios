import type { TaskCostReport } from "@helios/ports";

/**
 * 把一次 run 的成本报告压成一行 transcript 文本。
 *
 * 只挑三件在终端里真正能驱动行动的事：输入规模、缓存命中比例、花了多少钱。
 * 命中率用**按 token 计**的 `cachedInputRatio` 而非按调用计的 `prefixCacheHitRate` ——
 * 这一行是给"这轮贵不贵"用的，而 token 占比才直接对应账单。
 *
 * 返回 undefined 表示无可展示内容（没装 CostMeterPort，或这一轮没有任何 LLM 调用，
 * 例如被 UserPromptSubmit hook 拦下）—— 此时不该打一行全是 0 的噪音。
 */
export function formatCostSummary(report: TaskCostReport | undefined): string | undefined {
  if (!report || report.llmCalls === 0) return undefined;

  const parts = [`↑ ${compactTokens(report.contextLength)}`];
  if (report.cachedInputRatio !== undefined) {
    parts[0] += ` (${Math.round(report.cachedInputRatio * 100)}% cached)`;
  }
  parts.push(`↓ ${compactTokens(report.outputTokens)}`);
  parts.push(`${report.llmCalls} ${report.llmCalls === 1 ? "call" : "calls"}`);
  if (report.estimatedCost !== undefined) parts.push(formatCost(report.estimatedCost));

  return parts.join(" · ");
}

/** 1234 → "1234"；12345 → "12.3k"。token 数上万后精确值没有意义，位数反而干扰阅读。 */
function compactTokens(tokens: number): string {
  if (tokens < 10_000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * 极小的金额不能四舍五入成 `$0.00` —— 那会让人误以为免费。低于 1 分时给出足够位数。
 */
function formatCost(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
