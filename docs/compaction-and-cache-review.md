# 上下文压缩与 prompt cache：评审结论与取舍记录

状态：设计记录（2026-08-17）。本文只记结论与取舍，不含实施细节；具体改动拆成 issue 追踪，清单见文末。

参考材料：

- `docs/cache-hit-report.zh-CN.md` —— Reasonix（Go 版 coding agent）的前缀缓存命中率架构剖析
- Claude Code 四层压缩管线（`learn.shareai.run/zh/s08/`，附 CC 源码常量对照）
- valos（`modules/code-agent`，本组织内部 agent）的压缩与记忆实现
- helios 既有记录：`docs/branch-tree-and-prompt-cache.md`（缓存纪律一/二）、`docs/cost-optimization-layer.md`

---

## 一、两笔独立的账：cache 与 compaction 不能互相替代

这是本轮评审最重要的结论，先于所有具体方案。

| | 解决什么 | 手段 | 不解决什么 |
|---|---|---|---|
| **prompt cache** | 每轮重发 input token 的**单价**（命中约 1/10）+ 首 token 延迟 | 前缀字节稳定 | 不减少 token 数量，**不减少窗口占用** |
| **compaction** | input token 的**数量** + 窗口占用（避免 `prompt_too_long`） | 改写历史 | **必然打掉缓存** |

推论一：**命中缓存的 token 仍然计费、仍然完整占用上下文窗口。** 所以"窗口快满了"缓存帮不上，只能靠压缩；"每轮重发很贵"也不能靠压缩长期解决。

推论二：压缩后 provider 实收的消息是 `messageTree.ts` 投影出的 `[summary 节点] + [firstKeptId 之后的尾巴]`，被覆盖的部分不再出现在请求里 —— 与上一轮请求逐字节比对，**分歧点在 tools 之后立刻发生**。能继续命中的只有 `system + tools`（即 `llm-anthropic/convert.ts` 里 `cachedSystem()` 覆盖的范围）。再聪明的摘要都躲不掉这一次全量 miss。

推论三（压缩的损益模型）：**一次性付「一次全量 miss + 一次摘要调用」，换后续每轮更短的输入。** 平衡点取决于压完之后还能跑多少轮。这解释了两个看似随意的参数为什么必要：

- Reasonix 要求"候选 ≤ 窗口 50%，典型落地 10–30%，且不向 50% 回填" —— 留出足够长的免维护区间摊销这次 miss；
- 反面是 CC doctor 的告警"过小的窗口导致频繁 compaction 降低缓存命中率" —— 压完立刻又逼近阈值，就会陷入「每次都全量 miss + 每次都付摘要费」，比不压更贵。

所以"压缩后保留多少"不是随手选的参数，它决定压缩到底省钱还是烧钱。

---

## 二、CC 四层管线：哪些能抄，哪些不能

CC/s08 的原则是"便宜的先跑，贵的后跑"；Reasonix 的原则是"单阈值、单次事务、阈值以下零改写"，并明确批判多级阈值。两者**直接冲突**。

真正的分界线不是"便宜/贵"，而是**改写的是「已经发给过模型的字节」还是「刚产生、还没发出去的字节」**：

| 层 | 作用对象 | 改写已发送前缀 | 对 cache | helios 取舍 |
|---|---|---|---|---|
| L3 `tool_result_budget` | **最后一条** user 消息里刚产生的 tool_result | 否 | 无损 | **抄**（= Reasonix §5.4「首次可见时限长，之后永不重截」，两家在此一致） |
| Read dedup（`FILE_UNCHANGED_STUB`） | 新产生的 tool_result | 否 | 无损 | **不做**，前提不成立，见第五节 |
| L2 `micro_compact` | 历史里的旧 tool_result 换占位符 | 是 | 改写点之后全 miss | **不抄** |
| L1 `snip_compact` | 裁掉中间消息 | 是 | 同上 | **不抄**（仅保留为 PTL 兜底形状，见第四节） |
| L4 `compact_history` | 整段替换 | 是（阈值触发一次） | 一次性 miss | 抄（helios 已有） |

**L1/L2 不抄的理由**：CC 缓解 micro_compact 缓存损失的手段是 **API 层的 `cache_edits`**（cached 路径），那是 Anthropic 自家能力，helios 拿不到。没有它，每次 micro_compact 都让整条前缀从改写点起全额重付 —— 省下的是"不再重发旧结果"，付出的是"剩下的全部前缀按 miss 价重算"，长会话里后者大概率更贵。s08 自己也注明了"可能降低 prompt cache 命中率"。

> 记录这条是因为：后人看到 s08 会很自然地想按 L1→L4 全抄。

---

## 三、压缩调用的两条路线（A / B）与路由条件

现状（路线 A）：`compact-default` 自建一次**独立空调用** —— 小 system（`SUMMARIZER_SYSTEM`）+ 把对话渲染成一条 user 消息 + 空 tools。缓存命中为 0。

候选（路线 B）：在**主会话前缀之后追加一条压缩指令**发出去 —— `[主会话 system + tools + 完整路径 + 压缩指令]`，前缀几乎全命中。产物不进树（临时数组，不 `appendNode`）。

按 Sonnet 价（input \$3/MTok、cache read \$0.30、cache write \$3.75、output \$15），设 S=10k（system+tools）、H=120k（真实历史）、H_a=40k（A 渲染截断后）、O=2k：

| 路线 | 输入计费 | 合计 |
|---|---|---|
| A | 40k × \$3 | **\$0.15** |
| B（缓存热） | 130k × \$0.30 | **\$0.069** |
| B（缓存已过期） | 130k × \$3 | **\$0.42**（比 A 贵 2.8x） |
| B（误打新断点） | 130k × \$3.75 | **\$0.52**（最贵） |

分界条件：`B_warm < A ⟺ S + H_b < 10 × H_a`。长会话通常成立；反例是历史里净是被 `MESSAGE_CHAR_LIMIT=4000` 狠截的巨型 tool_result（H_b/H_a > 10），但那种情况 B 也过不了窗口检查。

**路由规则：**

```
走 B ⟺ ① S + H_b + 输出预算 装得进窗口（否则必 PTL）
     且 ② now - lastLlmCallAt < provider 缓存 TTL（Anthropic ephemeral 默认 5min；
           自动缓存 provider 如 DeepSeek 硬盘缓存按小时算，可放宽）
     且 ③ 本次调用禁用新断点
否则走 A
```

A 由此从"唯一路径"降级为"窗口不够或缓存已冷时的兜底"。

**③ 是实现层陷阱**：`applyCacheBreakpoints` 目前无条件执行。若压缩调用也走它，会为「整段历史 + 压缩指令」这个前缀**新写一份缓存**（1.25x 计费），而这份缓存**永远不会再被命中**（后续没人会再发这个前缀）。纯浪费，且是四种组合里最贵的。

**B 的两个风险与消除手段：**

1. tools 在场 → 模型可能调工具而非输出摘要。首选 `tool_choice: "none"`（禁止本次产生 tool_use，且**不改 tools 数组**故不砸缓存）；需先核实 `@anthropic-ai/sdk` 0.32 是否支持 `{type:"none"}`。不支持则退回 CC 的首尾双重防呆 prompt（`CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.`）。
2. 主会话 system prompt（满是出码规则与工具指引）干扰摘要任务的指令跟随。**这条无法靠推理定，必须实测**：固定 3~5 个真实会话样本（长短各一、含大量工具调用的一个），A/B 对照三项 —— 是否出现 tool_use；摘要是否漏掉埋在样本里的关键约束；摘要长度是否稳定小于被折叠区间。

**B 的额外收益（超出成本本身）：**

- **延迟**：命中缓存免 prefill，而长历史的 prefill 正是首 token 延迟的主要来源。压缩目前是 `await this.maybeCompact(runId)` 前台阻塞在 run 启动前，用户直接可感知。
- **摘要质量更高**：现状 `compact-default` 的 `textOf()` 把 `tool_use` 压成 `[tool_use Bash]`（**参数全丢**）、`tool_result` 压成 `[tool_result]`（**整块丢**），再按每条 4000 字符截断 —— 摘要模型基本不知道 agent 做了什么。B 直接喂原始结构化 messages。

**契约影响（待拍板）**：B 需要 `system + tools + 完整路径 + 断点开关 + 模型选择`，而 `CompactStrategyPort.compact(messages, runId)` 只给了 messages，这些 kernel 有、Port 一个都摸不到。两条路：(a) 扩 compact 参数带上只读 system/tools；(b) **把那次 `streamMessage` 挪回 kernel**，Port 只负责"给出压缩指令 prompt + 解析结果"。(b) 更干净，还能撤掉 Port 上那个只为上报 CostMeter 而存在的 `runId` 形参；代价是换成"用 embedding 做分层压缩"这类不需要 LLM 的实现时形状不合身。

**顺带的成本缺口**：`compact-default` 调 `streamMessage` 时**没有选模型**（`model: ""`，不走 ModelRouter）。压缩是"输入巨大、输出结构化、不需要顶级推理"的任务，是降级到便宜模型的最佳场景，且已在上报 `purpose: "compaction"`，收益立刻可度量。接 `docs/cost-optimization-layer.md`。

---

## 四、失败与超限：逐级降级，不中断会话

**hard ceiling 不预判。** 原本想引入 `hardCeiling` 主动拦截，但 `approxTokens` 是字符/4 粗估，估保守就过早压缩（Reasonix 最反对），估激进就漏。CC 的做法更好：**等 API 真的返回 `prompt_too_long` 再兜底**（Anthropic：400 + `prompt is too long`；OpenAI 兼容端：`context_length_exceeded`）。

PTL 触发时的逐级降级：

1. 先试 LLM 摘要（若本 generation 还没失败过）；
2. 摘要也失败 → **无 LLM 的结构化裁剪**：保留首个 user turn 原文 + 尾部按预算 N 条 + 中间替换为 `[N 条消息因上下文超限被裁剪]` 占位；
3. 切点必须过 `snapCompactionCut` 吸附（首个保留节点不能是 `toolResult`，否则用一个 400 换另一个 400）；
4. 仍失败 → 抛错**中断本 run**（`runState:"interrupted"`，历史完整保留、可 rollback/fork），**不销毁 session**。

**裁剪必须保头保尾砍中间，不能砍开头。** 两个理由：① 首个 user turn 装着任务定义与约束（Reasonix 专门 pin 住 `system + 首个 user turn`；CC 的 `snip_compact` 保留头 3 条），砍掉之后 agent 会以很难察觉的方式跑偏；② 从最前面改字节 = 整条前缀 100% 失效，是所有改写里最贵的一种。第 2 步必然砸掉全部缓存，但此时的对比项是"请求根本发不出去"，**fail-open 优先于 cache**。

helios 在这里比 CC/valos 有结构性优势：**裁剪不是删节点，而是新建分支节点**（同 summary 节点做法），旧节点一个不删，用户随时能 fork 回未裁剪的链。CC 是原地改 `messages` 数组，裁掉就真没了。

**摘要失败不装劣质产物。** 现状是 `llmSummary()` 内 catch 全吞 → 回落 `extractiveSummary()`（首 2 尾 3 条各截 200 字）→ 无条件 `appendNode`。三个后果叠加比"不压"更糟：

- 瞬时故障（限流/网络/无 provider）造成**永久损失** —— 劣质摘要节点进树后是祖先链的一部分，还会成为下次压缩的输入；
- 抽取式摘要几乎不降 token → 下一轮 `shouldCompact` 照样为真 → **每个 run 重复付费**；
- 只有一行 `logger.warn`，UI 什么都不显示，人无法干预。

改法：`Summary` 加判别字段（`degraded` / `source: "llm" | "extractive"`）让失败在契约层可见 → kernel 决策"degraded 不安装节点、什么都不改写" → **连续失败计数器上限 3**（对齐 CC `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3`）后停止自动压缩但**会话继续跑**，直到真的 PTL 才 fail → `compact_end` 带 status，UI 打 notice，显式 `/compact` 可强制绕过。抽取式摘要退回为"仅 `options.llm === false` 时使用"的显式逃生舱，不再作为失败回落。

净效果：失败时**什么都不改写**（前缀完好、历史完好、缓存完好），只是不压。

---

## 五、异步压缩：可行，但故意排在方案 B 之后

**helios 现有挂载策略天然适配异步。** `session.ts` 把 summary 节点挂在**当前 HEAD** 之下、靠 `firstKeptId` 标保留边界，而不是挂在"最后一个被覆盖的节点"之下。所以：

```
t0  基于路径 P0 发出摘要请求；主线继续跑，追加 N 条新消息
t1  摘要返回 → summary 挂到「此刻的 HEAD」
    → 期间新增的 N 条自然成为「保留的尾巴」，摘要只覆盖 P0 里那一段
```

**延迟安装是安全的**，不需要改写任何已有节点的 parentId（改 parentId = 改写历史，缓存全废且破坏树不可变性）。Reasonix 遇到这种情况是直接**丢弃候选**（`errCompressStaleContext`：摘要期间 transcript 变了就作废并封锁本 generation）；helios 因为挂 HEAD 不需要丢，这是树模型的免费优势。

也**不需要"分叉两个 node"** —— 压缩的 LLM 调用不产生树节点，树上始终一条线；所谓并行只是"压缩调用与主线调用并发"。

代价：

- **限流必须按 token 不按条数**（一条 32KB 的 tool_result 就能打穿窗口）：压缩期间路径增长超过预算或触及硬上限 → 转同步阻塞等摘要；
- **并发状态机改造**：Session 现在单 run 串行（`currentAbort` 单例、runState idle/interrupted）。异步要求压缩任务生命周期独立于 run、run 取消/session dispose 时能取消、摘要返回时若 session 已销毁要丢弃、`compact_start/end` 的 UI 语义从"阻塞中"变成"后台进行中"；
- 失败更容易被静默吞掉（前台失败至少人能看见卡住）；
- 与"大结果落盘"耦合：安装 summary 后要重算哪些内容还在上下文里。

**排序决定：先做方案 B，量一下压缩实际耗时，再决定要不要异步。** 因为压缩耗时主要就是那 120k token 的 prefill，B 命中缓存后大概率把"压缩要等"的体感直接消掉 —— 顺序反了就是拿并发复杂度去解一个可能已经不存在的问题。

---

## 六、已否决的方案

**Read dedup（`FILE_UNCHANGED_STUB` / `file_unchanged`）—— 前提不成立，不做。**

设计意图是：重复 `Read` 同一未变文件时只返回一句 stub（"已读过且未变化，内容仍在上文"），省掉同一份内容在上下文里躺多份。为保证 stub 不说谎，提案用 `{ mtime, nodeId }` + `isVisible(nodeId)`（该节点是否仍在投影出的可见路径上）判定，而非"压缩时清空 dedup"（后者在切分支/回溯时会误清）。

两条阻塞性事实：

1. **执行时拿不到 nodeId**：`toolResultMsg.id` 在 `executeTools.ts` 里等所有 `runOneToolCall` 跑完之后才生成，`tree.appendNode` 更晚（`runTurnLoop.ts`）；`ToolContext` 只有 `workDir/logger/signal/askQuestion`。要拿到就得提前生成 id 并塞进共享的 ToolContext，打破 `executeTools` 对消息树零耦合那条刻意守住的边界，且只为服务 Read 一个工具。
2. **`FileSystemPort` 没有 mtime/stat**（只有 `readFile/writeFile/glob/exists`）—— 失效判据在任何一层都不存在，要做就是又一次 Port 契约扩张，所有实现包都要跟进。

其余结论：

- **`ToolResultCachePort` 不能复用**，语义相反 —— 它的契约是"命中时返回同样的完整结果"（透明跳过执行），dedup 要的是"命中时返回不同的短 stub"。把 Read 标成 cacheable 省的是**磁盘 IO 不是 token**，不解决本问题。
- **多 session 污染**：`ToolRegistry` 是 Kernel 级单例、`createBuiltinTools` 装配期只调一次，所有 Session 共享同一个 Read 闭包 —— dedup map 放闭包里就是跨会话共享的全局 Map，既污染又没有释放路径。
- 经核实**没问题**的部分：可见性判定本身（`buildLlmPath` 多重压缩叠加行为清晰，`keptIdx<0` 兜底只会更保守地不可见）；stub 不破坏前缀一致性、resume 回放安全（`log.jsonl` 落的是当时字节，不会重新决定用不用 stub）。
- 替代方案：真正该先做的是**给 Read 加 offset/limit 与首次可见限长**（第二节 L3），直接限长比 dedup 便宜且不碰任何边界。若仍要 dedup，只做"同一批 tool calls 内对同路径的第二次 Read 返回 stub"这个窄版本（同批必然落进同一个 `toolResultMsg`，可见性天然一致，`executeTools` 内一个局部 Map 即可）—— 但该场景频率低、收益小。

**记忆整合（auto-dream 式的 consolidate/evict）—— 不做。** `MemoryPort` 保持 `recall`/`remember` 两个方法。

**per-turn 记忆召回 —— 不做。** `memory-fs.recall()` 忽略 query、返回 `MEMORY.md` 索引全文，因此把它冻结进 `systemPrefix` 是正确且缓存最优的（"索引稳定、内容按需读"）。valos 那套"后台 LLM 排序 topic 预览、下一轮以 system-reminder 注入"有三处错配：首轮最需要召回而首轮没有；多轮话题漂移导致上一轮召回与当轮无关；单轮会话纯亏。且注入 tail 虽不 invalidate 前缀，却会**永久累积**进后续所有轮（valos 靠 ≤60KB/session 上限兜）。需要时应做成**工具**（按需付费、当轮可用、结果进 append-only 历史、零前缀污染）。异步的价值应放在"离线重建索引/预热"（产物不进上下文），而不是"离线替 agent 挑内容"。

---

## 七、compaction 与 memory 的归属边界

区分两种上下文：**transcript**（本次会话历史，生命周期 = session，属 kernel）与 **memory**（跨会话知识，生命周期 > session，属 `MemoryPort`）。compaction 作用于前者。

compaction 必须知道树结构、切点、孤儿 `toolResult`、HEAD 移动 —— 全是 kernel 的语法（`branch-tree-and-prompt-cache.md` §2：对话是树是 kernel 的语法，树存哪是 Port 的实现）。记忆模块不该知道"Anthropic 不允许孤儿 tool_result"。现状分层是对的：`CompactStrategyPort` 只回答"要不要压/压成什么"，建节点、移 HEAD、落盘全在 kernel。

**但两者是上下游，且这个交接目前是空的**（两个方向都无实现）：

- memory 作为 compaction 的**上游供给**：CC 的 `sessionMemoryCompact` —— 压缩前先用已有 session memory 做轻量摘要，不调 LLM；
- memory 作为 compaction 的**下游消费**：valos 的 post-turn extract —— 把对话里的约束/偏好写进 memory，使"第 4 轮说过不许改 public API"能在压缩之后存活。这是压缩最大的信息损失点。

注意命名歧义：`CompactStrategyPort.compact()` 压的是**对话历史**；"记忆的压缩/淘汰"压的是**记忆本身**（本轮已决定不做）。两者对象不同。

---

## 八、跨 provider 的缓存管理封装

分三层，**只做前两层**：

- **Layer A（契约化，已有实现未写契约）**：`Usage` 的归一化口径（`uncachedInputTokens` / `cachedInputTokens` / `cacheWriteTokens` / `promptTokens`）目前只存在于实现里 —— `llm-anthropic` 映射 `cache_read`/`cache_creation`，`llm-openai` 填 `cacheWriteTokens: 0`。写进 `packages/ports/src/llm.ts` 契约注释 + 一个 provider 共享的 contract test。
- **Layer B（新增只读字段，零行为变化）**：`readonly caching?: "manual" | "automatic" | "none"`。这是"命中率报表能否解读"的前提：automatic 模式下 `cacheWriteTokens` 恒为 0 只代表 provider 不上报，若报表当成"没付缓存写入成本"，anthropic 与 openai 两条数据就不可比；doctor 文案也需要它（automatic 模式下建议用户"去打断点"是错的）。
- **Layer C（延后）**：kernel 表达"缓存意图"、provider 翻译 —— 方向是**让 kernel 标注稳定边界**（只有 kernel 知道树/压缩语义），如 `LLMOptions` 上加 `cacheBoundaries?: { systemStable, lastStableMessageId }`，anthropic 翻成 ≤4 个 `cache_control`、openai 忽略。**现在不做**：只有一个 manual 实例，抽象没有第二个实例验证（对照 Port 试金石"有没有理由被换掉"）。下一个真实实例很可能根本套不进 breakpoint 模型 —— Gemini 的 explicit context caching 是"先 create cached content 拿 handle、后续请求引用 handle"，形态是**资源生命周期管理**。等三者里至少两个真接进来再抽。

事实澄清（避免后人重复误判）：

- `cache_control` 是 **Anthropic Messages API 的请求字段**，不是 SDK 能力；能不能打取决于端点认不认这个字段，与用哪个 SDK 无关。最多 4 个断点，默认 5min TTL，cache write 按 1.25x 计费。
- OpenAI 官方 API **没有**对应字段：自动前缀缓存（≥1024 token 起、128 token 块对齐），`prompt_cache_key` 只是提高路由粘性的提示，不是断点。故 `llm-openai` 无处可打也不需要打。
- DeepSeek 自身口径是自动硬盘缓存、无手动控制。它同时提供 anthropic 兼容端点，字段层面可以把 `cache_control` 发过去，但缓存是否因此变成手动可控**无权威依据**（倾向接受并忽略）。**不要为了拿手动断点把 provider 从 openai 格式换成 anthropic 格式去打 DeepSeek。**
- "前缀必须逐字节稳定"对**手动与自动缓存同等成立**（自动缓存也是逐字节前缀匹配）；手动断点只多给一件事：**决定在哪里付 cache-write、缓存多久**。因此 Reasonix 那份文档里可迁移的内容全在 kernel 侧。
- helios `applyCacheBreakpoints` 每轮把断点打在倒数第二条 → 每轮写一次更长的新缓存（1.25x），这是手动模式的固有成本，自动缓存的 provider 没有这项。当前策略是标准做法，不改。

---

## 九、其他守则（当前无需改代码）

- **env 块的抖动字节**：目前 env 只有 workDir/isGit/platform/os，都是稳定值，日期已刻意排除。一旦将来加入任何探测（git 版本、docker 可用性、工具是否安装），必须照 Reasonix §2.2 做**指纹持久化**（它把探测结果按指纹存 24h），否则一次超时抖动就是全量 miss。
- **工具 schema 中途不换字节**：`cap-mcp` 现在是插件装配期 `listTools()` 一次性注册、无中途 swap，天然安全。将来若给 capability/MCP 加热更新，必须照 Reasonix §2.3 走"本会话继续用旧字节 + Execute 转发到新实现 + 新 schema 下个会话生效"。
- **落盘产物必须落在 workDir 内**：大结果落盘（`<persisted-output>`）与 memory 的 `storageDir` 都有同一个陷阱 —— `FileSystemPort` 被 `WorkDirGuard` 锁死，落在 workDir 外的路径 agent 读不到，标记与索引就成了死链。
- **压缩摘要不 pin 进前缀**：helios 现状已符合（summary 节点是链上真实节点，会被下次压缩覆盖合并，永远最多一条），继续保持，避免摘要链撑大前缀。

---

## 十、issue 清单

- [#29](https://github.com/fujiwarazz/helios/issues/29) 压缩后没有原文尾巴（`coveredMessageIds` 覆盖全路径 → tail 恒空）。含三条路线对照（原文尾巴 / CC 后压缩恢复 / valos 只留路径提醒）+ 第一节的损益账。**待决策：选哪条路线**
- [#30](https://github.com/fujiwarazz/helios/issues/30) 工具结果无长度上限（Read 无 offset/limit、Bash 输出无上限）→ 首次可见限长 + 落盘
- [#31](https://github.com/fujiwarazz/helios/issues/31) 压缩调用改走主会话前缀命中缓存（第三节方案 B）。**待决策：`CompactStrategyPort` 契约是扩参数还是把调用挪回 kernel**
- [#32](https://github.com/fujiwarazz/helios/issues/32) PTL reactive compact + 逐级降级兜底（含 `compactNow` 回调）
- [#33](https://github.com/fujiwarazz/helios/issues/33) 压缩失败熔断 + 不装劣质节点（#32 依赖它的 `degraded` 契约）
- [#34](https://github.com/fujiwarazz/helios/issues/34) 缓存命中率可观测：`Usage` 契约化 + `LLMProvider.caching` + CostReport/状态栏/doctor
- 延后：异步压缩（排在 #31 之后，先量压缩实际耗时再决定）

**实施计划**：`docs/plan-compact-contract-and-prefix-reuse.md`（覆盖 #31 + #33，含三阶段拆分、函数签名、测试清单）。

**实施顺序**（以计划文档为准，已修正本节早先给的 `#33 → #31`）：#31 Phase 0（契约迁移，行为等价）→ #33（纯 kernel 失败语义）→ #31 Phase 2（B 路线）→ #29 → #30 → #32 → #34。改序原因：#33 若先做会引入一个被 #31 立刻删掉的 `Summary.degraded` 字段 —— 调用回到 kernel 后失败直接可见。

⚠️ 本文第三节的「③ 本次调用禁用新断点」**待核实可能有误**：cache_creation 很可能只计"超出已缓存前缀的增量"，若如此则现有 `applyCacheBreakpoints`（打在 `length-2` = 历史最后一条）对 B 恰好正确，无需新增开关。见计划文档「事实 B」与 #31 的更正评论。
