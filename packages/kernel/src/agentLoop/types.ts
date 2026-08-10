import type {
  ContentBlock,
  Message,
  Ref,
  Logger,
  LLMProvider,
  LLMRegistry,
  AskQuestionRequest,
  AskQuestionResponse,
  Runtime,
} from "@helios/ports";
import type { ToolRegistry } from "../toolRegistry";
import type { HookRunner } from "../hookRunner";
import type { AgentEventEmitter } from "../events";
import type { LlmRetryOptions } from "./retryBackoff";

/** tool_use 内容块的类型别名，供 streamAssistant/executeTools 共用，避免重复 Extract<...>。 */
export type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

/** 单个 turn 的持久化记录，Session（turns.jsonl）与 runTurnLoop 共用同一形状。 */
export interface TurnRecord {
  turnId: string;
  runIndex: number;
  turnIndex: number;
  checkpointRef: Ref;
  /**
   * turn 快照时刻的 HEAD 节点 id（回溯锚点，指向本 turn assistant 之前的节点）。
   * 取代旧的 historyLenBefore：树化后按节点 id 定位比数组下标更稳。
   */
  anchorNodeId: string | null;
  messages: Message[];
}

/**
 * turn 循环运行所需的基础设施依赖：run 期间不变、与"这一次具体跑什么"无关。
 * 与 {@link SessionTreeCallbacks}（树状态操作面）分层，避免一个params接口把两类
 * 完全不同性质的东西摊平在一起（CR 意见：RunTurnLoopParams 太杂乱，没做分层）。
 */
export interface RunLoopDeps {
  provider: LLMProvider;
  toolRegistry: ToolRegistry;
  hooks: HookRunner;
  /** 贯穿所有 hook payload 的公共字段，对齐 valos HookBaseStdin。 */
  sessionId: string;
  workDir: string;
  logger: Logger;
  askQuestion(req: AskQuestionRequest): Promise<AskQuestionResponse>;
  signal: AbortSignal;
  events: AgentEventEmitter;
  // --- Cost-aware Runtime（数组，元素粘合自已装配的 Port；空数组即等价关闭该能力）---
  /** loop 在固定挂载点分发（onTurnStart/onLLMResponse/onBeforeTool/onAfterTool/onRunEnd），
   * 不关心数组里具体是什么、有几个（见 CostAwareRuntime + runtimeDispatch）。 */
  runtimes: Runtime[];
  /** 按 ModelRouter 决策 provider 解析实际 LLMProvider（跨 provider 切换时用）。 */
  llmRegistry: LLMRegistry;
  /** LLM 调用重试策略；缺省用 {@link DEFAULT_LLM_RETRY}（issue #10）。 */
  llmRetry?: LlmRetryOptions;
  /** 重试等待的注入点，测试可传瞬时 resolve 避免真实等待；缺省用 {@link realSleep}。 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 上下文预算可观测性阈值（估算 token 数）：run 中途 message path 估算值超过该阈值时记录一次
   * warning（不触发压缩，纯观察）。不传则不检查，默认关闭。见 {@link ./contextBudget.ts}。
   */
  contextBudgetWarnTokens?: number;
}

/**
 * Session 消息树的操作面：runTurnLoop 只通过这几个回调驱动树变更，
 * 不持有、不感知树内部状态（nodes/headId/compactions 继续独占在 Session 里）。
 */
export interface SessionTreeCallbacks {
  appendNode(msg: Message): void;
  currentHeadId(): string | null;
  pathToHead(): Message[];
  snapshotCheckpoint(turnId: string): Promise<Ref>;
  persistTurn(record: TurnRecord): Promise<void>;
}
