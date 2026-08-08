// ============================================================================
// packages/ui-chat/src/types.ts
// ui-chat 只依赖 IChatClient 接口,不感知 RPC/传输 —— 便于 mock 测试,
// 也让 ui-chat 可被同进程宿主(直接包 Session)或跨进程宿主(RpcChatClient)复用。
// ============================================================================

import type { AgentEvent } from "@helios/kernel";
import type { Message, ToolStatus, ToolRenderDescriptor } from "@helios/ports";

/** 连接状态。同进程实现可恒为 "open";跨进程(RpcChatClient)反映真实 WS 状态。 */
export type ConnectionState = "connecting" | "open" | "closed";

/**
 * ui-chat 与后端会话交互的唯一契约。
 * 实现可以是:RpcChatClient(跨进程,走 protocol) / 直接包 Session 的同进程适配器 / 测试 mock。
 */
export interface IChatClient {
  /** 拉取历史消息,用于挂载时重建视图。 */
  getHistory(): Promise<Message[]>;
  /** 发送一条用户消息,驱动一个 run。resolve 时机由实现决定(通常是 run 已受理,不等跑完)。 */
  sendMessage(text: string): Promise<void>;
  /** 订阅会话事件流(AgentEvent 原样透传)。返回取消订阅函数。 */
  onEvent(cb: (e: AgentEvent) => void): () => void;
  /**
   * 订阅连接状态。跨进程 UI 必须能显示"连接中/已断开",否则断网时界面毫无反馈。
   * 可选:同进程实现可不提供(视为恒 "open")。
   */
  onState?(cb: (s: ConnectionState) => void): () => void;
  /** 回溯到某 turn(可选:后端支持才提供)。 */
  rollback?(turnId: string): Promise<void>;
  /** 中断当前 run(可选:后端支持才提供,对应 Stop 按钮)。 */
  cancel?(): Promise<void>;
  /** 订阅工具审批提问(AskUserQuestion)。返回取消订阅函数。可选:后端支持才提供。 */
  onAsk?(cb: (q: AskQuestion) => void): () => void;
  /** 回传审批答案，解阻塞对应的 AskUserQuestion 工具。 */
  answer?(questionId: string, answers: string[]): Promise<void>;
}

/** 一次工具审批提问（后端 AskUserQuestion 工具发起，前端渲染卡片让用户选）。 */
export interface AskQuestion {
  questionId: string;
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

// --- 视图模型(useChat 把 AgentEvent 归并成这些,ChatView 只画这些)---

export interface ToolCallView {
  id: string;
  name: string;
  status: ToolStatus;
  /** 来自 ToolRenderer 的结构化描述;无则 ChatView 走通用兜底。 */
  descriptor?: ToolRenderDescriptor;
}

export interface ChatMessageView {
  id: string;
  role: Message["role"];
  text: string;
  /** 扩展思考内容（thinking-delta 累积）；无则不渲染思考块。 */
  thinking?: string;
  tools: ToolCallView[];
  /** 该消息所属 turn（仅 assistant 消息有）。 */
  turnId?: string;
  /**
   * 是否为一个 run（= 一次用户输入对应的完整输出，可含多个 turn）的结束边界。
   * 仅该 run 最后一条 assistant 消息置位，用于渲染唯一的"从这里重新开始"入口。
   */
  isRunBoundary?: boolean;
  /**
   * 回溯目标 turnId = 该 run 的第一个 turn。点回溯即 rollback 到这次用户输入之前。
   * 仅 isRunBoundary 的消息带此字段。
   */
  rollbackTurnId?: string;
}
