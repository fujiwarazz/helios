// ModelRouterPort —— 降本杠杆：每个 turn 调一次，按任务特征选 provider+model+参数。
// 见 docs/cost-optimization-layer.md 二。内部实现可拆 Strategy + Policy，但 Port 只暴露 route()。
import type { LLMOptions, Message, Tool } from "./types";

export const MODEL_ROUTER_PORT_API_VERSION = 1;

/** kernel 每轮采集的难度信号（判断逻辑全在 router 实现里）。 */
export interface RouteSignals {
  contextTokens: number;
  toolUseCountSoFar: number;
  lastTurnHadError: boolean; // 上轮工具报错
  lastTurnParseError: boolean; // 上轮工具入参解析失败
  retriedLastTurn: boolean;
  repeatedToolCall: boolean; // 连续同名同参工具 = 打转
}

/** 廉价上下文统计，替代传完整 messages/tools/system（降本层别自己产生序列化开销）。 */
export interface RouteContextStats {
  inputTokens: number;
  toolCount: number;
  messageCount: number;
  hasCode: boolean;
  /** 预期输出规模粗档：成本≈input+output，coding agent output 常是大头。 */
  expectedOutput?: "short" | "medium" | "long";
}

export interface RouteContext {
  sessionId: string;
  turnIndex: number;
  /** 用途分档，如 "main" | "compact" | "recall" | "title" | "classify"。 */
  purpose?: string;
  signals: RouteSignals;
  contextStats: RouteContextStats;
  /** agent 经 request_model_change 请求、经 Policy 批准后写入的本 run 锁定档位（最高优先级）。 */
  agentOverride?: { provider?: string; model?: string };
  /** 仅高级 router 需要完整内容时按需提供，默认不传（避免每轮遍历大 context）。 */
  content?: { system: string; messages: Message[]; tools: Tool[] };
}

export interface RouteDecision {
  provider?: string; // 覆盖 LLMOptions.provider
  model?: string; // 覆盖 LLMOptions.model
  thinking?: LLMOptions["thinking"];
  maxTokens?: number;
}

export interface ModelRouterPort {
  route(ctx: RouteContext): RouteDecision | Promise<RouteDecision>;
}
