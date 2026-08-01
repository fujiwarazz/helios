# Agent Loop 审查报告

> 基于对 helios agent loop 全路径的通读:session.ts(sendMessage/streamAssistant/executeTools/rollback)、
> hookRunner.ts、events.ts、llm-anthropic/convert.ts、compact-default。
> 审查视角:一次完整 run 的执行路径、循环控制、流式状态机、工具执行与 hook、退出条件、错误处理。

---

## 严重 bug(会导致运行出错)

### Bug 1 — compact 未接进 loop,长对话必崩 ⭐最严重
- `session.ts` 的 `sendMessage` 全循环**从未调用** `ports.compact.shouldCompact` / `compact`。
- `ConversationState.approxTokens` **从未被计算/维护**(session 里无此状态)。
- 有 `CompactStrategyPort`、有 `compact-default` 实现、有 `compact_start/compact_end` 事件定义,但全是死的。
- **后果**:对话一长,全量历史喂 LLM → 撞模型上下文上限报错。plan 2.4 节"加载了也永不压缩",等于 compact Port 完全失效。

### Bug 3 — LLM 流错误直接 throw,run 半途炸裂 ⭐
- `session.ts:185` 收到 `error` 事件即 `throw`,异常穿透整个 sendMessage。
- **后果**:① `agent_end` 永不 emit → 监听方(UI/JSON-RPC)以为 run 仍在跑,卡死;② 已 append 的半截 assistant 消息污染下一轮;③ 该 turn 的 `turn_end` 不 emit。
- 网络抖动是常态,一次超时即让会话进入不一致状态。
- **应改为**:优雅结束 run + emit agent_end(带错误标记) + 保证历史一致。

### Bug 5 — maxTurns 用尽后产生"孤儿 tool_use" ⭐
- `session.ts:91` `while (turnIndex < this.maxTurns)`,达上限直接跳出 + agent_end。
- 若最后一个 turn 带 tool_use(正要执行工具却被 while 挡下)→ 历史留下无对应 tool_result 的孤儿 tool_use。
- **后果**:下次 sendMessage 时不配对的 tool_use 让 Anthropic API 直接 400(tool_use 必须紧跟 tool_result)→ **污染后续所有对话**。
- **应改为**:达上限时,若最后 turn 有 pending tool_use,要么补执行、要么剔除该 tool_use,并明确告知 LLM/用户已达轮次上限。

---

## 中等 bug

### Bug 2 — 每 turn 都 snapshot,快照爆炸
- `session.ts:96` 在 while 循环内**每个 turn 开头**都 `checkpoint.snapshot(turnId)`。
- 一个 run 10 个 turn = 10 次全目录复制(checkpoint-fs 是 `cp` 整个 workDir)。大仓库极慢 + 吃满磁盘。
- **应改为**:按 run 粒度(用户消息前)快照,或做增量快照。

### Bug 4 — tool_use 参数 JSON 解析失败被静默吞成 {}
- `session.ts:194 → parseJsonSafe(:336)` 解析失败**返回 `{}`**。
- 流式拼接偶因截断产生非法 JSON → 工具拿空参数执行(可能删错文件/查错),LLM 全然不知。
- **应改为**:解析失败作为 tool_result error 回传 LLM 让其重试,不拿 {} 硬跑。

### Bug 6 — tool_execution 事件不成对
- `session.ts:274` `tool_execution_end` 被 `listeners.size > 0` 门控,而 `:253` 的 `start` 无条件 emit。
- **后果**:run 中途订阅的 UI 可能收 start 无 end(或反之),事件不对称。
- **应改为**:start/end 一致处理(建议都不门控,emit 很便宜)。

---

## 轻微 / 设计隐患

### Bug 7 — 空 assistant 消息入历史
- `session.ts:206` 无论 content 是否为空都 append。LLM 返回纯 end_turn 无文本无工具时 → `content:[]` 空消息,Anthropic 可能报错。

### Bug 8 — Stop hook 注入消息 role=user,与真实用户输入混淆
- `session.ts:122` 注入 `role:"user"`。语义无大错但回溯/展示时无法区分"用户真说了话"vs"系统逼 LLM 续写"。建议加标记字段。

### Bug 9 — compact 产物 coveredMessageIds 无人消费
- 即便将来接上 compact,`Summary.coveredMessageIds` 返回后,loop 无"用 summary 替换被覆盖消息"的逻辑。
- 树模型下更需明确:summary 是**新增一个节点**还是**改写**?这一环缺失。

---

## 与树模型的交叉隐患

### Bug 10 — rollback 的 historyLenBefore 锚点,树化后失效
- `session.ts:39,95,323` 用"历史数组长度"做回溯锚点。
- 树化(history → nodes Map + headId)后,基于数组下标的锚点完全无意义。
- **提醒**:改树时 rollback/turnLog 这套要一起重写。之前的树方案已把 rollback 改成 `fork(nodeId)`,正好替代 historyLenBefore。

---

## 优先级

| 级别 | bug | 触发频率 | 后果 |
|---|---|---|---|
| P0 | 1 compact 死 | 长对话必然 | 崩溃 |
| P0 | 3 流错误炸裂 | 网络抖动(常见) | 会话卡死/不一致 |
| P0 | 5 孤儿 tool_use | 达 maxTurns | 污染后续对话(400) |
| P1 | 2 快照爆炸 | 多 turn run | 性能/磁盘 |
| P1 | 4 参数吞 {} | 偶发 | 工具误执行 |
| P1 | 6 事件不成对 | 中途订阅 | UI 状态错 |
| P2 | 7/8/9 | 边界 | 展示/兼容 |
| — | 10 | 树化时 | 需一并重写 |

**建议先修 1/3/5(三者独立,均在 session.ts,可一起改)** —— 分别对应"长对话崩""网络抖动崩""污染后续对话"三类必现/高频故障。
