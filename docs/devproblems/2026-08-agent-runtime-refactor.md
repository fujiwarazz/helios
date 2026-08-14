---
topic: agent-runtime-refactor
status: active
created: 2026-08-11
sources:
  - packages/kernel/src/session.ts
  - packages/kernel/src/agentLoop/runTurnLoop.ts
  - packages/kernel/src/agentLoop/executeTools.ts
  - packages/kernel/src/hookRunner.ts
---

# Agent Runtime 重构：难点与问题记录

本记录来自对 agent loop、harness、压缩、工具执行与会话恢复的代码核验，以及多轮架构评审。它区分当前已确认缺陷、实施方案本身的风险、以及暂缓的长期演进项。

## 汇总索引

| ID | 分类 | 严重度 | 状态 | 一句话 |
| --- | --- | --- | --- | --- |
| DP-001 | observability | P1 | 待修 | Hook handler 异常被静默吞掉，排障没有证据。 |
| DP-002 | tool-contract | P1 | 待修 | deny / 审批拒绝工具调用只有 end 事件，没有 start。 |
| DP-003 | context-compaction | P1 | 待设计 | compact 只在 run 起点检查，长 run 后续请求可超预算。 |
| DP-004 | context-compaction | P0 | 已识别 | 中途 compact 的朴素锚点与首轮重复压缩方案会破坏 `newMessages`。 |
| DP-005 | persistence-recovery | P1 | 条件性 | resume 线性重建，跨重启分支不可恢复。 |
| DP-006 | persistence-recovery | P2 | 条件性 | 现有全量重写持久化不适合承诺精确崩溃恢复。 |
| DP-007 | architecture-scope | P1 | 已决策 | RunCoordinator / event journal 需要真实需求触发，不能因理论风险立即上马。 |
| DP-008 | testing-review | P1 | 待修 | “永远 compact”的 fixture 会掩盖真正的上下文边界错误。 |
| DP-009 | testing-review | P2 | 已更正 | “未找到工具缺 start”是错误诊断，已校正。 |

---

## DP-001：Hook 异常被静默吞掉

- 分类：`observability`、`runtime-control`
- 严重度：P1
- 状态：待修
- 标签：`hook` `error-handling` `fail-open`

### 事实

`HookRunner.settleAll()` 使用 `Promise.allSettled()` 隔离 handler 异常，但 rejected 结果直接映射为 `undefined`。调用方没有日志、事件或计数器，因此 SessionStart、PreToolUse、Stop 等任意 hook 出错都没有可见痕迹。

### 影响

- 用户和维护者无法区分“hook 没配置”“hook 返回空结果”“hook 执行报错”。
- PreToolUse 出错会被合并为默认 allow，当前是 fail-open 行为；对审批/安全类 hook 需要特别谨慎。

### 最小修复方向

为 `HookRunner` 注入 `Logger`，在每个 event 的 rejected handler 上记录 event name、错误摘要和必要的 handler 标识。保持当前合并语义不变，但明确本期只解决可观测性，不把 fail-open/fail-closed policy 混入同一改动。

### 验证

- Error 与非 Error rejection 都会产生日志；
- 单个 handler reject 不影响其他 handler 的决策结果；
- 全部 reject 时保留现有默认决策，并有测试锁定该语义。

---

## DP-002：工具生命周期在拒绝路径不闭合

- 分类：`tool-contract`
- 严重度：P1
- 状态：待修
- 标签：`tool` `events` `approval`

### 事实

`executeTools.runOneToolCall()` 中，参数解析失败会 emit start/end；正常执行、缓存命中和未找到工具也会 emit start/end。只有 PreToolUse 的 `deny` 与用户拒绝 ask approval 两条路径会直接 `finish()`，因此只 emit `tool_execution_end`。

### 影响

消费端无法安全地按 toolUseId 构建状态机；会出现“没有开始却已结束”的工具卡片或指标。

### 修复难点

不能简单把 start 提到 PreToolUse 之前而不定义 input 语义：当前正常路径的 start 使用 hook 改写后的 input；提前后则会变成原始模型 input。拒绝路径和允许路径必须采用同一约定。

### 最小修复方向

保留正常路径“PreToolUse 改写后再 start”的语义，并为 deny / ask-reject 在返回前走同一 `emitStartOnce()` 辅助函数。明确 `tool_execution_start.input` 表示哪个阶段的 input；若需要同时审计原始与改写参数，另行增加字段/事件。

### 验证

- parse error、deny、ask-reject、unknown tool、cache hit、正常执行均严格一对 start/end；
- PreToolUse 改写 input 后，start 与实际 execute 的 input 一致；
- 不以仅统计事件数量替代对 toolUseId 和 input 语义的断言。

---

## DP-003：Context compact 的检查时机不足

- 分类：`context-compaction`
- 严重度：P1
- 状态：待设计
- 标签：`compact` `context-window` `cost`

### 事实

`Session.maybeCompact()` 只在 `sendMessage()` 进入 run 时调用一次。后续 turn 的工具输出、stop hook 注入和未来的 steering 输入都可能显著扩大有效路径；`runTurnLoop` 在每轮请求前直接取 `pathToHead()`。

### 影响

长 run 可能在同一 run 的后续 LLM 请求上超过模型上下文预算。`approxTokens(path)` 还不计 system prefix、工具 schema 和预留输出，因此它只能作为保守启发式，不能视为完整请求预算。

### 约束

每轮治理不能压缩掉本轮尚未被模型消费的 user lead message；也不能让 retry 重复写入正式 assistant 节点。

### 修复方向

将“构造最终 provider messages + 预算检查 + 必要压缩”收口为每次请求前的 `prepareContext()`。第一阶段可保留 run-start compact，并只在 `turnIndex > 0` 进行中途检查；是否统一为单一入口应由回归测试验证后再决定。

---

## DP-004：中途 compact 会改变有效路径，朴素锚点方案错误

- 分类：`context-compaction`、`persistence-recovery`
- 严重度：P0
- 状态：已识别
- 标签：`compact` `message-tree` `newMessages`

### 事实

将 `newMessages` 的长度切片改为“run 开始前 HEAD 节点 id”并不安全。run-start compact 已可能将该 HEAD 覆盖为 summary；中途 compact 也可能覆盖本 run 已追加的节点。此时旧节点不在 `pathToHead()` 的有效路径中，`findIndex()` 返回 `-1`，`slice(0)` 会错误返回整个有效历史。

### 影响

- `sendMessage()` 返回值、`agent_end.newMessages` 和 UI 历史合并可能包含旧历史或 summary；
- 测试只检查 compact event 数量时无法发现此错误；
- 过早重复 compact 还可能把当前 user message 压缩后才发给模型。

### 修复方向

不要直接将物理节点 id 当作有效路径索引。先定义 `newMessages` 的语义：它是“物理新增节点”“本 run 对用户可见的逻辑消息”，还是“最终有效 path 的增量”。随后采用与语义一致的 run-scoped message id 集合或 compaction-aware projection。第一阶段应避免 turn 0 的重复 compact，直到该语义和回归测试确定。

### 验证

- run-start compact 后，返回值不包含旧 summary/历史；
- 中途 compact 后，当前用户输入仍在实际 provider 请求中；
- branch、rollback、resume 与 toolResult 配对测试均保持通过。

---

## DP-005：跨 resume 的消息树分支不可恢复

- 分类：`persistence-recovery`
- 严重度：P1
- 状态：条件性
- 标签：`resume` `branch` `message-tree`

### 事实

`restore()` 回放 `turns.jsonl` 时通过 `appendNode()` 线性重建 parentId；当前注释也说明旧分支跨 resume 不保留。`compactions.jsonl` 已经落盘且会读取恢复压缩视图，问题不在 compaction 文件不存在，而在节点/分支选择本身没有持久化。

### 影响

如果用户已实际依赖分支切换、跨重启回溯，恢复后会丢失分支结构。

### 决策门槛

当前本地单用户场景下尚未确认真实痛点。先记录并保留设计约束；当分支 resume 成为用户功能承诺时，再引入 node/branch/head 持久化，而不是先建设完整 event journal。

---

## DP-006：现有持久化不能承诺精确崩溃恢复

- 分类：`persistence-recovery`
- 严重度：P2
- 状态：条件性
- 标签：`turns-jsonl` `crash-recovery` `checkpoint`

### 事实

turn 持久化当前以全量重写 `turns.jsonl` 和 `meta.json` 实现，写失败只 warn 后继续；这足以支撑当前朴素 resume，但没有 sequence、atomic commit、损坏尾部策略、工具副作用状态或跨文件事务。

### 影响

不能把它描述为 append-only event sourcing 或“精确恢复”；在工具副作用中断时也不能自动判断是否可安全重试。

### 决策门槛

只有出现实际崩溃恢复、跨进程/多宿主、审计或任务队列需求时，再评估增量增强（原子写/校验/额外字段）还是完整 journal。当前不以理论完备性为由立即引入 lease、分段、hash chain 等复杂机制。

---

## DP-007：长期架构与当前规模的 ROI 不匹配

- 分类：`architecture-scope`
- 严重度：P1
- 状态：已决策
- 标签：`yagni` `run-coordinator` `journal`

### 事实

RunCoordinator、完整运行状态机、steering/follow-up 队列、append-only journal 都能解决未来的调度和恢复需求，但当前 helios 是本地单用户项目，尚未有已复现的并发 sendMessage 或跨进程写入痛点。

### 决策

保留“控制面 / 数据面 / 扩展策略面”作为长期分类法，不把它直接等同于近期实施清单。

### 触发条件

- UI/CLI/自动化出现同 session 并发提交；
- 用户要求 steering、排队、恢复待审批任务；
- 分支跨 resume 成为承诺能力；
- 已发生真实的崩溃恢复或审计追踪需求。

---

## DP-008：测试 fixture 不能制造非真实的 compact 循环

- 分类：`testing-review`
- 严重度：P1
- 状态：待修
- 标签：`test` `fixture` `compact`

### 事实

以“每次 `shouldCompact()` 都返回 true”的 fixture 证明中途 compact，会同时触发 run-start、turn 0 与所有后续 turn 的压缩。这既可能压缩当前 user message，也会掩盖应该验证的“工具输出增长后在下一轮触发一次压缩”的路径。

### 修复方向

采用状态化 fixture：第一次 false、工具结果后 true、压缩后再 false。把 compact 次数、provider 实际收到的 messages、`newMessages`、tool-result 配对与分支隔离作为独立断言。

---

## DP-009：评审发现了不准确的代码结论

- 分类：`testing-review`
- 严重度：P2
- 状态：已更正
- 标签：`review` `evidence`

### 事实与更正

早期报告曾将“unknown tool 缺少 `tool_execution_start`”与 deny / ask-reject 并列。代码核验表明 start 在 `toolRegistry.get()` 之后、`if (!tool)` 之前发出，unknown tool 实际有配对 start/end。

### 经验

实施计划必须逐条附上具体控制流证据；对“某条路径缺事件”的结论至少覆盖成功、拒绝、未知和异常四类分支。评审结论也应允许更正，而不是为了保持原方案一致性继续扩散错误前提。
