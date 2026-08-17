import type { Message, StreamEvent, StopReason, Role, TaskCostReport, ToolRenderDescriptor } from "@helios/ports";

/** 分层事件协议：agent_start → (turn_start → message_* → tool_execution_* → turn_end)+ → agent_end */
export type AgentEvent =
  | { type: "agent_start"; runId: string }
  | { type: "turn_start"; turnId: string }
  | { type: "message_start"; messageId: string; role: Role; turnId: string }
  | { type: "message_update"; messageId: string; delta: StreamEvent }
  | { type: "message_end"; messageId: string; role: Role; stopReason?: StopReason }
  /**
   * `input` 语义按路径分层（兼容现有事件协议的临时约定，长期应拆成 `requestedInput`/
   * `effectiveInput?` 两个字段，消除同名字段双语义）：
   * - 正常执行路径：PreToolUse 改写后的最终执行输入；
   * - deny / ask-reject / parse-error 三条路径：模型原始请求输入——这些调用从未真正执行，
   *   不存在"最终生效输入"这个概念。
   */
  | { type: "tool_execution_start"; toolUseId: string; name: string; input: unknown }
  | {
      type: "tool_execution_end";
      toolUseId: string;
      output: unknown;
      isError: boolean;
      /**
       * 服务端算好的渲染描述符（由 host 用 kernel.getRenderer(name) 命中 CapabilityProvider
       * 注册的 ToolRenderer 算出）。有值时消费端应优先使用；未命中（该工具没注册渲染器）时
       * 为 undefined，由消费端走本地通用兜底。不是所有事件来源都会填充此字段（如历史重放）。
       */
      descriptor?: ToolRenderDescriptor;
    }
  | { type: "turn_end"; turnId: string; toolResults: ToolResultRecord[] }
  /** LLM 调用命中可重试错误、即将 backoff 重试（issue #10）；供消费方感知"正在重试"、可选择丢弃上一次失败 attempt 的部分渲染。 */
  | { type: "llm_retry"; turnId: string; retryCount: number; delayMs: number; httpStatus?: number }
  | { type: "compact_start"; messageCount: number }
  /**
   * 压缩收尾。`status` 区分四种结局，消费端据此决定要不要提示用户：
   * - `ok`：装了 summary 节点
   * - `skipped`：无可安全压缩，或用户主动取消 —— 正常状态，不必提示
   * - `failed`：摘要调用失败/产物不可用；本次**什么都没改写**，历史与缓存完好
   * - `blocked`：已连续失败达上限，本会话暂停自动压缩（本次未发请求）
   *
   * 无论何种 status，消费端都必须复位"压缩进行中"的 UI 状态。
   */
  | {
      type: "compact_end";
      summaryLength: number;
      remaining: number;
      status: "ok" | "skipped" | "failed" | "blocked";
      reason?: string;
    }
  | { type: "rollback"; turnId: string; historyLength: number }
  | {
      type: "artifact_action";
      action: "openDiff";
      sessionId: string;
      workspaceId: string;
      rootId: string;
      relativePath: string;
      before?: string;
      after?: string;
    }
  | { type: "head_changed"; headId: string | null }
  | {
      type: "agent_end";
      runId: string;
      turnIds: string[];
      newMessages: Message[];
      /** run 因 LLM 流错误优雅终止时的错误信息（Bug 3）；正常结束时为 undefined */
      error?: string;
      /** run 因达到 turn 上限而提前结束（Bug 5）；自然结束时为 undefined */
      reachedMaxTurns?: boolean;
      /** 本 run 的成本报告（CostMeter 产出；noop 时为全零报告）。 */
      costReport?: TaskCostReport;
    };

export interface ToolResultRecord {
  toolUseId: string;
  name: string;
  output: unknown;
  isError: boolean;
}

export type AgentEventListener = (event: AgentEvent) => void;

/**
 * agentLoop 内部（streamAssistant/executeTools/runTurnLoop）发事件的统一出口。
 * 包一层接口而不是裸传 `(event: AgentEvent) => void`：调用方（Session）之外的实现可以在不
 * 改变任何函数签名的前提下扩展行为（比如缓冲、去重、按 scope 过滤），CR 意见对齐 valos 的做法。
 */
export interface AgentEventEmitter {
  emit(event: AgentEvent): void;
}
