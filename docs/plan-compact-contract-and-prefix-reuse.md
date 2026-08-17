# 实施计划：压缩失败语义（#33）+ 压缩调用命中前缀缓存（#31）

状态：待实施（2026-08-17）。背景与取舍论证见 `docs/compaction-and-cache-review.md`，本文只写"改什么、改成什么形状、怎么验"。

**已定决策**（本轮拍板）：

- #31 契约：**把 LLM 调用挪回 kernel**，Port 只出计划与解析。
- #29 路线：**原文尾巴**（Reasonix 形态）。本计划不实施 #29，但契约要为它留好位置（`coveredMessageIds` 允许部分覆盖）。

---

## 零、顺序调整（与 review 文档里给的顺序不同，此处为准）

review 文档第十节建议 `#33 → #31`。**改为先做契约迁移**，理由是一处会白做的返工：

#33 原方案要给 `Summary` 加 `degraded` 字段，让"摘要失败"能从 Port 传到 kernel。但 #31 一旦把 LLM 调用挪回 kernel，**失败在 kernel 里直接可见**（就是它自己那次 `streamMessage` 的异常），`degraded` 字段立刻变成多余，得再删一次。

所以拆成三步，每步独立可验、可单独提交：

| 阶段 | 内容 | 行为变化 |
|---|---|---|
| **Phase 0** | 契约迁移：LLM 调用挪回 kernel，Port 改 `plan()`/`parseSummary()`，撤 `runId` 形参 | **无**（等价重构，A 路线保持） |
| **Phase 1** | #33 失败语义：失败不装节点 + 熔断 3 次 + 事件 status + `/compact` 强制绕过 | 有（失败路径） |
| **Phase 2** | #31 收益：B 路线（走主会话前缀）+ 路由判定 + 摘要质量实测 | 有（成功路径） |

Phase 1 在 Phase 0 之后是**纯 kernel 改动、零契约改动**。

---

## 一、实施前必须先核实的两件事实

这两条都会改变 Phase 2 的具体写法，**先验证再动手**，不要按猜测实现。

### 事实 A：`tool_choice: {type:"none"}` 能不能透传

已核实：`@anthropic-ai/sdk@0.32.1` 的类型里 `ToolChoice = ToolChoiceAuto | ToolChoiceAny | ToolChoiceTool`（`resources/messages.d.ts:271`）—— **没有 `none`**。

但 `createParams` 本来就走窄类型旁路（`llm-anthropic/src/index.ts:93` 的 `as unknown as Anthropic.MessageCreateParamsStreaming`，`thinking` 已经是同款处理）。所以 SDK 类型不是阻碍，真正要验的是**服务端/网关认不认**：

- 验证方式：拿一个带 tools 的最小请求，加 `tool_choice: {type:"none"}`，看是否 400。
- 认 → Phase 2 用它，B 路线的"摘到一半去调工具"风险直接消除，且**不改 tools 数组**（改数组会砸缓存）。
- 不认 → 退回 prompt 防呆（`SUMMARIZER_SYSTEM` 里那句 `Do not call tools.` 挪进 inline 指令的**首尾各一次**，对齐 CC 的双重防呆）。

### 事实 B：`cache_creation_input_tokens` 是否只计增量

**这条会推翻 #31 issue 正文里的一个说法**，必须先验清。

我在 #31 里写"误打断点 → 整段历史按 1.25x 重写 → 最贵"。这个结论**很可能是错的**：Anthropic 的计费是把命中的部分算 `cache_read`、只把**超出已缓存前缀的增量**算 `cache_creation`。若如此，则：

- B 路线的 messages 数组 = `[...history, instruction]`，`applyCacheBreakpoints` 打在 `length-2` = **历史最后一条**（`convert.ts:140`）—— 位置恰好正确：读到主线已写入的最长前缀，写入只有尾部增量（上一轮断点之后的 1~2 条 + 无）。
- 那么**不需要新增"禁断点"开关**，现有无条件逻辑对 B 恰好是对的；真正有害的只是"断点打到指令之后"或位置漂移导致 miss。

- 验证方式：跑一次真实 B 调用，看 `message_start` 的 `cache_read_input_tokens` / `cache_creation_input_tokens` 拆分是否符合"读=历史、写=增量"。
- 若验证符合 → Phase 2 删掉"新增 `LLMOptions.cache` 开关"这一项，并**回头修正 #31 正文与 review 文档第三节的③**。
- 若不符合（真的整段重写）→ 才需要给 `LLMOptions` 加只读缓存模式：

  ```ts
  /** "auto"（默认）= 照常打断点；"read-only" = 跳过 messages 断点，只保留 system 断点（后者是读取前缀的必要标记）。 */
  cache?: "auto" | "read-only";
  ```

---

## 二、Phase 0：契约迁移（行为等价）

### 2.1 `packages/ports/src/compact.ts`

```ts
export const COMPACT_STRATEGY_PORT_API_VERSION = 2; // 破坏性：方法签名整体更换

/** 一次压缩的执行计划。Port 只描述"压什么、怎么问"，不负责发请求。 */
export interface CompactPlan {
  /**
   * 本次覆盖哪些消息。未覆盖的留在摘要之后作为原文尾巴（#29 落地后这里会是真子集；
   * 当前默认实现仍返回全集）。
   */
  coveredMessageIds: string[];
  /** 摘要输出预算。 */
  maxTokens: number;
  /**
   * 路线 B（默认）：追加到**主会话前缀之后**的一条 user 消息正文。
   * 因为前缀里已经有完整对话，这里只放指令，不重复对话内容。
   */
  inlineInstruction: string;
  /**
   * 路线 A（兜底）：独立调用所需的 system 与单条 user 正文（含渲染后的对话）。
   * 窗口装不下 B、或缓存已冷时使用。
   */
  standalone: { system: string; userText: string };
}

export interface CompactStrategyPort {
  shouldCompact(state: ConversationState): boolean;
  /** 纯函数：只产出计划，不调 LLM、无副作用、不抛（实现内部异常自行兜住并返回可用计划）。 */
  plan(state: ConversationState): CompactPlan;
  /**
   * 把模型原始输出解析/校验成最终摘要文本。
   * @returns undefined = 产物不可用（空串、明显截断、或不满足验收规则），kernel 据此判定失败。
   */
  parseSummary(raw: string, state: ConversationState): string | undefined;
}
```

去掉的：`compact(messages, runId)` 与 `Summary` 类型在本 Port 的使用（`Summary` 若无其他引用则一并删除）；`runId` 形参连同 `compact.ts` 里那段"实现若自己调 LLM 须自报 CostMeter"的注释一起撤掉 —— 计量回到 kernel 的既有分发点。

### 2.2 `packages/compact-default/src/index.ts`

- `DefaultCompact` 只保留 `shouldCompact` / `plan` / `parseSummary`，**删掉 `llmSummary()` 与对 `ports.llm` / `ports.costMeter` 的持有**（连带删掉构造函数里那段"持有整个 ports 注册表以规避 manifest 顺序"的注释与理由 —— 不再需要 llm）。
- `plan()`：
  - `coveredMessageIds = state.messages.map(m => m.id)`（Phase 0 保持全覆盖，#29 再改）
  - `maxTokens = SUMMARY_MAX_TOKENS`
  - `inlineInstruction = SUMMARIZE_INSTRUCTION`（新增导出，不含 `<conversation>` 包裹 —— 对话已在前缀里）
  - `standalone = { system: SUMMARIZER_SYSTEM, userText: buildSummarizeRequest(renderConversation(state.messages)) }`
- `parseSummary(raw)`：`raw.trim() || undefined`（Phase 0 只做最低校验；验收规则留到 #29）
- `extractiveSummary` 保留导出，但**不再是失败回落**：仅当 `ctx.options.llm === false` 时，`plan()` 走"不调 LLM"路径。这需要一个表达方式 —— 用 `maxTokens: 0` 表示"kernel 不必发 LLM 请求，直接用 `standalone.userText` 当摘要"过于隐晦；改为在 `CompactPlan` 上加显式字段：

  ```ts
  /** 预置摘要：非空时 kernel 直接采用它、不发 LLM 请求（离线/确定性测试用）。 */
  precomputed?: string;
  ```

  `llm === false` 时 `plan()` 返回 `precomputed: extractiveSummary(messages)`。语义清晰，且把"抽取式只是显式逃生舱"这条纪律写进了类型。

### 2.3 `packages/kernel/src/session.ts`

`maybeCompact` 拆成三段，职责单一：

```ts
/** 现有职责保留：判定 → 调用 → 安全切点 → 建 summary 节点 → 落盘 → 事件。 */
private async maybeCompact(runId: string): Promise<void>

/** 发出摘要请求并返回摘要文本；undefined = 本次不可用（失败/空产物）。 */
private async requestSummary(
  plan: CompactPlan,
  state: ConversationState,
  runId: string,
): Promise<string | undefined>
```

`requestSummary` 内部（Phase 0 只实现 A 路线，保持现有行为）：

```ts
if (plan.precomputed) return plan.precomputed;
const provider = ports.llm.get(this.opts.llmOptions.provider);
let out = "";
for await (const ev of provider.streamMessage(
  [{ id: "compact-request", role: "user", content: plan.standalone.userText }],
  [],                                   // 空 tools
  { system: plan.standalone.system, maxTokens: plan.maxTokens, signal: this.currentAbort?.signal },
)) {
  if (ev.type === "text-delta") out += ev.text;
  else if (ev.type === "error") throw new Error(ev.error);
  else if (ev.type === "message-stop" && ev.usage) {
    this.opts.ports.costMeter.onLLMCall(runId, {
      provider: provider.id, model: "", usage: ev.usage, purpose: "compaction",
    });
  }
}
return ports.compact.parseSummary(out, state);
```

⚠️ **`signal` 是新增的**（原实现没传）：调用挪进 kernel 后，压缩请求理应随 run 取消一起中止。

### 2.4 顺带修的顺序问题（Phase 2 的前置条件，Phase 0 就做掉）

现在 `session.ts:380` 的 `await this.maybeCompact(runId)` 跑在 `systemPrefix` 计算（:383-390）**之前**。B 路线需要 `system`，所以必须把 `systemPrefix` 的计算**上移到 `maybeCompact` 之前**。

安全性已核实：`systemPrefix` 依赖 `this.opts.system`（构造期）、`ports.memory.recall(text)`（与压缩无关）、`this.sessionStartContext`（在 :361-369 已赋值，早于 380）。上移无副作用。

### 2.5 需要同步迁移的实现与 fixture

- `packages/kernel/src/noop.ts` 的 NoopCompact
- `packages/kernel/test/fixtures/`：`mockCompact.ts`、`mockCompactOnceAll.ts`、`mockCompactPartial.ts`、`malformedCompact.ts`
- `packages/kernel/src/pluginLoader.ts` / `portRegistry.ts`：apiVersion 从 1 → 2 的校验点

### 2.6 Phase 0 验收

- `pnpm typecheck` + `pnpm test` 全绿（当前基线 455 passed）
- `wiring.test.ts` 里 `compact_start`/`compact_end` 的断言**不变**（行为等价）
- 新增一条：`plan()` 是纯函数 —— 连续调用两次返回同值，且不触碰 `ports.llm`（用一个会 throw 的 llm stub 断言"没被调用"）

---

## 三、Phase 1：#33 失败语义（纯 kernel）

### 3.1 状态与事件

```ts
// session.ts 私有状态
/** 连续压缩失败次数；成功或显式 /compact 归零。达上限后停止自动压缩（会话继续）。 */
private compactFailures = 0;
private static readonly MAX_COMPACT_FAILURES = 3; // 对齐 CC autoCompact.ts:70
```

```ts
// events.ts
| { type: "compact_end"; summaryLength: number; remaining: number;
    status: "ok" | "skipped" | "failed" | "blocked"; reason?: string }
```

- `ok`：装了 summary 节点
- `skipped`：无可安全压缩（现有 `lastCoveredIdx < 0` 分支）
- `failed`：本次摘要不可用（异常 / `parseSummary` 返回 undefined）
- `blocked`：熔断已触发，本次直接没调 LLM

### 3.2 `maybeCompact` 的失败路径

```
shouldCompact? ──no──> return（不 emit 任何事件，同现状）
   │yes
   ├─ compactFailures >= 3 且非 force ──> emit compact_end{status:"blocked"}，return（不发 LLM 请求）
   ├─ emit compact_start
   ├─ summary = await requestSummary(...)  // 内部异常在此 catch，不外抛
   │    undefined ──> compactFailures++；emit compact_end{status:"failed", reason}
   │                  ⚠️ 不 appendNode、不 appendLog、不改 HEAD ——「失败时什么都不改写」
   │                  return
   └─ 成功 ──> compactFailures = 0 → 安全切点 → 建节点 → 落盘 → emit compact_end{status:"ok"}
```

**要点：`requestSummary` 的异常必须在 `maybeCompact` 内被吞掉，不能穿透到 `sendMessage`。** 现状是穿透的 —— `ui-chat/src/useChat.ts:223,433` 两处注释明确记录了"compact() 抛错时只 emit 了 compact_start、没有 compact_end，前端 isCompacting 永久卡 true"，还专门写了兜底逻辑。本阶段把根因修掉后，那两处兜底注释要更新（**兜底代码先留着**，属于纵深防御，不在本次删）。

### 3.3 `/compact` 强制绕过

`maybeCompact(runId, { force }: { force?: boolean } = {})`：`force` 时忽略熔断计数并归零。接入点是显式压缩命令的调用处（CLI slash command / RPC）；若当前尚无显式 `/compact` 入口，则本阶段只留参数，不接线（在 issue 里注明）。

### 3.4 UI

`packages/ui-chat/src/useChat.ts` 的 `compact_end` case 读 `status`：

- `failed`/`blocked` → 追加一条 `role:"system"` 消息（复用既有 `appendErrorMessage` 那套 `.helios-msg-system` 样式与 `--h-error` token），文案含原因与"本会话已暂停自动压缩"
- 无论何种 status 都要复位 `isCompacting`

### 3.5 Phase 1 验收（新增测试）

| 用例 | 断言 |
|---|---|
| 摘要 provider throw | 树节点数不变、HEAD 不变、`log.jsonl` 无新增、`compact_end.status === "failed"` |
| `parseSummary` 返回 undefined | 同上 |
| 连续失败 3 次后再触发 | 第 4 次**不调用** provider（stub 记调用次数），`status === "blocked"` |
| 失败后一次成功 | `compactFailures` 归零（第 5 次仍会尝试） |
| `precomputed`（`llm:false`） | 不调 provider、正常装节点、`status === "ok"` |
| 失败不影响本轮 run | `sendMessage` 正常返回，`agent_end` 无 error |

---

## 四、Phase 2：#31 B 路线

### 4.1 路由判定

```ts
/** 选择压缩调用走哪条路线。inline = 复用主会话前缀（省钱且快），standalone = 独立调用。 */
private chooseCompactRoute(args: {
  plan: CompactPlan;
  system: string;
  tools: Tool[];
  path: Message[];
}): "inline" | "standalone"
```

判定条件（三条全满足才 inline）：

1. **装得下**：`approxTokens(path) + approxTokens(system+tools 估算) + plan.maxTokens < contextWindow × 安全系数`。
   ⚠️ helios 目前**没有 contextWindow 的来源** —— `VersionProvider`/模型元数据尚未落地。第一版用 `SessionOptions` 上一个可配置上限（如 `compactInlineMaxTokens`，缺省给一个保守值），并在注释里写明这是占位、等模型元数据落地后替换。**不要**用 `contextBudgetWarnTokens`（它是纯观测阈值，语义不同）。
2. **缓存大概率还热**：`Date.now() - this.lastLlmCallAt < this.opts.cacheTtlMs`（缺省 5min，对齐 Anthropic ephemeral；自动缓存 provider 可配更大）。
   `lastLlmCallAt` 需要新增维护点 —— 在 `runTurnLoop` 的 LLM 调用返回处更新最实在，但那会给 loop 加一个回调；更简单的做法是 `requestSummary` 与 `runTurnLoop` 结束时各更新一次（run 刚结束 → 时间戳就是上一轮 LLM 调用时间，误差在秒级，够用）。取后者。
3. **provider 支持前缀缓存**：`provider.caching !== "none"`（依赖 #34 的 Layer B 字段；#34 未做时此条恒真）。

### 4.2 inline 请求的构造

```ts
const messages = [
  ...path,
  { id: "compact-instruction", role: "user" as const, content: plan.inlineInstruction },
];
provider.streamMessage(messages, tools, {
  system,                                  // 主会话冻结前缀，逐字节不变
  maxTokens: plan.maxTokens,
  signal: this.currentAbort?.signal,
  ...(toolChoiceNoneSupported ? { toolChoice: "none" } : {}),
});
```

- `tools` **原样传**（不改数组 —— 改了就砸缓存）。
- `toolChoice` 若采用，需要在 `LLMOptions` 上加字段并在 `llm-anthropic` 里映射成 `tool_choice: {type:"none"}`（走既有 `as unknown` 旁路）；`llm-openai` 映射成 `tool_choice: "none"`。**取决于事实 A 的验证结果。**
- 断点策略取决于事实 B（默认预期：什么都不用改）。
- 计量照 Phase 0 上报，`purpose: "compaction"`，**额外补上 `model`**（现在是空串）。

### 4.3 模型选择（顺带的成本项）

给 `SessionOptions` 加可选 `compactionLlmOptions?: Pick<LLMOptions, "provider" | "model">`，缺省沿用主会话。不接 ModelRouter —— 压缩不是 turn，套 `RouteRequest` 那套 signals 不合身；等真有多档需求再说。

### 4.4 摘要质量实测（Phase 2 的门槛，不通过不合并）

不是单测，是一次人工评测，结论写进 #31：

1. 准备 3 个真实会话样本：短（~10 条）、长（~60 条）、工具密集（含大量 Read/Bash 结果）。每个样本第 4 轮埋一条硬约束（如"不许改 public API"）。
2. 每个样本跑 A / B 各一次，记录：
   - 是否出现 tool_use（`toolChoice` 开与关两种都要跑）
   - 摘要是否保留了那条埋入的约束
   - 摘要长度、`cache_read` / `cache_creation` 拆分、端到端耗时
3. 通过标准：B 在三个样本上都不出现 tool_use、都保留埋入约束、且 `cache_read` 占输入主体。
4. **顺带产出**：B 的实测耗时决定"异步压缩要不要做"（review 文档第五节的排序论证）。把数据贴进 #31。

### 4.5 Phase 2 验收（新增测试）

| 用例 | 断言 |
|---|---|
| 路径小、时间戳新 | 选 inline；provider 收到的 messages 末条是指令、`system` 等于主会话 system、`tools` 非空 |
| 路径超过 inline 上限 | 选 standalone；provider 收到单条 user、空 tools |
| `lastLlmCallAt` 超过 TTL | 选 standalone |
| inline 调用失败 | 走 Phase 1 的 failed 路径（**不**自动回落 standalone —— 失败原因多为限流，重试一次同样会失败，且要遵守熔断语义） |
| 计量 | `onLLMCall` 收到 `purpose:"compaction"` 且 `model` 非空 |

---

## 五、风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 事实 B 不成立（断点真的整段重写） | B 的成本优势被吃掉一部分 | 加 `LLMOptions.cache: "read-only"`；先验证再实现，不预写 |
| B 的指令跟随不稳定（主 system 干扰） | 摘要质量下降，比 A 更糟 | 4.4 的实测是硬门槛；不通过就只落 Phase 0+1，B 留在 issue 里 |
| apiVersion 1→2 破坏外部实现 | 第三方 CompactStrategyPort 失效 | helios 目前无外部实现（仅官方 + noop + 4 个 fixture）；`pluginLoader` 的版本校验会 fail loud，不会静默跑错 |
| 熔断导致长会话后期完全不压 | 上下文持续增长直到 PTL | 这是**预期行为**，兜底交给 #32（PTL reactive）；Phase 1 的 notice 让用户能主动干预 |
| `systemPrefix` 上移影响首轮 | memory recall 时机提前几十毫秒 | 无语义变化（都在同一 run 内、都在 LLM 调用前） |

回滚粒度：三个 Phase 各自独立提交。Phase 2 可单独 revert 而保留 0+1（B 路线是 `chooseCompactRoute` 一个分支，去掉即回到纯 A）。

---

## 六、不在本计划内

- **#29 原文尾巴**（路线已定 = 原文尾巴）：契约已为它留好 `coveredMessageIds` 部分覆盖的位置，实施时只改 `compact-default.plan()` 按 token 预算切出 covered/kept 两段 + 加摘要验收规则，kernel 的 `snapCompactionCut` 不动。
- **#30 工具结果限长**、**#32 PTL 兜底**、**#34 命中率可观测**（#32 依赖本计划 Phase 1 的失败语义；#34 的 `caching` 字段是 4.1 条件 3 的前提，缺它时该条恒真，不阻塞）。
- **异步压缩**：等 4.4 的耗时数据。
