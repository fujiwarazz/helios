import type {
  ContentBlock,
  ToolContext,
  Message,
  Tool,
  CostMeterPort,
  ToolResultCachePort,
  VersionProviderPort,
  ToolCacheKey,
} from "@helios/ports";
import { uid } from "../ids";
import type { ToolRegistry } from "../toolRegistry";
import type { HookRunner } from "../hookRunner";
import type { AgentEventEmitter, ToolResultRecord } from "../events";
import type { ToolUseBlock } from "./types";
import { stableStringify } from "./canonical";

export interface ExecuteToolsParams {
  turnId: string;
  toolUseBlocks: ToolUseBlock[];
  /** 参数解析失败 / 输出被截断而判失败的 id 集合（见 streamAssistant）。 */
  parseErrorIds?: Set<string>;
  toolRegistry: ToolRegistry;
  hooks: HookRunner;
  /** 贯穿所有 hook payload 的公共字段，对齐 valos HookBaseStdin。 */
  sessionId: string;
  toolCtx: ToolContext;
  events: AgentEventEmitter;
  // --- Cost-aware Runtime（均有 noop 兜底）---
  costMeter: CostMeterPort;
  toolCache: ToolResultCachePort;
  versionProvider: VersionProviderPort;
  runId: string;
}

export interface ExecuteToolsResult {
  toolResultMsg: Message;
  records: ToolResultRecord[];
}

interface OneToolCallResult {
  resultBlock: ContentBlock;
  record: ToolResultRecord;
}

/** runOneToolCall 的共享上下文，避免逐个透传一长串参数。 */
interface ToolExecCtx {
  parseErrorIds: Set<string>;
  toolRegistry: ToolRegistry;
  hooks: HookRunner;
  sessionId: string;
  toolCtx: ToolContext;
  events: AgentEventEmitter;
  costMeter: CostMeterPort;
  toolCache: ToolResultCachePort;
  versionProvider: VersionProviderPort;
  runId: string;
}

/**
 * 执行一批 tool_use。按批次判定并行/串行：只有本批全部工具都显式声明
 * `executionMode: 'parallel'` 才并发执行，否则整批退化为顺序执行（默认，与现状行为一致）。
 * 结果始终按 toolUseBlocks 原始顺序组装，与模型给出的顺序一致（并行模式下完成顺序可能不同）。
 */
export async function executeTools(params: ExecuteToolsParams): Promise<ExecuteToolsResult> {
  const { turnId, toolUseBlocks, parseErrorIds = new Set(), toolRegistry, hooks, sessionId, toolCtx, events } = params;
  const ctx: ToolExecCtx = {
    parseErrorIds,
    toolRegistry,
    hooks,
    sessionId,
    toolCtx,
    events,
    costMeter: params.costMeter,
    toolCache: params.toolCache,
    versionProvider: params.versionProvider,
    runId: params.runId,
  };

  const allParallel =
    toolUseBlocks.length > 0 &&
    toolUseBlocks.every((b) => toolRegistry.get(b.name)?.executionMode === "parallel");

  const one = (block: ToolUseBlock) => runOneToolCall(block, ctx);
  const results: OneToolCallResult[] = allParallel
    ? await Promise.all(toolUseBlocks.map(one))
    : await sequentialMap(toolUseBlocks, one);

  const resultBlocks = results.map((r) => r.resultBlock);
  const records = results.map((r) => r.record);

  const toolResultMsg: Message = {
    id: uid("msg"),
    role: "toolResult",
    content: resultBlocks,
    turnId,
  };
  return { toolResultMsg, records };
}

async function sequentialMap<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}

/** 组 ToolResultCache key：scopeId 按 scope 取；version 由 VersionProvider 按 kind 注入。 */
async function buildCacheKey(ctx: ToolExecCtx, tool: Tool, input: unknown): Promise<ToolCacheKey> {
  const scope = tool.cacheScope ?? "run";
  const scopeId = scope === "run" ? ctx.runId : scope === "session" ? ctx.sessionId : "global";
  const version = tool.cacheVersionKind
    ? await ctx.versionProvider.get(tool.cacheVersionKind, input)
    : undefined;
  return { toolName: tool.name, argsCanonical: stableStringify(input), scope, scopeId, version };
}

/** 单个工具的 PreToolUse → ask → (cache) execute → PostToolUse → emit start/end 全流程。 */
async function runOneToolCall(block: ToolUseBlock, ctx: ToolExecCtx): Promise<OneToolCallResult> {
  const { parseErrorIds, toolRegistry, hooks, sessionId, toolCtx, events, costMeter, runId } = ctx;
  let input = block.input;
  let output: unknown;
  let isError = false;
  let cacheHit = false;
  let executed = false;

  const finish = (): OneToolCallResult => {
    events.emit({ type: "tool_execution_end", toolUseId: block.id, output, isError });
    costMeter.onToolCall(runId, { name: block.name, cacheHit, executed });
    return {
      resultBlock: { type: "tool_result", toolUseId: block.id, output, isError },
      record: { toolUseId: block.id, name: block.name, output, isError },
    };
  };

  // Bug 4：参数 JSON 解析失败 / 输出被截断的工具不执行，直接回传错误让 LLM 重试。
  if (parseErrorIds.has(block.id)) {
    output = "工具参数 JSON 解析失败或输出被截断，请检查参数格式后重试。";
    isError = true;
    events.emit({ type: "tool_execution_start", toolUseId: block.id, name: block.name, input });
    return finish();
  }

  // PreToolUse
  const pre = await hooks.runPreToolUse({ sessionId, toolName: block.name, input });
  if (pre.decision === "deny") {
    output = `工具调用被 Hook 拒绝：${pre.reason ?? ""}`.trim();
    isError = true;
    return finish();
  }
  if (pre.decision === "ask") {
    const ans = await toolCtx.askQuestion({
      question: `是否允许执行工具 ${block.name}？`,
      header: "工具审批",
      options: [
        { label: "允许", description: pre.reason },
        { label: "拒绝" },
      ],
    });
    if (ans.answers[0] !== "允许") {
      output = "工具调用被用户拒绝";
      isError = true;
      return finish();
    }
  }

  if (pre.input !== undefined) input = pre.input;
  const tool = toolRegistry.get(block.name);
  events.emit({ type: "tool_execution_start", toolUseId: block.id, name: block.name, input });
  if (!tool) {
    output = `未找到工具：${block.name}`;
    isError = true;
    return finish();
  }

  // ToolResultCache：仅对 opt-in 的幂等/只读工具生效（noop 时恒未命中）。
  const cacheKey = tool.cacheable ? await buildCacheKey(ctx, tool, input) : undefined;
  const cached = cacheKey ? await ctx.toolCache.get(cacheKey) : undefined;
  if (cached) {
    output = cached.output;
    isError = !!cached.isError;
    cacheHit = true;
  } else {
    try {
      const res = await tool.execute(input, toolCtx);
      output = res.output;
      isError = !!res.isError;
      executed = true;
      // 只缓存非错误结果，避免把偶发失败固化。
      if (cacheKey && !isError) {
        await ctx.toolCache.set(cacheKey, { output, isError }, tool.cacheTtlMs);
      }
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
      isError = true;
      executed = true;
    }
  }

  // PostToolUse：无论结果来自真实执行还是缓存命中都运行——它是对"返回给模型的 output"做后处理，
  // 与 output 来源无关。若某 hook 依赖真实副作用发生，需自行判断（缓存命中不会重放副作用）。
  const post = await hooks.runPostToolUse({ sessionId, toolName: block.name, input, output, isError });
  if (post.output !== undefined) output = post.output;
  if (post.block) isError = true;

  return finish();
}
