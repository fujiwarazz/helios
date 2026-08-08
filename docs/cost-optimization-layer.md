# Cost-aware Agent Runtime：ModelRouter + CostMeter + ToolResultCache 三个 Port

> 基于 GPT 的 12 点降本清单 + 两轮 GPT review + valos 实际做法 + 市面 agent 系统通行做法，结合 helios 现有 Ports & Adapters 架构（`ports/types.ts` / `kernel/session.ts` / `LLMRegistry`）。
> 定位：不是"几个省钱小功能"，而是把 **cost 变成 runtime 一等公民**——**观测(measure) → 决策(decide) → 复用(reuse) → 反馈(feedback)**。核心指标 `Cost / Successful Task`（不是 Cost/Task，也不是单纯 Cost↓）。

---

## 〇、定位与总原则

降本能力分属**三层**，本方案只在 Cost 层新增三个 Port，其余留在各自该在的层，**不做单一"大 Cost Port"**：

```
                    Agent Kernel
                         │
       ┌─────────────────┼─────────────────┐
       ↓                 ↓                 ↓
 Context Efficiency  Execution Eff.       Cost
       │                 │                 │
 CompactStrategy    Parallel Tool     ModelRouter (Strategy+Policy)
 Prefix Stability   Tool Batching      CostMeter (measure only)
 Branch Reuse       ToolResultCache    Budget Policy
       └─────────────────┼─────────────────┘
                         ↓  旁路观察，不侵入 LLM 主路径
                      CostMeter → Cost / Successful Task
```

- **Context Efficiency 层**：`CompactStrategyPort`（已有，不动）；prefix/KV cache 与分支复用归此层的 **Branch-aware Context Reuse**（不是 Cost Port，见 §八）。
- **Execution Efficiency 层**：工具并行/批处理（kernel 循环行为，非 Port）；`ToolResultCachePort`（避免重复工作）。
- **Cost 层（本方案新增 Port）**：`ModelRouterPort`（内部拆 Strategy+Policy，降本决策）、`CostMeterPort`（只做测量，不做 policy）。
- 后置/默认关：`SemanticCachePort`（正确性风险高，本期不做）。

Port 合格线（沿用 helios 铁律）：窄接口 + 实现可替换 + 无特权路径 + kernel 只依赖接口 + noop 兜底。

> 关键分工（GPT review 收敛）：**CostMeter 负责 measurement，ModelRouter 的 Policy 负责 governance**——测量与策略分离，避免 CostMeter 越权做决策。

---

## 一、前置改造（必要，两处）

### 1.1 usage 信号（CostMeter 的前提）

现状 `StreamEvent`（`ports/types.ts`）的 `message-stop` 只带 `stopReason`，**不带 token 用量**，无法算成本。改造：

**必须区分「计费输入」与「真实上下文长度」两个概念**（GPT review P0-1）：不同 provider 的 `input_tokens` 语义不一致——Anthropic 的 `input_tokens` 只是**未命中缓存的输入**，命中部分单列，若直接当 context length 会系统性少算（如 50k 上下文命中 45k → input_tokens 只有 5k，但真实上下文是 50k）。

**字段名把语义编进类型**（GPT review 2 #①）：不叫 `inputTokens`（在 OpenAI/Anthropic 语义不一致，看不出是全部/billable/miss），直接 `uncachedInputTokens`。

```ts
export interface Usage {
  uncachedInputTokens: number;  // billable uncached input（计费的未缓存输入 = cache miss 部分）
  cachedInputTokens: number;    // cache read（命中缓存的输入，读价更低）
  cacheWriteTokens: number;     // cache creation/write（写缓存生命周期事件，Anthropic cache_creation）
  outputTokens: number;
  /** provider 明确给出的实际 prompt token 数（权威值）。provider 不给则不填，由下方公式推导 contextTokens。 */
  promptTokens?: number;
}
// message-stop 携带 usage（provider 归一化后）
| { type: "message-stop"; stopReason: StopReason; usage?: Usage }
```

派生口径（CostMeter 用；GPT review 2 #②：**cacheWrite 不算进 context length**——它是缓存生命周期事件，不是当前 prompt 里的一段 token）：
- **Context Length** = `promptTokens`（provider 给了就用权威值）；否则 ≈ `uncachedInputTokens + cachedInputTokens`。**不加 cacheWriteTokens**。
- **Billable Input Cost** = uncached input 价 + cache read 价 + cache write 价（三档价不同；计费与 context length 是两个概念）。

- llm-anthropic：从 final message 的 `usage`（input_tokens→uncachedInputTokens / cache_read_input_tokens→cachedInputTokens / cache_creation_input_tokens→cacheWriteTokens / output_tokens）归一化。
- llm-openai：需在请求带 `stream_options:{include_usage:true}`，从末 chunk 的 `usage` 归一化（cached 部分从 `prompt_tokens_details.cached_tokens`）。

### 1.2 工具可缓存元数据（ToolResultCache 的前提）

现状 `Tool`（`ports/types.ts`）只有 name/description/inputSchema/execute，无"能否缓存"信息。**仅 bool 不够**（GPT review P0-2）：`Read("foo.ts")` 被 Edit 后缓存仍返回旧内容、`WebFetch(url)` 网页会变——需 scope + version 而非只靠 TTL。改造：给 `Tool` 加**扁平 opt-in** 字段（默认不缓存，安全优先；扁平而非嵌套对象，避免以后改 Tool API）：

```ts
export interface Tool {
  // ...现有字段...
  cacheable?: boolean;                        // opt-in，默认不缓存
  cacheScope?: "run" | "session" | "global";  // 复用范围，默认 "run"（最安全）
  cacheTtlMs?: number;                        // global/session 用；缺省不设过期
  /** 声明"key 应带版本"，但 Tool 不自己算版本——由 runtime 按 versionKind 注入（见下）。 */
  cacheVersionKind?: "workspace" | "url" | "index";
}
```

**版本由 runtime 注入，Tool Port 不知道 workspace**（GPT review 2 #⑥）：不要让 Tool 里出现 `if (tool.cacheVersioned) version = workspace.snapshot`——那会让 Tool Port 耦合 workspace。改成 Tool 只声明 `cacheVersionKind`，kernel 侧的 **VersionProvider** 按 kind 提供版本串，同一机制复用于多种失效源：

```
Tool.cacheVersionKind → VersionProvider → 版本串
  workspace → workspace snapshot hash   (Read/Grep/Glob，Edit 后 snapshot 变→自然 miss)
  url       → URL content revision/ETag (WebFetch)
  index     → 语义索引版本               (codebase search 类)
```

三种 scope（GPT review §9/§10）：
- **run**：同一 Agent Run 内复用，最安全（默认）。
- **session**：跨 turn 复用，适合 Read/Grep/Glob（配 `cacheVersionKind:"workspace"`，Edit 后自然 miss）。
- **global**：跨 session，需谨慎，适合 WebFetch（配短 TTL 如 5min，或 `cacheVersionKind:"url"`）。

builtin：Read/Grep/Glob → `session` + `versionKind:"workspace"`；WebFetch → `global` + TTL（可加 `url`）；Bash/Write/Edit 不标。

---

## 二、Port A：ModelRouterPort（降本杠杆）

坐在 `LLMRegistry.get()` 之前，**每个 turn 调一次**（不是每会话一次），按任务特征选 provider+model+参数。对齐 valos 已验证的最大收益（compact/记忆召回/分类等辅助任务换便宜模型）。

```ts
export const MODEL_ROUTER_PORT_API_VERSION = 1;

/** session 采集的难度信号（kernel 只采集，判断逻辑全在 router 实现里）。 */
export interface RouteSignals {
  contextTokens: number;
  toolUseCountSoFar: number;
  lastTurnHadError: boolean;      // 上轮工具报错
  lastTurnParseError: boolean;    // 上轮工具入参解析失败
  retriedLastTurn: boolean;
  repeatedToolCall: boolean;      // 连续同名同参工具 = 打转
}
export interface RouteContext {
  sessionId: string;
  turnIndex: number;
  /** 用途分档，如 "main" | "compact" | "recall" | "title" | "classify"。 */
  purpose?: string;
  signals: RouteSignals;
  /** 廉价统计，替代传完整 messages/tools/system（GPT review §13：降本层别自己产生序列化开销）。 */
  contextStats: {
    inputTokens: number;
    toolCount: number;
    messageCount: number;
    hasCode: boolean;
    /** 预期输出规模粗档（GPT review 2 #⑧）：成本≈input+output，coding agent 的代码生成/长 reasoning/大 patch 常让 output 成大头，仅需粗粒度即可影响选档。 */
    expectedOutput?: "short" | "medium" | "long";
  };
  /** agent 经 request_model_change 请求、经 Policy 批准后写入的本 run 锁定档位（最高优先级）。 */
  agentOverride?: { provider?: string; model?: string };
  /** 仅高级 router 需要完整内容时按需提供，默认不传（避免每轮遍历 100k context）。 */
  content?: { system: string; messages: Message[]; tools: Tool[] };
}
export interface RouteDecision {
  provider?: string;            // 覆盖 LLMOptions.provider
  model?: string;               // 覆盖 LLMOptions.model
  thinking?: LLMOptions["thinking"];
  maxTokens?: number;
}
export interface ModelRouterPort {
  route(ctx: RouteContext): RouteDecision | Promise<RouteDecision>;
}
```

- **noop 兜底**：返回 `{}`（不改写，用调用方原 LLMOptions）。
- **内部拆 Strategy + Policy（GPT review P1-4，Port 不增加）**：路由是"选模型"，治理是"预算/升档次数/审批"——两件事。默认实现内部分开：
  ```ts
  class DefaultModelRouter implements ModelRouterPort {
    constructor(private strategy: RoutingStrategy, private policy: RoutingPolicy) {}
    async route(ctx) {
      const proposal = this.strategy.route(ctx);        // 选档：purpose/难度/棘轮 → tier → model
      return this.policy.approve(ctx, proposal);        // 治理：预算天花板/升档次数/审批，可否决/降级
    }
  }
  ```
- **接线**：`session.streamAssistant` 里先 `const d = await ports.modelRouter.route(ctx)`，合并进 llmOptions，再 `ports.llm.get(d.provider ?? llmOptions.provider)`。**kernel 不含任何模型名分支**，只负责**采集 signals + contextStats**；策略全在 Port 实现里。

### 2.1 决策优先级（router-default 默认策略）

```
agentOverride（本 run 锁定）           // 最高：agent 主动选档，见 §2.4
  > 棘轮升档（本 run 已升则保持）        // 反应式，见 §2.2
  > purpose 分档（compact/recall/title → 便宜档）
  > 结构启发式（无 tool_use 短输入→小模型；含代码/长上下文→大模型）
  > 默认档
（新的 user 消息 → 清棘轮与 override，重新起步）
```

### 2.2 中途变难怎么办：Model Escalation Ratchet（升快降慢）

`route()` 每轮调用，天然能中途升级。感知"变难"靠 **结构信号 + 反应式失败信号**（预测不可靠，失败信号最准）：出现 `lastTurnHadError / lastTurnParseError / retriedLastTurn / repeatedToolCall` 即判定便宜模型搞不定。

- **升快降慢（棘轮，正式命名 Model Escalation Ratchet）**：一旦升档，**锁定到本 run 结束**，只在任务边界（新 user 消息）才降回。防止 sonnet↔opus 每轮横跳（既抖动又打爆 prefix cache）。
- **为什么"升可以、run 内不降"有论文依据**：
  - **升档修复有效**：强模型看着上下文里弱模型的旧输出继续做，是把旧输出当**外部材料**再精炼，不同于"改自己的错"——Mixture-of-Agents（arXiv 2406.04692）证明更强的 aggregator 能在下游改好前面的输出；FrugalGPT（arXiv 2305.05176）级联"便宜先跑、不够再升"实测成本大降而性能不掉。所以棘轮**允许 run 内升**。
  - **降档不能靠自愈**："LLMs Cannot Self-Correct Reasoning Yet"（arXiv 2310.01798）表明同一模型无外部反馈的 intrinsic self-correction 常常不提升甚至变差——降档后指望弱模型自己把场子圆回来没有依据。叠加降档会把弱模型输出灌进**共享历史**污染后续（含升回强模型时），故棘轮**run 内不降档**。
  - **升档也要配裁剪**：升档修复 ≠ 无脑保留弱模型全部旧输出——无关/低质上下文会 distract（"LLMs Can Be Easily Distracted by Irrelevant Context", arXiv 2302.00093），故升档应配合 §八 的话题隔离/context pruning。
- **主循环不 cascade、不重跑当前轮**（UX 优先）：失败信号只驱动**下一轮**升档，当前轮输出照常给用户。同轮 cascade（便宜先跑→失败→大模型重跑）只用于**非交互/后台调用**（延迟对用户不可见）。
- **例外：recoverable tool error 可同轮 repair（GPT review §16）**：像"工具入参 parse error"这类当前轮无有效输出的失败，让用户看错误再等下一轮 UX 差。此时允许**同轮小 repair**（用一个便宜的 repair 模型修 tool call，**不必升到 opus**），区别于"升档"。三档语义：
  ```
  Interactive:            默认 no cascade（失败→下一轮升档）
  Non-interactive:        allow cascade（后台调用可同轮重跑）
  Recoverable tool error: optional same-turn repair（小模型修 tool call，非升档）
  ```
- **默认偏保守**：交互主循环起步就用够用模型；降本主战场是**辅助/后台调用**（compact/recall/title/classify/sub-agent），这些无 UX 风险，无脑便宜档。

### 2.3 换模型 = 丢 KV cache（经济性守门）

**KV cache 绑定具体模型权重，Sonnet↔Opus 不可复用**；Anthropic prompt cache 的 key 含 model，任何换模型都让稳定前缀 cache 全失效。换模型有**两笔成本**，不止经济成本：
- **延迟成本（模型切换 time）**：cache 全失效 → 下一轮要对整个上下文重新 prefill → **TTFT 退回冷启动**。无论升还是降，切换本身就是一次可感知的等待惩罚。故**切换点应尽量落在任务边界**（新 run，反正前缀要重算），避免在交互 run 中途切换徒增卡顿。
- **经济成本**：见下（丢失的 cached tokens 要按新模型 input 价重新计费）。

所以：
- 一个 task 内**能不换就不换**（棘轮锁定、升档次数上限）。
- 换不换参考 **Router.Policy 的启发式估算**（GPT review §4）：用 `CostMeter.getUsage`（事实）+ pricing + prefix 状态算——换模型省的 per-token 单价 − 丢失 cache 命中多花的。**注意这只能是 estimate/heuristic**——harness 不知道 provider 的 cache TTL / eviction / 是否 exact-prefix / 内部调度，最多能估 `丢失的 cached tokens × 新模型 input 价`，不能当事实数据。此估算属 decision-time，在 Policy 里，不在 CostMeter。
- 框架层唯一能控的 cache 手段 = **保持前缀稳定** + 打 cache 断点；跨 server 的 KV 复用（前缀感知路由 / KV offload 到 LMCache 等）是推理基础设施职责，agent 框架不介入。
- **Model Affinity：provider 切换 ≠ model 切换，是两个成本等级**（GPT review 2 #⑨）。`Sonnet→Opus`=同 provider 换 model（丢 prefix cache）；`Anthropic→OpenAI`=换 provider，除丢 cache 外还多 **prompt 序列化差异 / tool schema 差异 / system prompt 差异 / reasoning 语义差异**。故 Policy 遵循亲和顺序：
  ```
  Task → 首选 Provider → 同 provider 内升档(Sonnet→Opus) → 仅必要时才跨 provider
  ```
  与前缀缓存思路统一：能不跨 provider 就不跨。

### 2.4 agent 主动选档：cost-aware，"agent proposes, policy disposes"

比纯启发式更准（agent 最清楚接下来难不难），但 agent 有**过度升档偏差**（总想把任务做成），必须护栏兜底。

- **操纵杆 = 工具 `request_model_change({ target, reason })`**：agent 发出的是**请求(ModelChangeRequest)**，**不直接写 session 状态**（GPT review P1-5）。链路是：
  ```
  Agent → request_model_change → ModelChangeRequest
        → ModelRouter.Policy.evaluate(request)   // 预算/次数/审批
        → Approved / Rejected
        → (Approved) 写 agentOverride，锁定到 run 结束
  ```
  预算否决（"已花 $4.8、只剩 $0.2 → 拒绝"）本质属 **Policy**，不属 Tool；agent 不能自己改自己的 model policy state，避免 tool↔session↔router 隐式耦合。
- **cost 反哺**：把"当前 run 花费 / 剩余预算 / 换模型的 cache 损失**估算**"注入 agent 上下文，让它 cost-aware 地决策。其中花费/用量来自 `CostMeter.getUsage`（事实），换模型 cache 损失估算由 **Router.Policy** 用用量+pricing+prefix 状态现算（decision-time，非 CostMeter 职责）。
- **非对称同意 + 降档要分类（降档不是免费午餐）**：降档会把弱模型输出灌进共享历史污染后续，且自我纠错不可靠（见 §2.2 依据），故不能一刀切"降档自动放行"：
  - **升档（花更多）→ 需用户同意**：走 helios tool-approval / AskUserQuestion。推荐**预授权包络**（用户开局设"允许自动升到 opus，预算上限 $X / 每 task 升档 ≤ N 次"），超包络才逐次问。
  - **降档分三类**：

    | 降档类型 | 输出去向 | 污染 | 处置 |
    |---|---|---|---|
    | 后台/辅助调用（compact/recall/title/classify/sub-agent） | fork 独立 LLMOptions，**不进主历史** | 无 | **自动放行**（降本主战场） |
    | 主循环 run 内降档 | 进共享历史 | 有 + 延迟 | **默认禁止**——棘轮升快降慢、run 内不降 |
    | 任务边界降档（新 user 消息重新起步） | fresh start | 低 | 自动放行；若 agent 主动 `request_model_change` 降档，**告知用户"会影响后续一致性/质量"并留痕** |

    棘轮机制已天然规避 run 内降档污染（run 内只升不降，降档只在任务边界发生）。
- **护栏（防 reward-hacking / 失控）**：预算天花板（Policy 比对 `CostMeter.getUsage` 达阈值 → 拒绝再升档）；升档次数上限 + 棘轮防 sonnet↔opus 横跳打烂 cache；`reason` 留痕进 CostMeter 报告供复盘。

> 一句话：把"降本"升级成 **cost-aware agent**——agent 在用户预授权的预算包络内、cost 感知地自选模型；升档非对称门控，预算/棘轮/启发式做兜底护栏。

### 2.5 结构启发式：先 Tier 再 map，别硬编码模型名（GPT review §14）

第一版**不做复杂分类器**。Strategy 先把请求归到一个 tier，再由独立的 tier→provider/model 映射表落地——难度判断与模型命名解耦：

```
route:  purpose ─┐
        difficulty(contextStats: size/toolCount/hasCode) ─┼─→ Tier 0/1/2
        ratchet(signals) ─┘
Tier 0 → small   Tier 1 → medium   Tier 2 → large      // 再走 provider/model mapping
```

禁止业务逻辑里直接 `if (contextTokens > 30000) model = "claude-opus-..."`——模型名只出现在映射表里。

## 三、Port B：CostMeterPort（可观测可量化）

观察者 Port，订阅 run 内的用量/调用事件，产出 `Cost/Task` 指标。把降本变成"看得见"。

**CostMeter 只做 measurement，不做 policy**（治理在 ModelRouter.Policy）。

```ts
export const COST_METER_PORT_API_VERSION = 1;

export interface LLMCallRecord {
  provider: string; model: string; usage: Usage; purpose?: string;
  /** 价格版本，用于可审计/可复算（GPT review §6：价格会变，存 estimatedCost 事后会对不上）。 */
  pricingId?: string;
  pricingVersion?: string;      // 如 "anthropic-2026-08"
}
/** run 结束时的任务结果，支撑 Cost/Successful Task（GPT review P0-3）。 */
export interface TaskOutcome {
  status: "success" | "failure" | "cancelled";
  reason?: string;
}
/** 工具调用记录：区分"发起/执行/命中"三个概念（GPT review 2 #⑤）。 */
export interface ToolCallRecord {
  name: string;
  cacheHit: boolean;    // 命中缓存
  executed: boolean;    // 是否真正执行（命中即 false）
}
export interface TaskCostReport {
  runId: string;
  outcome?: TaskOutcome;                       // 无 outcome 只能算 Cost/Task，不能算 Cost/Successful Task
  uncachedInputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number;
  contextLength: number;                       // = promptTokens ?? (uncached + cached)，不含 cacheWrite
  llmCalls: number;
  // 工具三指标分开（GPT review 2 #⑤）：否则 toolCalls↓ 分不清是 agent 少调还是 cache 挡掉
  toolCalls: number;                           // agent 发起的工具请求数
  toolExecutions: number;                      // 真正执行次数
  toolCacheHits: number;                       // 缓存命中次数（toolCalls = executions + cacheHits）
  avgContextLength: number;
  // Context 层 ↔ Cost 层的桥（GPT review 2 #⑩）：证明 Context Reuse → cache↑ → Cost/Task↓
  prefixCacheHitRate?: number;                 // 命中缓存的调用占比
  cachedInputRatio?: number;                   // cachedInput / (uncached + cached)
  estimatedCost?: number;                      // 由可选价格表算出
  pricingVersion?: string;                     // 本报告采用的价格版本
}
/** 纯 measured 事实，供 Policy 做预算/切换成本判断（不含任何 decision/estimate）。 */
export interface CostUsage {
  spent: number;                               // 已花（价格表可用时）
  uncachedInputTokens: number; cachedInputTokens: number; outputTokens: number;
}
export interface CostMeterPort {
  onLLMCall(runId: string, rec: LLMCallRecord): void;
  onToolCall(runId: string, rec: ToolCallRecord): void;
  setOutcome(runId: string, outcome: TaskOutcome): void;
  report(runId: string): TaskCostReport;
  /** measurement only（GPT review 2 #③）：只回已测事实，预算判断/切换成本估算都在 Router.Policy。 */
  getUsage(runId: string): CostUsage;
}
```

- **noop 兜底**：全空实现，`getUsage` 返回 `{ spent: 0, uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }`。
- **默认实现（costmeter-default）**：内存累加 + 可选价格表（带 `pricingVersion`）算 `estimatedCost` / `prefixCacheHitRate` / `cachedInputRatio`；`report` 在 `agent_end` 时取用。
- **接线**：session 每次 `provider.streamMessage` 结束（拿 message-stop.usage）调 `onLLMCall`；`executeTools` 每个工具调 `onToolCall`（带 executed）；run 结束调 `setOutcome`（success/failure/cancelled）；`agent_end` 带 `report(runId)`。`getUsage` 注入 Router.Policy 支撑 §2.4 的预算/切换决策。
- **measurement / governance 彻底分离（GPT review 2 #③#④）**：CostMeter 只提供事实（`getUsage`/`report`）；**预算是否超、换模型省不省，全在 Router.Policy**——Policy 用 `CostMeter.getUsage` + PricingTable + Context Runtime 的 prefix 状态自己算 switch cost 估算（那是 decision-time estimation，不是 measurement）。
- 指标对齐 GPT 第 12 点，核心是 **Cost / Successful Task**（cost↓ 但 success↓ 是伪优化，必须同时看成功率）。

---

## 四、Port C：ToolResultCachePort（省重复工具调用）

包在工具执行外：`hash(toolName + 规范化args)` 命中直接返回，未命中执行后写入。只对 `cacheable:true` 的工具生效。

key 必须带 **scope + version**（GPT review P0-2/§9），否则 `Read` 缓存会返回被 Edit 前的陈旧内容：

```ts
export const TOOL_RESULT_CACHE_PORT_API_VERSION = 1;

export interface ToolCacheKey {
  toolName: string;
  argsCanonical: string;                 // 稳定排序 JSON
  scope: "run" | "session" | "global";   // 复用范围
  scopeId: string;                        // run→runId / session→sessionId / global→固定
  version?: string;                       // VersionProvider 按 cacheVersionKind 注入，如 workspace snapshot hash / url rev / index ver
}
export interface ToolResultCachePort {
  get(key: ToolCacheKey): Promise<ToolResult | undefined>;
  set(key: ToolCacheKey, result: ToolResult, ttlMs?: number): Promise<void>;
}
```

- **noop 兜底**：`get` 恒 undefined、`set` 空操作（等于关闭缓存）。
- **默认实现（toolcache-mem）**：内存 Map + TTL；args 规范化 = 稳定排序 JSON。可选 `toolcache-fs` 落盘跨会话（global）复用。
- **接线**：`session.executeTools` 单个工具执行前，若 `tool.cacheable`：按 `tool.cacheScope` 组 key（`cacheVersionKind` 则由 **VersionProvider** 注入 `version`）→ `get` 命中则跳过执行（`onToolCall(cacheHit=true, executed=false)`）；未命中执行后按 `tool.cacheTtlMs` `set`。
- **安全边界**：只缓存 opt-in 的幂等/只读工具；Bash/Write/Edit 永不缓存。**version 比 TTL 更准**——workspace 文件被 Edit → snapshot 变 → 自然 miss；WebFetch 用 url revision 或短 TTL。version 来源由 `cacheVersionKind` + VersionProvider 决定，**Tool 本身不碰 workspace**（见 §1.2）。

---

## 五、kernel/session 接线（统一视角）

```
session.streamAssistant:
  ctx = {sessionId, turnIndex, purpose, signals, contextStats, agentOverride}  // 不传完整 messages
  d = await ports.modelRouter.route(ctx)          // A（内部 Strategy→Policy；agentOverride 最高优先级）
  llmOptions' = merge(llmOptions, d)
  provider = ports.llm.get(d.provider ?? llmOptions.provider)
  ...stream... message-stop.usage
  ports.costMeter.onLLMCall(runId, {provider, model, usage, purpose, pricingVersion})   // B
  // 采集本轮 signals（error/parseError/retry/repeatedToolCall）供下一轮 route()

request_model_change 工具（§2.4，agent 发请求、不直接改状态）:
  → ModelChangeRequest → ModelRouter.Policy.evaluate（预算天花板[比对 CostMeter.getUsage]+升档次数+审批/预授权包络）
  → Approved 写 agentOverride（锁定到 run 结束）/ Rejected 回原因给 agent
  升档非对称门控；降档分类：后台自动 / run 内禁止 / 任务边界告知+留痕（见 §2.4）

session.executeTools(每个 tool):
  if tool.cacheable:
     version = tool.cacheVersionKind ? versionProvider.get(tool.cacheVersionKind) : undefined
     key = {toolName, argsCanonical, scope:tool.cacheScope, scopeId, version}
     hit = await ports.toolCache.get(key)                                // C
     if hit: costMeter.onToolCall(runId, {name, cacheHit:true, executed:false}); return hit
  result = await tool.execute(...)
  if tool.cacheable: await ports.toolCache.set(key, result, tool.cacheTtlMs)
  costMeter.onToolCall(runId, {name, cacheHit:false, executed:true})

session.sendMessage 收尾:
  costMeter.setOutcome(runId, {status})          // success/failure/cancelled
  emit agent_end (带 costMeter.report(runId))；清 signals/agentOverride
```

`PortRegistry` 加三个字段：`modelRouter / costMeter / toolCache`，均有 noop 兜底（缺失不影响 kernel 运行）。`request_model_change` 是 builtin 工具，但**只发请求，由 ModelRouter.Policy 裁决后才写 agentOverride**（不 Tool 直写 session）。CostMeter 在 LLM 调用链**旁路观察**，不侵入主路径。kernel 不含任何降本策略分支——全部在 Port 实现里，可整体替换（"亮点"：换降本策略零改 kernel）。

---

## 六、任务拆分（**一个 feature branch 收口**，不拆三个分支）

**明确选一个 feature branch**（GPT review 2 #⑬）：三个 Port 强耦合于 `Usage`/`Tool`/`Session`/`PortRegistry`，拆三个独立分支必然 Port API 反复改 → kernel/provider 反复 rebase。这是一个完整的 Runtime capability，不是三个独立 feature。按依赖顺序在同一分支推进：

1. **ports 前置**：`Usage`（`uncachedInputTokens`/`cachedInputTokens`/`cacheWriteTokens`/`outputTokens` + 可选 `promptTokens`）+ message-stop 带 usage；`Tool` 加 `cacheable/cacheScope/cacheTtlMs/cacheVersionKind`；新增三 Port 接口（含 `RouteSignals`/`contextStats`(+`expectedOutput`)/`agentOverride`/`TaskOutcome`/`ToolCallRecord`/`CostUsage`/`pricingVersion`/`ToolCacheKey.scope+version`）+ api 常量；`PortRegistry` 加三字段 + `VersionProvider`。
2. **llm-anthropic / llm-openai**：归一化 usage（input_tokens→uncached / cache_read→cached / cache_creation→write；openai 需 include_usage + cached_tokens）。
3. **kernel**：noop.ts 加三个 noop；`VersionProvider`（workspace snapshot / url / index）；session 接线（route 前置 + 每轮采集 signals/contextStats；costMeter 埋点 onLLMCall/onToolCall(带 executed)/setOutcome；toolCache 按 scope+version 包裹 executeTools；run 结束清 signals/agentOverride）；`agent_end` 带 cost report。
4. **agent 选档（§2.4）**：builtin 工具 `request_model_change` **只发 ModelChangeRequest**；由 `ModelRouter.Policy.evaluate` 裁决（预算天花板[比对 `CostMeter.getUsage`]+升档次数+审批/预授权包络）后才写 agentOverride；降档分类处置；Policy 用 getUsage+pricing+prefix 现算 switch cost 估算注入 agent。
5. **默认实现包**：`router-default`（内部 **Strategy**[purpose/难度/棘轮→Tier→model 映射 + Model Affinity] + **Policy**[预算/次数/审批 + switch cost 估算]）、`costmeter-default`（累加 + 带 pricingVersion 价格表 + `getUsage` + outcome + prefixCacheHitRate/cachedInputRatio）、`toolcache-mem`（Map + scope + version + TTL）。
6. **测试**：
   - router：Strategy 出 tier→model；Policy 预算否决/降级；Model Affinity 优先同 provider 升档；agentOverride>棘轮>purpose>启发式 优先级；失败信号升档并锁定；新 user 消息清棘轮；noop 不改写；contextStats(含 expectedOutput) 足够决策（不依赖完整 messages）。
   - usage：anthropic/openai 归一化区分 uncached/cached/write；contextLength = promptTokens ?? (uncached+cached)，**不含 write**。
   - costMeter：report token/llmCalls/**toolCalls·toolExecutions·toolCacheHits 三分**/outcome/prefixCacheHitRate 正确；Cost/Successful Task 需 outcome；pricingVersion 落库；`getUsage` 只回事实（无 estimate）。
   - policy switch-cost：Policy 用 getUsage+pricing 算 switch cost 估算（CostMeter 里已无此 API）。
   - request_model_change：请求→Policy 裁决（预算/次数护栏否决升档；后台降档放行 / run 内降档拒绝 / 任务边界降档留痕）；批准才写 agentOverride 锁定本 run。
   - toolCache：session-scoped + versionKind:workspace 工具 Edit 后 miss（不返回陈旧）；run/global scope 行为；非 cacheable 不缓存；TTL 过期重跑；version 由 VersionProvider 注入（Tool 不碰 workspace）。
   - 可插拔：noop 三件套全装 = 行为等价现状（回归）。

---

## 七、边界与非目标（诚实标注）

- **不做 SemanticCachePort**：响应级相似度复用正确性风险高（key 需含 task+context+toolState+model+version），本期不做。
- **不做单一大 Cost Port**：三个 Port 各自单一职责。
- **KV/prefix cache 不是 Port，归 Context Runtime 的 Branch-aware Context Reuse**（见 §八）：属 provider 适配 + session 前缀纪律，不进 Cost 层。
- **工具并行/批处理不是本方案**：属 kernel 循环行为（可另开演进，靠工具 `readonly` 元数据 + executeTools 并发）。
- **Context Pruning（tool result 裁剪）**用现有 PostToolUse hook 或工具内实现，不新增 Port。
- **价格表**是可选输入，缺省时 CostMeter 只报 token/调用数不报金额。**换模型 switch cost 估算属 Router.Policy（decision-time），不进 CostMeter**（CostMeter 只 measurement）。
- **主循环不做同轮 cascade**（避免双倍延迟 + 撤回已 stream 输出的坏 UX）：失败信号只驱动下一轮升档；同轮 cascade 仅限非交互/后台调用。
- **agent 主动升档需用户同意**（tool-approval 或预授权包络）；**降档不一刀切自动放行**——后台/辅助调用自动、主循环 run 内禁止、任务边界降档告知+留痕（见 §2.4）。agent 有过度升档偏差，必须预算天花板 + 升档次数上限兜底（policy 可否决 agent）。
- **换模型即丢 KV/prompt cache**（模型权重绑定，Sonnet↔Opus 不可复用），有**延迟（TTFT 冷启动）+ 经济**双重成本（见 §2.3）：是否换由 CostMeter 的**启发式估算**参考（非事实数据），切换点尽量落任务边界；跨 server KV 复用是推理基础设施职责，框架不介入。
- **不做自动话题分叉**：话题隔离本期只支持人工分叉（用户编辑/retry→fork）；按话题自动 auto-fork 需意图检测器，列为后续可选增强（见 §八）。
- 与 `docs/shell-port-and-persistent-cwd.md`、`docs/thinking-reasoning-support.md` 相互独立。

---

## 八、Branch-aware Context Reuse（Context Runtime 层，非 Cost Port）— GPT review P2-6

prefix/KV cache **不放 Cost 层**，而是结合 `branch-tree-cache` 的消息 fork 树，作为 Context Runtime 的独立能力。这可能是 helios 最有特色的点：

```
Message Fork Tree → Shared Ancestor → Prefix Identity → Stable Serialization
                  → Provider Adapter → MaaS Prefix / KV Cache
                  （CostMeter 只旁路观察 uncached/cached/cacheWrite tokens）
```

- 分支切换时，多个分支共享同一祖先前缀 → 前缀身份稳定 → 稳定序列化 → provider prompt cache 命中率高。
- Cost 层只**观察** cache 命中（cachedInputTokens），**不控制** KV——控制权在 Context Runtime 的前缀稳定纪律 + provider 适配层的 cache_control 断点。
- 本方案不实现它，仅明确归属；待 `branch-tree-cache` 合并后作为 Context Runtime 演进项（并补"cache 断点不落 thinking 块"）。

**但 CostMeter 必须观察它，否则 Context 层与 Cost 层是两个互不相干的模块**（GPT review 2 #⑩#⑪）。Cost Report 里的 `prefixCacheHitRate` / `cachedInputRatio`（见 §三）就是这座桥——用它证明 **Branch-aware Context Reuse → Prefix Cache Hit Rate↑ → Cost/Successful Task↓**。整个系统由此闭环成一条因果链，而非三个孤立 Port：

```
Agent Task → Message Fork Tree → Branch-aware Context →（Context Reuse / Stable Prefix）
  → Prefix Cache Hit → CostMeter（观测 cachedInputRatio/hitRate）→ Cost/Task
  → ModelRouter（cost-aware 选档）→ Model Decision → Agent Task        // Measure→Decide→Execute→Re-measure
```

### 8.1 用分支树做话题隔离，而非运行时有损裁剪历史

回到"问题1 → 问题2 → 问题1、问题2 无关想去掉"的诉求：**不做运行时"识别相关性再删/换占位符历史"**——它同时输两头：① 判错就丢必要上下文（问题2 可能改过文件/装过依赖，工具副作用留在真实世界但模型失忆，反而更错）；② 运行时重构历史 = 改前缀 = **打爆 prompt cache**，与降本目标直接冲突。无关内容拖垮推理这点有依据（arXiv 2302.00093），但**治理手段应是结构化隔离而非有损删除**。

**AI 感知模型 = 只见 active path**：模型每轮只拿到当前节点的**祖先链线性化**，sibling 分支根本不进 prompt。所以问题2 分支对问题1 分支**天然不可见** → 零污染、共享前缀（cache 友好）。不是"AI 感知树后避开"，而是**结构上就没喂给它**。

**分叉触发分两档，本期只做人工**：

| 档 | 触发 | AI 感知 | 风险 | 状态 |
|---|---|---|---|---|
| 人工分叉 | 用户编辑/retry | 只见 active path | 零 | ✅ 本期（MVP，立即可用） |
| 自动话题分叉 | 意图检测器 auto-fork | 只见 active path | 低（判错顶多划错分支，**数据不丢可回溯**，非有损删除） | ⏸ 后续可选增强，先不做 |

若未来做自动分叉：意图识别**只用于触发结构化 fork**（无损、可回溯），绝不做有损删除历史——这是它与被否掉的"运行时裁剪"的本质区别。
