import type {
  ModelRouterPort,
  RouteContext,
  RouteDecision,
  KernelContext,
} from "@helios/ports";
import { MODEL_ROUTER_PORT_API_VERSION } from "@helios/ports";

// @helios/router-default —— ModelRouterPort 官方实现，内部拆 Strategy + Policy。
// Strategy：purpose/难度/棘轮 → Tier（0/1/2）→ model 映射（+ Model Affinity）。
// Policy：升档次数上限（棘轮防横跳）。预算天花板需 runId+CostMeter，列为后续（见 doc §2.4）。
// 见 docs/cost-optimization-layer.md 二。

export interface RouterOptions {
  /** 首选 provider（Model Affinity）：能不跨 provider 就不跨。缺省不覆盖 provider。 */
  provider?: string;
  /** tier→model 映射表；模型名只出现在这里（禁止业务逻辑硬编码）。缺省则不覆盖 model。 */
  tiers?: [string, string, string];
  /** 归到 tier 0 便宜档的辅助用途。 */
  auxPurposes?: string[];
  /** 难度按 contextTokens 的两个边界：< low → tier0 候选；> high → tier2。 */
  contextThresholds?: [number, number];
  /** 本 run 升档次数上限（棘轮）。 */
  maxEscalations?: number;
}

const DEFAULT_AUX = ["compact", "recall", "title", "classify"];
const DEFAULT_THRESHOLDS: [number, number] = [4_000, 30_000];
const DEFAULT_MAX_ESCALATIONS = 2;

/** 每 session 的本 run 棘轮状态：lockedTier 只增不减，新 run（turnIndex===0）重置。 */
interface RatchetState {
  lockedTier: number;
  escalations: number;
}

type Tier = 0 | 1 | 2;

class DefaultModelRouter implements ModelRouterPort {
  private readonly ratchet = new Map<string, RatchetState>();
  private readonly auxPurposes: Set<string>;
  private readonly thresholds: [number, number];
  private readonly maxEscalations: number;

  constructor(private readonly opts: RouterOptions) {
    this.auxPurposes = new Set(opts.auxPurposes ?? DEFAULT_AUX);
    this.thresholds = opts.contextThresholds ?? DEFAULT_THRESHOLDS;
    this.maxEscalations = opts.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;
  }

  route(ctx: RouteContext): RouteDecision {
    // agentOverride 最高优先级（Policy 已批准，锁定本 run）。
    if (ctx.agentOverride?.provider || ctx.agentOverride?.model) {
      return { ...ctx.agentOverride };
    }

    // 新 run 起点重置棘轮（turnIndex===0 = 新 user 消息重新起步）。
    if (ctx.turnIndex === 0) this.ratchet.set(ctx.sessionId, { lockedTier: -1, escalations: 0 });
    const state = this.ratchet.get(ctx.sessionId) ?? { lockedTier: -1, escalations: 0 };

    const baseTier = this.strategyTier(ctx);

    // 棘轮升档：失败信号 → +1（Policy 施加升档次数上限）。
    let tier = Math.max(baseTier, state.lockedTier) as Tier;
    if (this.hasFailureSignal(ctx) && tier < 2 && state.escalations < this.maxEscalations) {
      tier = (tier + 1) as Tier;
      state.escalations += 1;
    }
    state.lockedTier = tier; // 升快降慢：锁定到本 run 结束
    this.ratchet.set(ctx.sessionId, state);

    return this.mapTier(tier);
  }

  /** Strategy：purpose 分档 + 结构启发式难度 → Tier。 */
  private strategyTier(ctx: RouteContext): Tier {
    if (ctx.purpose && this.auxPurposes.has(ctx.purpose)) return 0; // 辅助任务无脑便宜档
    const { contextStats, signals } = ctx;
    const [low, high] = this.thresholds;
    if (contextStats.inputTokens > high || contextStats.expectedOutput === "long") return 2;
    if (
      contextStats.inputTokens < low &&
      signals.toolUseCountSoFar === 0 &&
      !contextStats.hasCode
    ) {
      return 0; // 无 tool_use 短输入 → 小模型
    }
    return 1;
  }

  private hasFailureSignal(ctx: RouteContext): boolean {
    const s = ctx.signals;
    return s.lastTurnHadError || s.lastTurnParseError || s.retriedLastTurn || s.repeatedToolCall;
  }

  /** Tier → provider/model：模型名只在映射表里；Model Affinity 用配置的首选 provider。 */
  private mapTier(tier: Tier): RouteDecision {
    const decision: RouteDecision = {};
    if (this.opts.provider) decision.provider = this.opts.provider;
    if (this.opts.tiers) decision.model = this.opts.tiers[tier];
    return decision;
  }
}

export const apiVersion = MODEL_ROUTER_PORT_API_VERSION;

export function create(ctx: KernelContext): ModelRouterPort {
  return new DefaultModelRouter((ctx.options ?? {}) as RouterOptions);
}

export default { apiVersion, create };
