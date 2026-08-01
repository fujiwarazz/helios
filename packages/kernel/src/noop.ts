// 降级 = 内置 no-op 实现。装配层在 manifest 未提供该 Port 时自动兜底注册，
// 使 chatLoop / callTool 永远直接调用接口方法，不写 `if (port)` 判断。
// 例外：LLMProvider 与 FileSystemPort 是"必须实现"的 Port，无 no-op 兜底。
import type {
  MemoryPort,
  MultiAgentPort,
  CompactStrategyPort,
  CheckpointPort,
  MemoryEntry,
  AgentSpec,
  ConversationState,
  Message,
  Summary,
  Ref,
  Disposable,
} from "@helios/ports";

export const NoopMemory: MemoryPort = {
  async recall(): Promise<string> {
    return "";
  },
  async remember(_entry: MemoryEntry): Promise<void> {
    // 空实现：不持久化
  },
};

export class MultiAgentNotEnabledError extends Error {
  readonly code = "MULTI_AGENT_NOT_ENABLED";
  constructor() {
    super("多智能体能力未启用（未加载任何 MultiAgentPort 实现）");
    this.name = "MultiAgentNotEnabledError";
  }
}

export const NoopMultiAgent: MultiAgentPort = {
  async spawn(_spec: AgentSpec) {
    throw new MultiAgentNotEnabledError();
  },
  async send() {
    throw new MultiAgentNotEnabledError();
  },
  onMessage(): Disposable {
    return { dispose() {} };
  },
};

export const NoopCompact: CompactStrategyPort = {
  shouldCompact(_state: ConversationState): boolean {
    return false;
  },
  async compact(_messages: Message[]): Promise<Summary> {
    return { text: "", coveredMessageIds: [] };
  },
};

export const NoopCheckpoint: CheckpointPort = {
  async snapshot(turnId: string): Promise<Ref> {
    // 无文件快照：返回一个仅标记 turnId 的空引用，restore 时无操作
    return { kind: "fs", value: `noop:${turnId}` };
  },
  async restore(_ref: Ref): Promise<void> {
    // 空实现：回溯只截断对话历史，不还原文件
  },
};
