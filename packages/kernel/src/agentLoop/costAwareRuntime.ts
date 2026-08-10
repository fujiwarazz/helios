// CostAwareRuntime —— 适配器：把 ModelRouterPort/CostMeterPort/ToolResultCachePort/VersionProviderPort
// 四个已装配的 Port 粘合成 loop 认识的 Runtime 形状。纯委托，不新增任何业务逻辑——四个 Port 的行为
// 语义完全不变，只是调用路径从"loop 直接 import 具名字段"变成"loop 调 Runtime 数组"。
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
  PortRegistry,
} from "@helios/ports";

export class CostAwareRuntime implements Runtime {
  constructor(
    private readonly ports: Pick<PortRegistry, "modelRouter" | "costMeter" | "toolCache" | "versionProvider">,
  ) {}

  onTurnStart(ctx: RouteContext): RouteDecision | Promise<RouteDecision> {
    return this.ports.modelRouter.route(ctx);
  }

  onLLMResponse(runId: string, rec: LLMCallRecord): void {
    this.ports.costMeter.onLLMCall(runId, rec);
  }

  getCacheVersion(kind: VersionKind, hint?: unknown): string | undefined | Promise<string | undefined> {
    return this.ports.versionProvider.get(kind, hint);
  }

  onBeforeTool(key: ToolCacheKey): Promise<ToolResult | undefined> {
    return this.ports.toolCache.get(key);
  }

  async onAfterTool(
    runId: string,
    rec: ToolCallRecord,
    cache?: { key: ToolCacheKey; result: ToolResult; ttlMs?: number },
  ): Promise<void> {
    this.ports.costMeter.onToolCall(runId, rec);
    // 只缓存非错误结果，避免把偶发失败固化（与改造前 executeTools.ts 的行为一致）。
    if (cache && !cache.result.isError) {
      await this.ports.toolCache.set(cache.key, cache.result, cache.ttlMs);
    }
  }

  onRunEnd(runId: string, outcome: TaskOutcome): TaskCostReport {
    this.ports.costMeter.setOutcome(runId, outcome);
    return this.ports.costMeter.report(runId);
  }
}
