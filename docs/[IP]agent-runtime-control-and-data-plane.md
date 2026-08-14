# 从 Agent Loop 到可恢复运行时：helios 的控制面与数据面演进

> 目标：把 helios 从“具备 agent loop 的可插拔框架”推进为一个**可恢复、可调度、可审计**的 Agent Runtime。本文聚焦运行时内核，不讨论具体 UI、模型供应商或单个工具的功能扩展。
>
> 参照实现：helios 当前 kernel；pi 的 `agentLoop` / `AgentHarness`；valos（`revan-core`、`vectorx-code`）的会话队列、生命周期和可观测性实现。

## 1. 结论

helios 已经拥有一个很好的“能力装配层”：Port/Plugin 边界清楚，消息树支持分支，具备 checkpoint、hook、模型路由、工具缓存与成本计量。这些能力目前主要以**独立功能**存在于 `Session` 与 `runTurnLoop` 周边。

下一阶段的核心不应是继续增加工具，而应把这些能力收束到两块一等公民的运行时基础设施：

```text
                    Agent Runtime
 ┌──────────────────────┬────────────────────────┐
 │  运行控制面          │  运行数据面            │
 │  Control Plane       │  Data Plane             │
 ├──────────────────────┼────────────────────────┤
 │ run 调度与输入队列   │ append-only 事件日志    │
 │ 生命周期状态机       │ 消息树 / 分支 / 快照    │
 │ 取消、审批、重试     │ 工具执行与产物记录      │
 │ 上下文预算与压缩     │ 队列、审批、运行状态    │
 │ 并发与资源冲突策略   │ 可重放、可查询的投影    │
 └──────────────────────┴────────────────────────┘
                         │
                  扩展与策略面
       Ports / Plugins / Skills / Hooks / Router / Eval
```

- **控制面**决定“下一步能不能运行、运行什么、何时停止”。
- **数据面**保证“发生过什么不会丢、重启后能确定地恢复、外部可以审计和重放”。
- **扩展与策略面**决定“能力如何接入、规则如何替换”，它应只通过前两者的稳定接口生效，不能绕过它们直接修改会话状态。

这会把 loop 从一个 `while`/递归调用链，升级为有明确边界和恢复语义的 runtime。

## 2. 当前基础与主要缺口

### 2.1 helios 已有的优势

1. **可替换的能力边界**：`PortRegistry` 将 LLM、文件、memory、compact、checkpoint、路由与成本等依赖从 kernel 中剥离，且有 noop 兜底。这为后续引入 scheduler、journal、artifact store 等运行时 Port 提供了依赖隔离基础；但当前 Session 仍承担过多运行职责，Port 本身还没有形成完整的数据面。
2. **树状历史**：`Session` 用 `nodes + headId` 表达消息树，回滚仅移动 HEAD，适合分支、审查和未来的并行探索。
3. **已经有 loop 的结构拆分**：`runTurnLoop`、`streamAssistant`、`executeTools` 分离，且 loop 通过 `SessionTreeCallbacks` 操作会话树，避免运行循环持有树内部状态。
4. **成本与缓存已经纳入运行时**：模型路由、成本计量、工具缓存、版本提供者都已进入 loop；这为统一决策提供了信号来源。

### 2.2 核心缺口

当前 `Session.sendMessage()` 仍同时承担：接收输入、运行调度、状态保存、压缩、内存召回、取消控制、事件发布和结果结算。`runTurnLoop` 虽然有 steering 扩展点，但它还不是会话调度器的一部分。

由此产生四类风险：

1. **并发输入无单一仲裁者**：同一 session 同时调用 `sendMessage()` 时，会竞争 `headId`、`currentAbort`、run index 与磁盘落盘顺序。
2. **运行状态不可恢复**：消息和 turn 记录可以保存，但正在执行到哪个状态、哪些工具已发起、哪些输入正在排队，没有统一的可恢复 journal。
3. **上下文治理只在 run 边界发生**：压缩发生在 run 开始处；工具输出或 steering 消息在中途增长后，下一次 LLM 请求仍可能超出上下文预算。
4. **事件更像 UI 通知而不是事实记录**：当前 `AgentEvent` 很适合流式渲染，却不足以作为恢复和审计的唯一事实源。

## 3. 运行控制面：把“循环”收紧为会话级调度器

### 3.1 单会话单 active run

每个 Session 应由 `RunCoordinator` 独占调度。它维护一个 active run，并将新输入按意图分流：

| 输入类型 | 语义 | 消费时机 |
| --- | --- | --- |
| `start` | 空闲会话的新任务 | 立即启动新 run |
| `steer-next` | 对当前工作进行引导 | 当前 turn 完整结束、下一次 LLM 前 |
| `follow-up` | 不打断当前工作的新需求 | agent 自然停止后 |
| `replace` | 用户明确要求改做另一件事 | 先取消 active run，再新建 run |

这借鉴 pi 的 steering/follow-up 双队列，以及 valos 的 `SessionInputQueueService`。关键不是复制其实现，而是明确以下不变量：

- 一个 session 任意时刻至多一个可写消息树的 run；
- 一个取消令牌只属于一个 run，不能用 session 级单槽覆盖；
- 每条输入都有 `queued / dispatching / applied / cancelled` 状态；
- 取消时尚未应用到对话树的输入回到队列，而不是静默丢失。

这会直接解决当前 `currentAbort` 单槽与并发 `sendMessage()` 的竞态，也让 UI 能真正表达“排队、下一轮插话、等待完成”。

### 3.2 显式状态机，而非散落的布尔值

建议让一个 run 有可观察的状态与严格转移：

```text
idle → preparing → compacting → streaming
                         ├→ awaiting_approval → executing_tools ─→ preparing (next turn)
                         ├→ completed ─────────→ terminal
                         ├→ cancelled ─────────→ terminal
                         └→ failed / max_turns / policy_denied → terminal
```

只有“本轮完成且策略要求继续”或“工具执行后仍有待处理 turn”可以回到 `preparing`；`failed`、`max_turns`、`policy_denied` 和 `cancelled` 都是 run 的终态，最终汇聚到 `RunFinished`。当前 `Session.sendMessage()` 对 `runTurnLoop`、compact 和 hook 异常缺少统一的 `try/finally` 收尾，因此状态机落地时必须保证异常路径也清理 `currentAbort`、关闭 turn，并发出终止事件。

每个 terminal state 都要有标准 reason：`completed`、`cancelled`、`max_turns`、`model_error`、`tool_error`、`policy_denied`、`context_exhausted`。现有 `agent_end.error` 和 `reachedMaxTurns` 可演进为这一模型，而不应继续增加布尔字段。

状态机的价值：

- 取消只在状态边界改变调度，不会产生“已取消但又启动下一 turn”；
- 审批等待成为正式状态，而非挂在工具调用 Promise 中；
- 重试、compact、工具执行的可观测时间可以按状态计算；
- 恢复时只需基于最后一个持久化状态决定补偿策略。

### 3.3 上下文预算应在每次 LLM 前治理

pi 的 `transformContext` 在每次 provider request 前执行；valos 的 `chatLoop` 也在递归下一轮前调用 compact。helios 应引入 `prepareContext()`，成为 `streamAssistant()` 的唯一前置阶段：

1. 计算完整请求预算：稳定 system prefix、动态上下文、有效消息路径、已启用工具 schema、预留输出 token；
2. 若超出阈值，先做微裁剪（大工具输出摘要/外置 artifact），再做 branch-aware compact；
3. compact 后重新计算预算；仍无法满足时，切换模型、要求用户确认，或以 `context_exhausted` 结束；
4. 为本请求产出 `ContextSnapshot`，连同实际 provider usage 写入数据面。

现有 `approxTokens(path)` 仅统计消息路径，不包括 system 与 tools；它可保留为廉价预估，但不应作为唯一的治理口径。

`prepareContext()` 还必须统一处理 steering、retry 和 compact：steering 消息何时追加到消息树、何时只作为本次 provider context、何时持久化，都要有明确规则；重试 attempt 不能重复 append 正式 assistant 节点。这样可以避免“内存里的 lead messages”和实际发送给 provider 的消息路径不一致。

### 3.4 工具执行从批处理规则升级为调度策略

当前策略是“整批工具全部标为 parallel 才并行，否则全部串行”。这安全但过度保守。应把工具声明扩展为调度元数据：

- `resourceClaims`: 例如 `workspace:read`、`workspace:write`、`network`、`browser:<profile>`；
- `idempotency` 与 `retryPolicy`；
- `approvalScope` 与 `sideEffectLevel`；
- `executionTimeout` 与 output 上限。

调度器据此形成并发组：多个 read 可以并行；write 与同工作区 read/write 依赖冲突；独立网络请求可并行。pi 的“先逐个 prepare，再并发执行”是合适的执行骨架，helios 可在此之上加资源锁。

### 3.5 工具 pipeline 必须闭合

工具调用应统一进入：

```text
schema validate → policy / approval → start → execute / progress →
normalize output + artifact → post-policy → end
```

目前 `Tool.inputSchema` 的注释明确是“仅用于告知 LLM”，`execute(input)` 接受任意输入；并且 PreToolUse deny、审批拒绝或未找到工具的路径会发出 `tool_execution_end` 而没有对应的 `tool_execution_start`。这会破坏消费端状态机，也给工具实现留下安全隐患。运行时应固定 JSON Schema dialect 与 validator，限制 schema 深度/正则复杂度，并把 validation error 归一化为可安全返回模型的结构化错误。

每一个 tool-use id 必须有一次且仅一次：`requested → started → (zero or more progress) → ended`。被拒绝、参数非法、未找到工具、缓存命中和取消都必须走同一生命周期，并在结果中表达来源与原因。durable tool record 还应包含 `executed`、`cacheHit`、duration、output truncation、artifact refs、side-effect level，以及 hook 改写前后 input 的 provenance；当前只记录 `toolUseId/name/output/isError` 不足以支撑审计投影。

## 4. 运行数据面：让会话成为可恢复的事实流

### 4.1 消息树不是完整运行记录

消息树适合回答“模型看到了什么”，但不能完整回答：

- 某工具是否已经真正执行过；
- 它的副作用是否可能完成；
- 用户输入在重启前是否已应用；
- 当前 run 是断在 streaming、approval 还是 tool execution；
- 一个模型重试是否生成了被丢弃的 partial output。

因此应将会话的事实记录与派生视图分离。

### 4.2 Append-only Runtime Journal

建议每个 session 写一份带版本的 append-only journal（例如 `runtime.jsonl`），并将消息树、turn 索引、队列和 UI 历史视作投影。Phase 2 的最小 durable 事件集合至少应覆盖：

```text
RunQueued / RunStarted / RunCancelled / RunFailed / RunFinished
InputQueued / InputApplied / InputCancelled
ContextPrepared / ContextBudgetCalculated / TurnStarted / TurnCommitted
LLMAttemptStarted / LLMAttemptFinished
AssistantStarted / AssistantDelta / AssistantCommitted / AssistantFailed
ToolRequested / ApprovalRequested / ToolApproved | ToolDenied
ToolStarted / ToolProgress / ToolCompleted / ToolExecutionUnknown
CheckpointRequested / CheckpointCompleted | CheckpointFailed
CompactionCommitted
NodeAppended / BranchCreated / BranchForked / BranchSelected / HeadMoved
HookInvoked / HookDecisionRecorded / HookErrorRecorded
```

这里的关键区分是：

- `AssistantDelta` 是可选的流式体验数据，可按策略采样或单独存储；
- `AssistantCommitted`、`ToolCompleted`、`TurnCommitted` 是恢复所需的 durable facts；
- `RunFinished` 必须包含标准 terminal reason、成本、模型实际配置与最终 HEAD；
- schema 需要 `eventId`、`sessionId`、`runId`、`turnId`、`attemptId`、`causationId`、时间戳、单调 sequence 和版本号。

`NodeAppended`、`BranchCreated`、`BranchForked`、`BranchSelected` 和 `HeadMoved` 不能省略。当前 `Session.restore()` 主要根据 `turns.jsonl` 重建线性路径，无法恢复所有跨 resume 的分支选择；如果数据面要承诺消息树恢复，journal 必须记录 `nodeId`、`parentNodeId`、`branchId` 与当前 HEAD。已有 `compactions.jsonl` 也应纳入同一版本化恢复协议，而不是只在内存中解释压缩记录。

`AssistantDelta` 可以按策略采样或另存流文件，但 durable 事实至少要保留 `AssistantCommitted`。`LLMAttemptStarted/Finished` 用于区分同一 turn 的重试次数、模型切换和最终提交结果，避免把失败 attempt 的 partial output 或 usage 误当成正式 assistant 消息。

### 4.3 Commit 边界与副作用恢复

工具的外部副作用不能被消息树“回滚”。因此恢复策略必须诚实区分：

| 中断位置 | 恢复动作 |
| --- | --- |
| `ToolRequested` 前 | 安全重试 |
| `ToolStarted` 后、无完成记录 | 标记为 `unknown_outcome`；默认不自动重试副作用工具 |
| `ToolCompleted`、未 `TurnCommitted` | 重建 tool result，再提交 turn |
| `TurnCommitted` 后 | 继续下一 turn 或结束 run |

对于可重试的只读工具，使用稳定的 tool invocation id + 幂等 key；对于写操作，使用 checkpoint/diff 作为补偿材料，而不是假装可以精确回滚所有副作用。

现有 checkpoint 应由“每 turn 开头必做”转成由策略决定：run 前快照、写工具前快照、或 Git 增量快照。`CheckpointRequested`、`CheckpointCompleted`、`CheckpointFailed` 必须区分；请求成功不等于快照已经可恢复。journal 记录 checkpoint 与工具调用的因果关系，回滚页面才能解释“会恢复到哪里、哪些外部效果无法撤销”。

### 4.3.1 Journal 的 durable 约束

Phase 2 不能只把现有 UI event 追加到 JSONL。至少需要：

- 单 session 单写者（或显式 lease），保证 event sequence 单调递增；
- append 后 flush，必要时 `fsync`；批量提交使用临时文件 + atomic rename；
- 每条事件包含 schema version、sequence、checksum 或可检测的截断标记；
- 启动时检测末尾半条/损坏事件，按最后一个完整 commit 恢复并记录 recovery marker；
- 明确 retention、分段和 backpressure，防止流式 delta 无限增长；
- schema migration 与旧 `turns.jsonl` / `compactions.jsonl` 的一次性导入策略。

推荐的写入顺序是：`command → decision → durable event → external side effect → completion event → commit`。对幂等操作必须携带 invocation key；对非幂等操作必须允许恢复为 `unknown_outcome`，不得自动重复执行。

### 4.4 稳定前缀与动态上下文分层持久化

helios 当前把 base system、首次 memory recall、SessionStart context 冻结为 `systemPrefix`，有利于 prompt cache，但会让多任务长会话中的 memory 失去时效。

建议持久化三层上下文：

1. **StablePrefix**：系统规则、已加载能力、会话长期约束；版本化并尽可能稳定，以获得 cache 命中。
2. **RunContext**：本轮任务的 recall、工作区状态、用户提交时的 hook context；作为本 run 的 ephemeral user/system attachment。
3. **ContextSnapshot**：每次实际请求发送的逻辑组成和 token 预算，用于重放与成本解释。

这样可以同时得到缓存稳定性与任务相关性，不必在“每会话冻结”与“每轮重算”之间二选一。

### 4.5 投影与审计接口

journal 之上至少提供以下只读投影：

- `ConversationProjection`：当前 HEAD 和历史分支；
- `RunProjection`：状态、耗时、模型、成本、终止原因；
- `ToolProjection`：输入摘要、审批、输出、artifact、缓存命中与副作用级别；
- `QueueProjection`：待执行输入及其优先级；
- `AuditProjection`：谁/哪条 hook/哪个 policy 改写、拒绝或批准了什么。

这比仅靠 UI event 更适合 CLI、Web、Electron 和自动化 API 共享同一事实源。审批是可恢复的交互子流程，应持久化 `ApprovalRequested`、`responseId`、发起者、创建/过期时间和 `ApprovalResolved`；重启后过期请求回到 `awaiting_approval`，不能默认放行。

## 5. 扩展与策略面：保持 helios 的 Port 优势

控制面和数据面不应取代 Port；它们应成为 Port 的统一落点。

### 5.1 适合保留为 Port 的能力

- `LLMProvider`、`ModelRouter`、`CompactStrategy`、`Memory`、`Checkpoint`；
- `ToolResultCache`、`VersionProvider`、`CostMeter`；
- sandbox、artifact store、journal store、scheduler、lease 等环境依赖。

### 5.2 不应再散落在 Hook 中的能力

hook 很适合策略和观察，但不应直接承担关键运行控制：

- Hook 可提出 deny/ask/modify 建议，最终由 ToolExecutor 的 policy stage 记录并执行；
- Hook 可请求继续/停止，最终由 RunCoordinator 做状态转换；
- Hook 异常必须写入 audit event，不能像现在的 `allSettled` 一样只静默丢弃；
- 对输入/输出的多个改写应有可解释的顺序与 provenance，而非只保留最终值。

### 5.3 Harness 应成为能力组合器

pi 的 `createCodingAgentHarness` 值得借鉴的不是固定四个工具，而是：工具可以贡献 prompt snippet、guideline、执行环境和动态 active set。helios 可定义 `HarnessComposition`：

```text
specialty / skill / capability
  → tool definitions + prompt contribution + policy + renderer + eval fixtures
  → HarnessComposition
  → StablePrefix + ActiveToolSet + RuntimePolicy
```

这使 deferred tool、skill、专用工作区规则都沿同一通道接入，并避免“所有工具、所有规则永久塞进 system prompt”。

## 6. 可扩展性、稳定性与审计性的收益

| 维度 | 采用控制面 + 数据面后的收益 |
| --- | --- |
| 可扩展性 | 新增模型、工具、队列策略、sandbox 或审批方式只实现稳定接口，不直接侵入 Session 主流程。 |
| 稳定性 | 并发输入、取消、断流、审批和工具错误都有明确状态与恢复路径，避免半完成 run 污染下一请求。 |
| 可恢复性 | 进程退出后可从 durable journal 精确恢复到最后 commit 边界，外部副作用以 `unknown_outcome` 诚实处理。 |
| 可审计性 | 每次模型选择、上下文压缩、hook 改写、审批与工具结果均有因果链和可查询投影。 |
| 成本治理 | ContextSnapshot 和实际 usage 连接起来，可以解释某次成本来自哪些上下文、工具、重试与模型切换。 |
| 测试性 | journal 可驱动 deterministic replay；可为取消、重试、compact、并发输入写不依赖真实模型的 conformance tests。 |

审计数据本身也需要安全边界。输入、工具参数、源码片段、模型输出和 hook context 可能包含 token、个人数据或商业代码。AuditProjection 应支持字段级 redaction、加密存储、按 session/workspace 的 ACL、查询审计和可配置保留期；默认不把完整 secret 或大段工具输出复制到长期审计索引。

## 7. 推荐分期

### Phase 1：收紧控制面（最优先）

1. 引入 session 级 `RunCoordinator`，单写锁/lease，禁止并发写树；
2. 接通 steering/follow-up/input queue，并通过最小 journal writer 持久化输入状态（不再依赖尚未存在的独立 QueueStore）；
3. 定义 run 状态机和 terminal reason；
4. 修复 tool lifecycle：schema validate、所有路径成对 start/end、标准取消与拒绝结果；
5. 每次 LLM request 前运行 `prepareContext()`。

### Phase 2：建立最小数据面

1. 建立 append-only writer、sequence/checksum、atomic flush 和损坏尾部恢复；
2. 写入完整 durable facts：run、input、LLM attempt、审批、工具、checkpoint、commit 和 branch/head；
3. 从 journal 重建 run、队列、消息树与工具投影；
4. 将 checkpoint 与写工具的因果关系落盘；
5. 提供 restart/recovery 的 conformance tests。

这一阶段至少覆盖以下崩溃恢复矩阵：

| 崩溃位置 | 可恢复动作 |
| --- | --- |
| `ApprovalRequested` 后 | 按 `responseId` 恢复等待；过期则重新询问 |
| `InputQueued` / `dispatching` | 根据 lease 超时退回 queued，保留 priority/order |
| `ToolStarted` 后 | 只读工具可按幂等 key 重试；副作用工具进入 `unknown_outcome` |
| `CheckpointRequested` 后 | 只有存在 `CheckpointCompleted` 才允许作为恢复点 |
| `TurnCommitted` 后 | 重建 HEAD，继续下一 turn 或完成 run |

### Phase 3：策略与效率提升

1. 资源声明驱动的工具并发组；
2. StablePrefix/RunContext/ContextSnapshot 三层上下文；
3. 动态 active tool set、specialty/skill contribution；
4. artifact store、tool progress、回放评测和审计 UI。

## 8. 不建议照搬的部分

- 不建议采用 valos `chatLoop` 的递归式驱动作为 helios 主循环；helios 已有更适合状态机化的 `runTurnLoop` 分层。
- 不建议让 Session 膨胀成既是状态机、又是存储、又是策略、又是 UI adapter 的巨型对象。
- 不建议为了持久化而直接把 UI 流事件当 event sourcing；流 delta 与 durable commit 的可靠性要求不同。
- 不建议以“能回滚消息树”承诺“能回滚所有工具副作用”；副作用恢复必须按工具幂等性和 checkpoint 能力建模。

## 9. 落地后的目标形态

最终，`Session` 应主要是会话身份和投影入口；`RunCoordinator` 驱动状态机；`RuntimeJournal` 保存事实；`ContextManager` 准备请求；`ToolExecutor` 管理工具事务；Port/Plugin 继续提供可替换的底层能力。

这条路径充分利用 helios 已有的优势：消息树、Port 架构和成本运行时都保留；改造重点是为它们建立统一的运行控制面和数据面，而不是重写 agent loop。
