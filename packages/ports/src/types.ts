// ============================================================================
// packages/ports/src/types.ts
// 跨 Port 复用的数据结构单一真源。任何出现在某个 Port 方法签名里的类型，
// 都必须住在这里，实现包只 `import type`，绝不重新声明。
// ============================================================================

export interface Disposable {
  dispose(): void;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// 消息与内容块
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "toolResult";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; output: unknown; isError?: boolean };

export interface Message {
  id: string;
  role: Role;
  /** 简单文本或结构化内容块序列 */
  content: string | ContentBlock[];
  /** 归属的 turn；用户首条 system/user 消息可无 */
  turnId?: string;
  /**
   * 消息树中的父节点 id；null = 根。可选以兼容老数据/直接构造的 Message
   * （Session 内部会在 appendNode 时按当前 HEAD 补齐）。
   */
  parentId?: string | null;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 极简 JSON Schema 描述（仅用于告知 LLM 入参形状） */
export interface JSONSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export type ToolStatus = "pending" | "running" | "success" | "error";

export interface ToolResult {
  output: unknown;
  isError?: boolean;
}

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestionRequest {
  question: string;
  header?: string;
  options?: AskQuestionOption[];
  multiSelect?: boolean;
}

export interface AskQuestionResponse {
  answers: string[];
}

/** 工具执行时可用的运行时上下文（区别于插件装配期的 KernelContext） */
export interface ToolContext {
  workDir: string;
  logger: Logger;
  ports: PortRegistry;
  signal?: AbortSignal;
  askQuestion(req: AskQuestionRequest): Promise<AskQuestionResponse>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// LLM 流式事件（Anthropic / OpenAI 归一化后的内部统一协议）
// ---------------------------------------------------------------------------

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop";

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call-start"; id: string; name: string }
  | { type: "tool-call-delta"; id: string; argsDelta: string }
  | { type: "tool-call-end"; id: string }
  | { type: "message-stop"; stopReason: StopReason }
  | { type: "error"; error: string };

export interface LLMOptions {
  /** 选用哪个已注册的 provider（多实例 Port），缺省用第一个 */
  provider?: string;
  model?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Memory / MultiAgent / Compact / Checkpoint 的共享数据结构
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  key?: string;
  text: string;
  tags?: string[];
  ts: number;
}

export interface AgentSpec {
  name: string;
  role?: string;
  prompt: string;
  model?: string;
}

export interface AgentHandle {
  id: string;
  name: string;
}

export interface AgentMessage {
  from: string;
  to: string;
  type: string;
  payload: unknown;
  ts: number;
}

/** compact 产物 */
export interface Summary {
  text: string;
  coveredMessageIds: string[];
}

/** checkpoint 快照引用 */
export interface Ref {
  kind: "git" | "fs" | string;
  value: string;
}

export interface ConversationState {
  messages: Message[];
  /** 近似 token 估算（chars/4 等），供 shouldCompact 判断 */
  approxTokens: number;
}

// ---------------------------------------------------------------------------
// Hook 绑定（P0 仅 3 个事件）
// ---------------------------------------------------------------------------

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop";

export interface PreToolUsePayload {
  toolName: string;
  input: unknown;
}
export interface PreToolUseDecision {
  decision: "allow" | "deny" | "ask";
  /** 允许时可改写入参 */
  input?: unknown;
  reason?: string;
}

export interface PostToolUsePayload {
  toolName: string;
  input: unknown;
  output: unknown;
  isError?: boolean;
}
export interface PostToolUseDecision {
  block?: boolean;
  /** 可改写/追加输出 */
  output?: unknown;
  reason?: string;
}

export interface StopPayload {
  turnCount: number;
}
export interface StopDecision {
  block?: boolean;
  /** block 时追加给 LLM 的消息，逼迫其继续 */
  message?: string;
}

export type HookBinding =
  | {
      event: "PreToolUse";
      handler: (
        p: PreToolUsePayload,
      ) => PreToolUseDecision | void | Promise<PreToolUseDecision | void>;
    }
  | {
      event: "PostToolUse";
      handler: (
        p: PostToolUsePayload,
      ) => PostToolUseDecision | void | Promise<PostToolUseDecision | void>;
    }
  | {
      event: "Stop";
      handler: (
        p: StopPayload,
      ) => StopDecision | void | Promise<StopDecision | void>;
    };

// ---------------------------------------------------------------------------
// 插件装配上下文
// ---------------------------------------------------------------------------

/**
 * 装配期传给每个插件 `create(ctx)` 的上下文。
 * `ports` 暴露"已注册的其他 Port 只读句柄"——按 manifest 声明顺序，
 * 后加载的插件可拿到前面已注册的实现，否则拿到 no-op 兜底。
 */
export interface KernelContext {
  workDir: string;
  logger: Logger;
  ports: PortRegistry;
  options?: Record<string, unknown>;
}

/** 已注册 Port 的只读句柄集合。因 no-op 兜底，字段永远非空。 */
export interface PortRegistry {
  fileSystem: import("./filesystem").FileSystemPort;
  memory: import("./memory").MemoryPort;
  multiAgent: import("./multiAgent").MultiAgentPort;
  compact: import("./compact").CompactStrategyPort;
  checkpoint: import("./checkpoint").CheckpointPort;
  llm: LLMRegistry;
}

/** 多实例 LLMProvider 的运行时选用入口 */
export interface LLMRegistry {
  /** 按 provider id 取，缺省取第一个已注册的 */
  get(provider?: string): import("./llm").LLMProvider;
  list(): string[];
}

/** 插件模块统一导出形状 */
export interface PluginModule<T = unknown> {
  apiVersion: number;
  create(ctx: KernelContext): T | Promise<T>;
}
