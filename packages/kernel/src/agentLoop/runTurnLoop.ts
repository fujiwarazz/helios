import type { Message, PortRegistry, Logger, LLMOptions, LLMProvider, Ref, AskQuestionRequest, AskQuestionResponse } from "@helios/ports";
import type { ToolRegistry } from "../toolRegistry";
import type { HookRunner } from "../hookRunner";
import { uid } from "../ids";
import type { AgentEvent } from "../events";
import { streamAssistant } from "./streamAssistant";
import { executeTools } from "./executeTools";
import type { TurnRecord } from "./types";

export interface RunTurnLoopParams {
  /** turnId 前缀，通常是 `${session.id}-${runIndex}` */
  turnIdPrefix: string;
  runIndex: number;
  maxTurns: number;
  system: string;
  llmOptions: LLMOptions;
  provider: LLMProvider;
  toolRegistry: ToolRegistry;
  hooks: HookRunner;
  ports: PortRegistry;
  workDir: string;
  logger: Logger;
  askQuestion(req: AskQuestionRequest): Promise<AskQuestionResponse>;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  /** 本 run 待发出的首轮 lead messages（通常是刚 append 的 userMsg）。 */
  pendingLeadMessages: Message[];
  // 树操作以回调形式注入，Session 继续独占树状态。
  appendNode(msg: Message): void;
  currentHeadId(): string | null;
  pathToHead(): Message[];
  snapshotCheckpoint(turnId: string): Promise<Ref>;
  persistTurn(record: TurnRecord): Promise<void>;
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
 * 只通过回调驱动 —— 调用方（Session）继续独占树状态。
 */
export async function runTurnLoop(params: RunTurnLoopParams): Promise<RunTurnLoopResult> {
  const {
    turnIdPrefix,
    runIndex,
    maxTurns,
    system,
    llmOptions,
    provider,
    toolRegistry,
    hooks,
    ports,
    workDir,
    logger,
    askQuestion,
    signal,
    emit,
    appendNode,
    currentHeadId,
    pathToHead,
    snapshotCheckpoint,
    persistTurn,
    getSteeringMessages,
  } = params;

  const turnIds: string[] = [];
  let turnIndex = 0;
  let pendingLeadMessages = params.pendingLeadMessages;
  let runError: string | undefined;

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
    const anchorNodeId = currentHeadId();
    const checkpointRef = await snapshotCheckpoint(turnId);
    emit({ type: "turn_start", turnId });

    let streamed: Awaited<ReturnType<typeof streamAssistant>>;
    try {
      streamed = await streamAssistant({
        provider,
        messages: pathToHead(),
        tools: toolRegistry.list(),
        llmOptions,
        system,
        signal,
        turnId,
        logger,
        emit,
      });
    } catch (err) {
      // 中断导致的流异常（AbortError）视为正常停止，不向上抛
      if (signal.aborted) break;
      throw err;
    }
    const { assistantMsg, toolUseBlocks, streamError, parseErrorIds } = streamed;
    assistantMsg.turnId = turnId;

    // Bug 7：只有非空 assistant 消息才入树/持久化，避免 content:[] 触发下游 API 报错。
    // thinking 块不算有效正文——只思考不回答/不调工具视为空轮，不入树（N3：丢弃 + 本 run 正常结束，不重试）。
    const turnMessages: Message[] = [...pendingLeadMessages];
    pendingLeadMessages = [];
    const assistantHasContent =
      Array.isArray(assistantMsg.content) && assistantMsg.content.some((b) => b.type !== "thinking");
    if (assistantHasContent) {
      appendNode(assistantMsg);
      turnMessages.push(assistantMsg);
    }

    // Bug 3：LLM 流中途报错 → 优雅结束本 run（保证 agent_end 一定 emit、路径一致），不 throw。
    if (streamError) {
      await persistTurn({ turnId, runIndex, turnIndex, checkpointRef, anchorNodeId, messages: turnMessages });
      emit({ type: "turn_end", turnId, toolResults: [] });
      runError = streamError;
      break;
    }

    if (toolUseBlocks.length > 0) {
      const toolCtx = { workDir, logger, ports, askQuestion, signal };
      const { toolResultMsg, records } = await executeTools({
        turnId,
        toolUseBlocks,
        parseErrorIds,
        toolRegistry,
        hooks,
        toolCtx,
        emit,
      });
      appendNode(toolResultMsg);
      turnMessages.push(toolResultMsg);
      await persistTurn({ turnId, runIndex, turnIndex, checkpointRef, anchorNodeId, messages: turnMessages });
      emit({ type: "turn_end", turnId, toolResults: records });
      turnIndex++;
      continue; // 下一个 turn，把工具结果喂回 LLM
    }

    // 无工具调用：走 Stop hook 判断是否强制继续
    const stopDecision = await hooks.runStop({ turnCount: turnIndex + 1 });
    if (stopDecision.block && stopDecision.message) {
      const injected: Message = { id: uid("msg"), role: "user", content: stopDecision.message, turnId };
      appendNode(injected);
      turnMessages.push(injected);
      pendingLeadMessages = [injected];
      await persistTurn({ turnId, runIndex, turnIndex, checkpointRef, anchorNodeId, messages: turnMessages });
      emit({ type: "turn_end", turnId, toolResults: [] });
      turnIndex++;
      continue;
    }

    await persistTurn({ turnId, runIndex, turnIndex, checkpointRef, anchorNodeId, messages: turnMessages });
    emit({ type: "turn_end", turnId, toolResults: [] });
    break;
  }

  return { turnIds, runError, reachedMaxTurns: turnIndex >= maxTurns };
}
