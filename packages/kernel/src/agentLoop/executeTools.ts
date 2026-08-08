import type { ContentBlock, ToolContext, Message } from "@helios/ports";
import { uid } from "../ids";
import type { ToolRegistry } from "../toolRegistry";
import type { HookRunner } from "../hookRunner";
import type { AgentEventEmitter, ToolResultRecord } from "../events";
import type { ToolUseBlock } from "./types";
import { scopePorts } from "./portScope";

export interface ExecuteToolsParams {
  turnId: string;
  toolUseBlocks: ToolUseBlock[];
  /** 参数解析失败 / 输出被截断而判失败的 id 集合（见 streamAssistant）。 */
  parseErrorIds?: Set<string>;
  toolRegistry: ToolRegistry;
  hooks: HookRunner;
  toolCtx: ToolContext;
  events: AgentEventEmitter;
}

export interface ExecuteToolsResult {
  toolResultMsg: Message;
  records: ToolResultRecord[];
}

interface OneToolCallResult {
  resultBlock: ContentBlock;
  record: ToolResultRecord;
}

/**
 * 执行一批 tool_use。按批次判定并行/串行：只有本批全部工具都显式声明
 * `executionMode: 'parallel'` 才并发执行，否则整批退化为顺序执行（默认，与现状行为一致）。
 * 结果始终按 toolUseBlocks 原始顺序组装，与模型给出的顺序一致（并行模式下完成顺序可能不同）。
 */
export async function executeTools(params: ExecuteToolsParams): Promise<ExecuteToolsResult> {
  const { turnId, toolUseBlocks, parseErrorIds = new Set(), toolRegistry, hooks, toolCtx, events } = params;

  const allParallel =
    toolUseBlocks.length > 0 &&
    toolUseBlocks.every((b) => toolRegistry.get(b.name)?.executionMode === "parallel");

  const one = (block: ToolUseBlock) => runOneToolCall(block, parseErrorIds, toolRegistry, hooks, toolCtx, events);
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

/** 单个工具的 PreToolUse → ask → execute → PostToolUse → emit start/end 全流程。 */
async function runOneToolCall(
  block: ToolUseBlock,
  parseErrorIds: Set<string>,
  toolRegistry: ToolRegistry,
  hooks: HookRunner,
  toolCtx: ToolContext,
  events: AgentEventEmitter,
): Promise<OneToolCallResult> {
  let input = block.input;
  let output: unknown;
  let isError = false;

  // Bug 4：参数 JSON 解析失败 / 输出被截断的工具不执行，直接回传错误让 LLM 重试。
  if (parseErrorIds.has(block.id)) {
    output = "工具参数 JSON 解析失败或输出被截断，请检查参数格式后重试。";
    isError = true;
    events.emit({ type: "tool_execution_start", toolUseId: block.id, name: block.name, input });
    events.emit({ type: "tool_execution_end", toolUseId: block.id, output, isError });
    return {
      resultBlock: { type: "tool_result", toolUseId: block.id, output, isError },
      record: { toolUseId: block.id, name: block.name, output, isError },
    };
  }

  // PreToolUse
  const pre = await hooks.runPreToolUse({ toolName: block.name, input });
  if (pre.decision === "deny") {
    output = `工具调用被 Hook 拒绝：${pre.reason ?? ""}`.trim();
    isError = true;
  } else {
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
      }
    }
    if (!isError) {
      if (pre.input !== undefined) input = pre.input;
      const tool = toolRegistry.get(block.name);
      events.emit({ type: "tool_execution_start", toolUseId: block.id, name: block.name, input });
      if (!tool) {
        output = `未找到工具：${block.name}`;
        isError = true;
      } else {
        // 接口隔离：按工具声明的 requiredPorts 裁剪 ctx.ports，未声明的 Port 该工具碰不到。
        const scopedCtx: ToolContext = { ...toolCtx, ports: scopePorts(toolCtx.ports, tool.requiredPorts) };
        try {
          const res = await tool.execute(input, scopedCtx);
          output = res.output;
          isError = !!res.isError;
        } catch (err) {
          output = err instanceof Error ? err.message : String(err);
          isError = true;
        }
      }
      // PostToolUse
      const post = await hooks.runPostToolUse({ toolName: block.name, input, output, isError });
      if (post.output !== undefined) output = post.output;
      if (post.block) isError = true;
    }
  }

  // Bug 6：end 与 start 成对无条件 emit（emit 很便宜），避免中途订阅收到不成对事件。
  events.emit({ type: "tool_execution_end", toolUseId: block.id, output, isError });
  return {
    resultBlock: { type: "tool_result", toolUseId: block.id, output, isError },
    record: { toolUseId: block.id, name: block.name, output, isError },
  };
}
