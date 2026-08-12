// Runtime —— kernel 内部的适配层接口，把若干已装配 Port 粘合成 loop 认识的统一调用形状。
// 不是新的插件类型，不进 manifest/PORT_META；loop 只认 `RunLoopDeps.runtimes: Runtime[]`，
// 逐一分发到固定挂载点，不关心数组里具体是什么、有几个（open/closed：新增能力不改 loop）。
import type { ToolResult } from "./types";
import type { RouteContext, RouteDecision } from "./modelRouter";
import type { LLMCallRecord, ToolCallRecord, TaskOutcome, TaskCostReport } from "./costMeter";
import type { ToolCacheKey } from "./toolResultCache";
import type { VersionKind } from "./versionProvider";

export const RUNTIME_API_VERSION = 1;

/** loop 固定挂载点的统一分发形状。所有方法可选——一个 Runtime 只需实现自己关心的几个。 */
export interface Runtime {
  onRunStart?(runId: string): Promise<void> | void;
  /** 每 turn 开始前，可返回要覆盖的 LLMOptions 字段（现 ModelRouterPort.route）。 */
  onTurnStart?(ctx: RouteContext): Promise<RouteDecision | void> | RouteDecision | void;
  /** LLM 响应后，观察 usage（现 CostMeterPort.onLLMCall）。 */
  onLLMResponse?(runId: string, rec: LLMCallRecord): Promise<void> | void;
  /** 查询缓存版本串，供调用方组 ToolCacheKey（现 VersionProviderPort.get）。 */
  getCacheVersion?(kind: VersionKind, hint?: unknown): Promise<string | undefined> | string | undefined;
  /** 工具执行前查缓存，命中则短路（现 ToolResultCachePort.get）。 */
  onBeforeTool?(key: ToolCacheKey): Promise<ToolResult | undefined> | ToolResult | undefined;
  /** 工具执行后：记账 + 命中条件时写缓存（现 CostMeterPort.onToolCall + ToolResultCachePort.set）。 */
  onAfterTool?(
    runId: string,
    rec: ToolCallRecord,
    cache?: { key: ToolCacheKey; result: ToolResult; ttlMs?: number },
  ): Promise<void> | void;
  /** run 结束，产出报告（现 CostMeterPort.setOutcome + report）。 */
  onRunEnd?(runId: string, outcome: TaskOutcome): Promise<TaskCostReport | void> | TaskCostReport | void;
}
