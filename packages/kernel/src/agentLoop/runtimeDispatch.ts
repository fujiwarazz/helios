// runtimeDispatch —— 固定每类 Runtime 挂载点的合并/短路语义，供 runTurnLoop/executeTools 调用。
// loop 侧只 import 这几个函数，不自己写裸 for 循环；合并策略集中在此，可独立单测。
import type {
  Runtime,
  RouteContext,
  RouteDecision,
  LLMCallRecord,
  ToolCallRecord,
  TaskOutcome,
  TaskCostReport,
  ToolCacheKey,
  ToolResult,
  VersionKind,
} from "@helios/ports";

/** run 开始通知：纯副作用，全部依次 await。 */
export async function dispatchRunStart(runtimes: Runtime[], runId: string): Promise<void> {
  for (const rt of runtimes) await rt.onRunStart?.(runId);
}

/**
 * 每 turn 开始：依次调用，返回值逐字段 `Object.assign`——后面的 runtime 覆盖前面已设置的字段，
 * 未设置字段不覆盖（与 HookRunner 的"最后一个非 undefined 覆盖"惯例一致）。
 */
export async function dispatchTurnStart(runtimes: Runtime[], ctx: RouteContext): Promise<RouteDecision> {
  const decision: RouteDecision = {};
  for (const rt of runtimes) {
    const d = await rt.onTurnStart?.(ctx);
    if (d) Object.assign(decision, d);
  }
  return decision;
}

/** LLM 响应后的用量观察：纯副作用，全部依次 await。 */
export async function dispatchLLMResponse(runtimes: Runtime[], runId: string, rec: LLMCallRecord): Promise<void> {
  for (const rt of runtimes) await rt.onLLMResponse?.(runId, rec);
}

/** 查询缓存版本串：依次调用，第一个非 undefined 结果短路返回（查询语义，不是覆盖语义）。 */
export async function dispatchCacheVersion(
  runtimes: Runtime[],
  kind: VersionKind,
  hint?: unknown,
): Promise<string | undefined> {
  for (const rt of runtimes) {
    const v = await rt.getCacheVersion?.(kind, hint);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** 工具执行前查缓存：依次调用，第一个命中（非 undefined）短路返回。 */
export async function dispatchBeforeTool(runtimes: Runtime[], key: ToolCacheKey): Promise<ToolResult | undefined> {
  for (const rt of runtimes) {
    const r = await rt.onBeforeTool?.(key);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** 工具执行后的记账/写缓存：纯副作用，全部依次 await。 */
export async function dispatchAfterTool(
  runtimes: Runtime[],
  runId: string,
  rec: ToolCallRecord,
  cache?: { key: ToolCacheKey; result: ToolResult; ttlMs?: number },
): Promise<void> {
  for (const rt of runtimes) await rt.onAfterTool?.(runId, rec, cache);
}

/** run 结束收尾：全部依次 await，最后一个非 undefined 返回值作为最终报告。 */
export async function dispatchRunEnd(
  runtimes: Runtime[],
  runId: string,
  outcome: TaskOutcome,
): Promise<TaskCostReport | undefined> {
  let report: TaskCostReport | undefined;
  for (const rt of runtimes) {
    const r = await rt.onRunEnd?.(runId, outcome);
    if (r) report = r;
  }
  return report;
}
