// @helios/kernel —— 内核：装配层 + chatLoop + 事件协议。只依赖 @helios/ports。
export { Kernel } from "./kernel";
export type {
  ArtifactAction,
  FileEditObservation,
  KernelOptions,
  CreateSessionOptions,
  PortInfo,
} from "./kernel";
export { Session, SessionBusyError } from "./session";
export type { KernelSessionMeta, SessionOptions, SessionMeta, BranchInfo } from "./session";
// 持久化 schema 校验/JSONL 解析的单一真源，供 @helios/workspace 复用（依赖方向 workspace → kernel）。
export {
  parseJsonLines,
  assertSchemaVersion1,
  isPlainObject,
  UnsupportedSchemaVersionError,
} from "./persistence/schema";
export type { ParseJsonLinesOptions } from "./persistence/schema";
export { replaySessionLog, SESSION_LOG_FILE } from "./persistence/sessionLog";
export type { SessionLogEntry, ReplayResult } from "./persistence/sessionLog";
export { ServiceCollection, createServiceToken } from "./serviceCollection";
export type { ServiceToken } from "./serviceCollection";
export {
  IFileSystemPort,
  IMemoryPort,
  IMultiAgentPort,
  ICompactPort,
  ICheckpointPort,
} from "./tokens";
export { ToolRegistry } from "./toolRegistry";
export { HookRunner } from "./hookRunner";
export { loadPlugins } from "./pluginLoader";
export type { Manifest, PluginEntry, PortName, LoadResult, PackageResolver } from "./pluginLoader";
export { LiveLLMRegistry, createLivePortRegistry } from "./portRegistry";
export {
  NoopMemory,
  NoopMultiAgent,
  NoopCompact,
  NoopCheckpoint,
  MultiAgentNotEnabledError,
} from "./noop";
export { builtinCapabilityProvider } from "./builtin/provider";
export {
  createBuiltinTools,
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createWebFetchTool,
  createAskQuestionTool,
  createTaskTool,
} from "./builtin/tools";
export type { AgentEvent, AgentEventListener, ToolResultRecord } from "./events";
export { uid } from "./ids";
export { LlmProviderError, normalizeLlmError } from "./errors";
export { DEFAULT_LLM_RETRY, computeRetryDelayMs, realSleep } from "./agentLoop/retryBackoff";
export type { LlmRetryOptions } from "./agentLoop/retryBackoff";
