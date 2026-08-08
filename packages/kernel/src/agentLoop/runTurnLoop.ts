import type { Message, LLMOptions, LLMProvider, RouteContext, RouteSignals } from "@helios/ports";
import { uid } from "../ids";
import { streamAssistant } from "./streamAssistant";
import { executeTools } from "./executeTools";
import type { RunLoopDeps, SessionTreeCallbacks, ToolUseBlock } from "./types";
import type { ToolResultRecord } from "../events";
import { approxTokens, pathHasCode, stableStringify } from "./canonical";

export interface RunTurnLoopParams {
  /** run 期间不变的基础设施依赖（LLM/工具/hook/ports/日志/askQuestion/中断信号/事件出口）。 */
  deps: RunLoopDeps;
  /** Session 消息树的操作面：回调驱动树变更，runTurnLoop 不持有任何树内部状态。 */
  tree: SessionTreeCallbacks;
  /** turnId 前缀，通常是 `${session.id}-${runIndex}` */
  turnIdPrefix: string;
  /** 本 run 的唯一 id，供 CostMeter 计量与 ToolResultCache 的 run scope。 */
  runId: string;
  runIndex: number;
  maxTurns: number;
  system: string;
  llmOptions: LLMOptions;
  /** 本 run 待发出的首轮 lead messages（通常是刚 append 的 userMsg）。 */
  pendingLeadMessages: Message[];
  /**
   * 扩展点（当前不实现队列本身）：每轮 turn 结束后调用一次尝试 drain，若返回非空消息，
   * 会作为下一轮的 lead messages 前置注入。默认不传 = 无中途插话，行为与改造前一致。
   */
  getSteeringMessages?: () => Promise<Message[]> | Message[];
}

export interface RunTurnLoopResult {
  turnIds: string[];
  /** Bug 3：LLM 流错误信息，用于 agent_end 优雅标注；正常结束时为 undefined。 */
  runError?: string;
  /** Bug 5：因达到 turn 上限（而非自然结束）退出。 */
  reachedMaxTurns: boolean;
}

/**
 * turn 循环骨架（内层循环）：streamAssistant → 有 tool_use 就 executeTools 继续下一轮，
 * 否则走 Stop hook 判断是否强制继续，都不满足则结束本 run。不涉及消息树/持久化的具体实现，
 * 只通过 `tree` 回调驱动 —— 调用方（Session）继续独占树状态。
 */
export async function runTurnLoop(params: RunTurnLoopParams): Promise<RunTurnLoopResult> {
  const { deps, tree, turnIdPrefix, runId, runIndex, maxTurns, system, llmOptions, getSteeringMessages } = params;
  const { provider, toolRegistry, hooks, sessionId, workDir, logger, askQuestion, signal, events } = deps;
  const { modelRouter, costMeter, toolCache, versionProvider, llmRegistry } = deps;

  const turnIds: string[] = [];
  let turnIndex = 0;
  let pendingLeadMessages = params.pendingLeadMessages;
  let runError: string | undefined;

  // 本 run 的路由信号累积（供 ModelRouter 每轮采集），随本 run 生命周期存在于闭包内。
  const routeState = {
    toolUseCountSoFar: 0,
    lastTurnHadError: false,
    lastTurnParseError: false,
    repeatedToolCall: false,
    lastToolSignature: null as string | null,
  };

  while (turnIndex < maxTurns) {
    if (signal.aborted) break; // 已中断：不再开新 turn

    // 扩展点：非首轮时尝试 drain 中途插话消息，前置注入本轮 lead messages。默认不传，无行为变化。
    if (turnIndex > 0 && getSteeringMessages) {
      const steering = await getSteeringMessages();
      if (steering.length > 0) pendingLeadMessages = [...pendingLeadMessages, ...steering];
    }

    const turnId = `${turnIdPrefix}-${turnIndex}`;
    turnIds.push(turnId);
    // turn 前锚点 = 此刻 HEAD（本 turn assistant 之前的节点），供回溯定位。
    const anchorNodeId = tree.currentHeadId();
    const checkpointRef = await tree.snapshotCheckpoint(turnId);
    events.emit({ type: "turn_start", turnId });

    // ModelRouter：每轮选 provider+model+参数（noop 返回 {} 即不改写）。
    const path = tree.pathToHead();
    const decision = await modelRouter.route(buildRouteContext(sessionId, turnIndex, path, toolRegistry.list().length, routeState));
    const effective: LLMOptions = {
      ...llmOptions,
      ...(decision.provider !== undefined ? { provider: decision.provider } : {}),
      ...(decision.model !== undefined ? { model: decision.model } : {}),
      ...(decision.thinking !== undefined ? { thinking: decision.thinking } : {}),
      ...(decision.maxTokens !== undefined ? { maxTokens: decision.maxTokens } : {}),
    };
    // 若路由改写了 provider 则从 registry 解析实际 provider，否则用 deps 默认 provider。
    const usedProvider: LLMProvider = decision.provider ? llmRegistry.get(decision.provider) : provider;

    let streamed: Awaited<ReturnType<typeof streamAssistant>>;
    try {
      streamed = await streamAssistant({
        provider: usedProvider,
        messages: path,
        tools: toolRegistry.list(),
        llmOptions: effective,
        system,
        signal,
        turnId,
        logger,
        events,
      });
    } catch (err) {
      // 中断导致的流异常（AbortError）视为正常停止，不向上抛
      if (signal.aborted) break;
      throw err;
    }
    const { assistantMsg, toolUseBlocks, streamError, parseErrorIds, usage } = streamed;
    assistantMsg.turnId = turnId;

    // CostMeter 计量（旁路观察）：有 usage 才记，noop 时为空操作。
    if (usage) {
      costMeter.onLLMCall(runId, {
        provider: usedProvider.id,
        model: effective.model ?? "",
        usage,
        purpose: "main",
      });
    }

    // Bug 7：只有非空 assistant 消息才入树/持久化，避免 content:[] 触发下游 API 报错。
    // thinking 块不算有效正文——只思考不回答/不调工具视为空轮，不入树（N3：丢弃 + 本 run 正常结束，不重试）。
    const turnMessages: Message[] = [...pendingLeadMessages];
    pendingLeadMessages = [];
    const assistantHasContent =
      Array.isArray(assistantMsg.content) && assistantMsg.content.some((b) => b.type !== "thinking");
    if (assistantHasContent) {
      tree.appendNode(assistantMsg);
      turnMessages.push(assistantMsg);
    }

    // Bug 3：LLM 流中途报错 → 优雅结束本 run（保证 agent_end 一定 emit、路径一致），不 throw。
    if (streamError) {
      await tree.persistTurn({ turnId, runIndex, turnIndex, checkpointRef, anchorNodeId, messages: turnMessages });
      events.emit({ type: "turn_end", turnId, toolResults: [] });
      runError = streamError;
      break;
    }

    if (toolUseBlocks.length > 0) {
      const toolCtx = { workDir, logger, askQuestion, signal };
      const { toolResultMsg, records } = await executeTools({
        turnId,
        toolUseBlocks,
        parseErrorIds,
        toolRegistry,
        hooks,
        sessionId,
        toolCtx,
        events,
        costMeter,
        toolCache,
        versionProvider,
        runId,
      });
      tree.appendNode(toolResultMsg);
      turnMessages.push(toolResultMsg);
      // 采集下一轮路由信号：错误 / 解析失败 / 打转（同名同参连续），并累加工具使用次数。
      updateRouteSignals(routeState, toolUseBlocks, records, parseErrorIds);
      await tree.persistTurn({ turnId, runIndex, turnIndex, checkpointRef, anchorNodeId, messages: turnMessages });
      events.emit({ type: "turn_end", turnId, toolResults: records });
      turnIndex++;
      continue; // 下一个 turn，把工具结果喂回 LLM
    }

    // 无工具调用：走 Stop hook 判断是否强制继续
    const stopDecision = await hooks.runStop({ sessionId, turnCount: turnIndex + 1 });
    if (stopDecision.block && stopDecision.message) {
      const injected: Message = { id: uid("msg"), role: "user", content: stopDecision.message, turnId };
      tree.appendNode(injected);
      turnMessages.push(injected);
      pendingLeadMessages = [injected];
      await tree.persistTurn({ turnId, runIndex, turnIndex, checkpointRef, anchorNodeId, messages: turnMessages });
      events.emit({ type: "turn_end", turnId, toolResults: [] });
      turnIndex++;
      continue;
    }

    await tree.persistTurn({ turnId, runIndex, turnIndex, checkpointRef, anchorNodeId, messages: turnMessages });
    events.emit({ type: "turn_end", turnId, toolResults: [] });
    break;
  }

  return { turnIds, runError, reachedMaxTurns: turnIndex >= maxTurns };
}

interface RouteSignalState {
  toolUseCountSoFar: number;
  lastTurnHadError: boolean;
  lastTurnParseError: boolean;
  repeatedToolCall: boolean;
  lastToolSignature: string | null;
}

/** 组装本轮路由上下文（廉价统计 + 上轮信号），不传完整 messages。 */
function buildRouteContext(
  sessionId: string,
  turnIndex: number,
  path: Message[],
  toolCount: number,
  state: RouteSignalState,
): RouteContext {
  const ctxTokens = approxTokens(path);
  const signals: RouteSignals = {
    contextTokens: ctxTokens,
    toolUseCountSoFar: state.toolUseCountSoFar,
    lastTurnHadError: state.lastTurnHadError,
    lastTurnParseError: state.lastTurnParseError,
    retriedLastTurn: state.lastTurnParseError, // 参数解析失败 → 下一轮等效重试
    repeatedToolCall: state.repeatedToolCall,
  };
  return {
    sessionId,
    turnIndex,
    purpose: "main",
    signals,
    contextStats: {
      inputTokens: ctxTokens,
      toolCount,
      messageCount: path.length,
      hasCode: pathHasCode(path),
    },
  };
}

/** 采集下一轮的路由信号：错误 / 解析失败 / 打转（同名同参连续），并累加工具使用次数。 */
function updateRouteSignals(
  state: RouteSignalState,
  toolUseBlocks: ToolUseBlock[],
  records: ToolResultRecord[],
  parseErrorIds: Set<string>,
): void {
  state.toolUseCountSoFar += toolUseBlocks.length;
  state.lastTurnHadError = records.some((r) => r.isError);
  state.lastTurnParseError = parseErrorIds.size > 0;
  const signature = toolUseBlocks.map((b) => `${b.name}(${stableStringify(b.input)})`).join("|");
  state.repeatedToolCall = signature.length > 0 && signature === state.lastToolSignature;
  state.lastToolSignature = signature;
}
