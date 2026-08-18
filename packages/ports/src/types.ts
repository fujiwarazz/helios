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
  | { type: "thinking"; thinking: string; signature?: string }
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
  /**
   * 仅压缩摘要节点带此字段，其存在本身即「这是 summary 节点」的标记。
   * summary 是树上的真实节点（parent = 压缩时的 HEAD），因此它在链上的位置天然
   * 决定作用域：兄弟分支的祖先链里没有它，压缩不会误伤。
   * `firstKeptId` = 保留 tail 的首节点 id（其及其之下保留，更早的被 summary 取代）；
   * 全覆盖时为 null。缺省来源：普通消息本就没有压缩语义。
   */
  compaction?: { firstKeptId: string | null };
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

/**
 * 工具执行时可用的运行时上下文（区别于插件装配期的 KernelContext）。
 * 只放"所有工具天然都需要"的环境级能力（工作目录/日志/中断信号/人工提问）——
 * 业务能力（文件系统、多智能体等具体 Port）不放在这里，而是由注册方在构造工具时
 * 按需以闭包形式注入给该工具自己（接口隔离：拿不到的能力不会出现在共享上下文里，
 * 不是"声明了就信任"的运行时校验，是结构上摸不到）。参考 `capability-fs` 的
 * `create(ctx) → new FsCapability(ctx.ports.fileSystem)` 与 `builtin/tools.ts` 的
 * `createReadTool(fileSystem)` 工厂函数模式。
 */
export interface ToolContext {
  workDir: string;
  logger: Logger;
  signal?: AbortSignal;
  askQuestion(req: AskQuestionRequest): Promise<AskQuestionResponse>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  /**
   * 执行模式：'parallel' 表示该工具无副作用/可与同批次其它 parallel 工具并发执行；
   * 缺省（undefined）视为 sequential —— 与现状行为一致（零破坏默认值）。只要本批
   * tool_use 中有任一工具非 parallel，整批退化为顺序执行（详见 executeTools）。
   */
  executionMode?: "sequential" | "parallel";
  fileMutations?: (input: unknown) => Array<{
    path: string;
    operationHint: "write" | "edit" | "delete";
  }>;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  // --- ToolResultCache 元数据（opt-in，默认不缓存；见 docs/cost-optimization-layer.md §1.2）---
  /** 声明该工具结果可缓存。默认 undefined = 不缓存（安全优先）。 */
  cacheable?: boolean;
  /** 复用范围，默认 "run"（最安全）。 */
  cacheScope?: "run" | "session" | "global";
  /** global/session 缓存的过期时间；缺省不过期。 */
  cacheTtlMs?: number;
  /**
   * 声明"缓存 key 应带版本"，但 Tool 不自己算版本——由 runtime 的 VersionProvider 按 kind 注入。
   * workspace→snapshot hash（文件被 Edit 后自然 miss）；url→内容 revision；index→语义索引版本。
   */
  cacheVersionKind?: "workspace" | "url" | "index";
}

// ---------------------------------------------------------------------------
// LLM 流式事件（Anthropic / OpenAI 归一化后的内部统一协议）
// ---------------------------------------------------------------------------

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop";

/**
 * 一次 LLM 调用的 token 用量（provider 归一化后）。字段名把语义编进类型以消歧义：
 * 不同 provider 的 `input_tokens` 含义不一致，故用 `uncachedInputTokens`（= cache miss 的计费输入）。
 * 见 docs/cost-optimization-layer.md §1.1。
 */
export interface Usage {
  /** 计费的未缓存输入（cache miss 部分）。 */
  uncachedInputTokens: number;
  /** 命中缓存的输入（cache read，读价更低）。 */
  cachedInputTokens: number;
  /**
   * 写缓存（cache creation）。**这是 prompt 的一部分**，只是按缓存写入价计费 ——
   * Anthropic 的口径是 `total_input = cache_read + cache_creation + input_tokens`，
   * 三者互不重叠。所以估算 context length 时必须把它加上，否则会话首轮
   * （cache_read=0、整段历史全落在 cache_creation）算出来的上下文会严重偏小。
   */
  cacheWriteTokens: number;
  outputTokens: number;
  /**
   * provider 明确给出的实际 prompt token 数（权威值）；不给时按
   * `uncached + cached + cacheWrite` 估算。
   *
   * 只有部分 provider 提供：`llm-openai` 填 `prompt_tokens`，`llm-anthropic` 不填
   * （Anthropic 不返回单一总数，需由三个分项相加）。
   */
  promptTokens?: number;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  /** 思考正文增量（Anthropic thinking_delta / OpenAI 协议 reasoning_content 归一化后）。 */
  | { type: "thinking-delta"; text: string }
  /** Anthropic thinking 块的完整性签名；回传该轮 thinking 块时必需，其它厂商无此事件。 */
  | { type: "thinking-signature"; signature: string }
  | { type: "tool-call-start"; id: string; name: string }
  | { type: "tool-call-delta"; id: string; argsDelta: string }
  | { type: "tool-call-end"; id: string }
  /** 结束事件；usage 由 provider 归一化后携带，CostMeter 据此计量（缺省则无计量）。 */
  | { type: "message-stop"; stopReason: StopReason; usage?: Usage }
  /**
   * LLMProvider 只在捕获到 SDK 的 APIError（及其子类，涵盖 HTTP 状态码错误/连接类错误）时才产出
   * 这个事件——是"预期错误"的 Result 通道；非 APIError 的异常（我们自己代码的 bug）不落这里，
   * 原样 throw 穿透（见 runTurnLoop.ts 的 normalizeLlmError）。
   * `retryable`/`httpStatus`/`retryAfterMs` 由各 provider 按 SDK 错误对象填充；`code` 预留给后续
   * 更细的错误语义分类（如 "rate_limited"/"overloaded"），本次两个 provider 都不填。
   */
  | { type: "error"; error: string; retryable?: boolean; httpStatus?: number; retryAfterMs?: number; code?: string };

export interface LLMOptions {
  /** 选用哪个已注册的 provider（多实例 Port），缺省用第一个 */
  provider?: string;
  model?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * 扩展思考（extended thinking / reasoning）开关。由 provider 侧决定如何落地：
   * Anthropic 转成 thinking 请求参数（与 temperature 互斥）；OpenAI 协议后端目前忽略
   * （是否吐 reasoning 由后端默认策略决定）。
   */
  thinking?: { enabled: boolean; budgetTokens?: number };
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
// Hook 绑定（覆盖完整 agent cycle：SessionStart → UserPromptSubmit → PreToolUse
// → PostToolUse → Stop → SessionEnd）
// ---------------------------------------------------------------------------

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionEnd";

export interface SessionStartPayload {
  sessionId: string;
  workDir: string;
  /** 对齐 valos：'startup' = 全新会话，'resume' = session.restore() 命中历史会话 */
  source: "startup" | "resume";
}
export interface SessionStartDecision {
  /** 追加注入 system 的上下文；会话级，只在首次生效并随 systemPrefix 一起冻结 */
  additionalContext?: string;
}

export interface UserPromptSubmitPayload {
  sessionId: string;
  text: string;
}
export interface UserPromptSubmitDecision {
  block?: boolean;
  reason?: string;
  /** 允许时可改写用户文本（覆盖，最后一个非 undefined 生效） */
  text?: string;
  /** 追加注入 system 的上下文（不改写原文本；多个 handler 结果按 \n 拼接） */
  additionalContext?: string;
}

export interface PreToolUsePayload {
  sessionId: string;
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
  sessionId: string;
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
  sessionId: string;
  turnCount: number;
}
export interface StopDecision {
  block?: boolean;
  /** block 时追加给 LLM 的消息，逼迫其继续 */
  message?: string;
}

export interface SessionEndPayload {
  sessionId: string;
  workDir: string;
}
// SessionEnd 是纯通知型事件（清理/审计用途），无 Decision，handler 无返回值语义

export type HookBinding =
  | {
      event: "SessionStart";
      handler: (
        p: SessionStartPayload,
      ) => SessionStartDecision | void | Promise<SessionStartDecision | void>;
    }
  | {
      event: "UserPromptSubmit";
      handler: (
        p: UserPromptSubmitPayload,
      ) => UserPromptSubmitDecision | void | Promise<UserPromptSubmitDecision | void>;
    }
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
    }
  | {
      event: "SessionEnd";
      handler: (p: SessionEndPayload) => void | Promise<void>;
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
  // --- Cost-aware Runtime（均有 noop 兜底，缺失不影响 kernel 运行）---
  modelRouter: import("./modelRouter").ModelRouterPort;
  costMeter: import("./costMeter").CostMeterPort;
  toolCache: import("./toolResultCache").ToolResultCachePort;
  versionProvider: import("./versionProvider").VersionProviderPort;
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
