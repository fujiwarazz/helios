# Reasonix 缓存命中率优化架构报告

> 范围：Reasonix 如何在 coding agent 的全链路（prompt 组装、wire 序列化、上下文管理、多模型协作）中最大化 provider 前缀缓存（prefix cache）命中率，从而同时降低 token 成本与首 token 延迟。
> 依据：当前代码库实现（引用的文件与行号以仓库现状为准）及 `docs/research/cache-aware-compaction-design.md`、`docs/SPEC.zh-CN.md`。

---

## 一、为什么缓存命中是一等设计目标

DeepSeek 等 provider 提供**自动前缀缓存**：如果两次请求的 prompt 前缀逐字节一致，已缓存的前缀部分按命中价计费（通常约为未命中价的 1/10），且省掉重复 prefill 的延迟。代码里多处注释把这点写成了经济账：

> "...invalidating the provider prefix cache at **10x miss pricing**."
> — `internal/plugin/lazy.go`

> "Re-observing on every rebuild rewrote the prefix and invalidated every session's provider cache (10x miss pricing) for no user-visible reason."
> — `internal/environment/snapshot.go`

因此 Reasonix 把"prompt 的哪一部分允许变化"做成了架构级约束，而不是每个模块各自决定的实现细节。项目宪法 `REASONIX.md` 中的硬性规则：

> **Cache-first**: the system-prompt prefix (base prompt + tools + memory) must stay byte-stable across turns so DeepSeek's automatic prefix cache stays warm. **Never mutate it mid-session — ride the turn tail instead** (see `control.Compose`).

这条规则推导出全部具体机制，可以概括为四条原则：

| 原则 | 含义 |
|---|---|
| **Byte-stable prefix** | system prompt + tools + memory 组成的前缀在会话内逐字节冻结 |
| **Append-only history** | canonical transcript 只追加，任何维护不得回头改写已发送的消息 |
| **Ride the turn tail** | 一切动态状态注入到"当前这一轮"的 user 消息尾部，而非 prefix |
| **Single-threshold maintenance** | 唯一自动触发点（`compact_ratio`），阈值以下零改写 |

---

## 二、稳定前缀：三层组成的字节冻结区

发往 provider 的请求可以划分为：

```
[ system prompt (base + 环境快照 + memory) ]  ← 冻结区 1：系统提示
[ tools schema 数组 ]                          ← 冻结区 2：工具定义
[ 会话消息历史（append-only） ]                 ← 增长区：只许追加
[ 当前 turn 的动态注入 ]                        ← 变动区：每轮可变的尾巴
```

### 2.1 Memory：boot 时一次性 fold，会话内零成本

`internal/memory/doc.go` 的 package 注释阐明了 memory 子系统如何服从 cache-first 架构：

```go
// Package memory implements Reasonix's persistent memory. It mirrors Claude
// Code's two-layer model while honoring Reasonix's cache-first architecture:
// ...
// All of it folds into the durable system-prompt prefix exactly once at boot
// (see Compose), so it rides DeepSeek's automatic prefix cache at zero per-turn
// cost. Mid-session changes never mutate that prefix; they take effect through
// the controller's transient tail-injection and fold into the prefix on the next
// session.
```

要点：

- `REASONIX.md` / `AGENTS.md` / `CLAUDE.md` / auto-memory 索引在**启动时**解析并拼入 system prompt，之后每一轮请求这部分都免费命中缓存；
- 会话中途 `remember` 新增的事实**不**改 prefix（那会立即使缓存失效），而是走 §3 的尾部注入，下个会话才固化进 prefix —— "新鲜度推迟一个会话"是反复出现的权衡。

### 2.2 环境快照：用持久化对抗"抖动字节"

system prompt 里嵌了一段本地环境探测结果（git 版本、docker 是否可用等）。问题是：实时探测是**点观测**——2 秒超时会让一个慢工具在 "found" 和 "timeout" 之间抖动；GUI 启动的桌面端和 login shell 解析出不同 PATH。每次重建都重新观测就会改写 prefix。

`internal/environment/snapshot.go` 的解法是把探测结果按指纹持久化，TTL 24 小时：

```go
// Probe snapshots persist across process restarts so the environment section —
// which sits inside the provider-cached system-prompt prefix — stays
// byte-stable between rebuilds and relaunches. ...
// Persisting one snapshot per probe fingerprint under the shared cache root
// keeps rebuilds — and the CLI and desktop on the same machine — on identical
// bytes until the snapshot ages out.
const probeSnapshotTTL = 24 * time.Hour
```

配套地，`internal/environment/probe.go` 还有 5 分钟内存缓存与 inflight 去重，保证同机 CLI 与桌面端渲染出**完全相同**的环境段字节。

### 2.3 Tools schema：缓存命中的懒工具绝不中途换真身

MCP 插件懒加载（`internal/plugin/lazy.go`）是这条纪律最精彩的体现。懒工具先以缓存的 name/description/schema 注册；当真实 MCP server 握手完成后，直觉做法是"换成真工具"——Reasonix 明确拒绝：

```go
// Cache-hit placeholders do NOT touch the registry. The lazyTools already
// carry the cached names/descriptions/schemas the model has seen since boot,
// and Execute forwards to the real tool once ready — swapping in the live
// tools would rewrite the request's tools array mid-session whenever the live
// handshake differs from the cache (description tweaks, schema upgrades, new
// tools), invalidating the provider prefix cache at 10x miss pricing. The
// live result still lands in the schema cache (saveLazyCachedSchema), so the
// NEXT session presents the updated surface — freshness deferred one session
// in exchange for byte-stable tool bytes within this one, same trade the
// environment-probe snapshot makes for the system prompt.
func (s *lazySpawn) trySwap() {
	if s.swapped || s.state != spawnReady {
		return
	}
	if s.removePrefix != "" {           // 仅"无缓存 stub"场景才换：一次性、不可避免
		s.reg.RemovePrefix(s.removePrefix)
		for _, t := range s.real {
			s.reg.Add(t)
		}
	}
	s.swapped = true
}
```

即：`Execute` 内部转发到真实工具拿到正确结果，但**模型可见的 schema 字节本会话内不变**；schema 更新落盘，下个会话再生效。

---

## 三、动态性出口：一切状态"ride the turn tail"

会话进行中必然产生新状态：plan mode 开关、活跃 Goal、新写入的记忆、刚完成的后台任务、hook 上下文、BM25 召回的相关事实。这些如果写进 system prompt，每改一次就全量 cache miss。Reasonix 的统一出口是 `Controller.Compose`（`internal/control/input.go:137`）：把它们全部拼到**当前这一轮 user 消息**的前/后缀上。

核心实现（`composeWithGoal`，input.go:148 起）：

```go
func (c *Controller) composeWithGoal(text, source string, includeHookContext bool, goal, goalStatus string) string {
	c.mu.Lock()
	plan := c.planMode
	responseLanguage := c.responseLanguage
	reasoningLanguage := c.reasoningLanguage
	c.mu.Unlock()
	notes := c.memory.drainPending()

	if strings.TrimSpace(goal) != "" && goalStatus == GoalStatusRunning {
		prefix := activeGoalBlock(goal)
		text = prefix + "\n\n" + text              // 活跃 Goal 块
	}
	if plan {
		text = PlanModeMarker + "\n\n" + text      // plan-mode 标记
	}
	text = agent.WithResponseLanguage(text, responseLanguage)
	text = agent.WithReasoningLanguageForSource(text, reasoningLanguage, source)

	// Memory added mid-session rides the turn (never the cached system prefix),
	// so it takes effect now without invalidating the prompt cache. It folds into
	// the system prefix on the next session, where it costs nothing per turn.
	if len(notes) > 0 {
		// <memory-update> ... </memory-update> 注入本轮
	}

	// Background jobs that finished since the last turn ride the turn too ...
	if note := c.jobs.DrainCompletedNoteForSession(...); note != "" {
		text = "<background-jobs>\n" + note + "\n</background-jobs>\n\n" + text
	}
	if includeHookContext {
		if block := c.drainHookContextBlock(); block != "" {
			text = block + "\n\n" + text           // <hook-context> 块
		}
		// Relevant facts ride only the real user-turn tail. This preserves the
		// stable system/tool prefix and keeps synthetic recovery turns free of
		// accidental recall.
		result := c.memory.recall(source)          // BM25 自动召回，只追加到真实用户轮
		...
	}
	return text
}
```

对称地，`StripComposePrefixes`（input.go:65）在 UI 展示、标题推导、历史回放时把这些注入块剥掉，保证"模型可见字节"与"用户可见内容"各取所需。

这套设计的连锁收益：

1. **召回不污染 prefix**：每轮 BM25 记忆召回的 query 不同，结果天然可变——放在 turn tail 是唯一正确位置；
2. **synthetic turn 保持干净**：流恢复、审批等合成轮不携带召回块，避免意外扩 prompt；
3. **Go 层之外同理**：`internal/agent/agent.go` 中 `DeliveryRuntimeMarker` 的注释写着 "its text is cache-frozen — changing it breaks steer replay matching and the prefix stability of every live delivery session"——连 turn 后缀的模板文本都被冻结。

---

## 四、Wire 层：序列化器本身就是 byte-stable 的

前缀稳定最终要落实到 HTTP body 的字节上。`internal/provider/openai/openai.go` 的消息结构体把"普通请求不出现的字段"全部做成指针 + `omitempty`：

```go
type chatMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"` // 始终存在：DeepSeek 严格反序列化器拒绝缺字段
	// Prefix is wire-only and is set exclusively on an automatically recovered
	// DeepSeek assistant tail. omitempty keeps every ordinary request byte-stable.
	Prefix bool `json:"prefix,omitempty"`
	// 指针让该字段可序列化为空串：DeepSeek thinking 模式要求 assistant
	// tool_calls 轮必须有 reasoning_content 键（空值可过、缺键 400），其余消息省略。
	ReasoningContent *string        `json:"reasoning_content,omitempty"`
	ToolCalls        []chatToolCall `json:"tool_calls,omitempty"`
	ToolCallID       string         `json:"tool_call_id,omitempty"`
	// Name 用指针：普通消息省略该键（byte-stable prefix），tool 消息恒序列化——
	// 严格后端（MiMo）拒绝缺 name 的 tool 消息。
	Name *string `json:"name,omitempty"`
}
```

请求级同理（`internal/provider/provider.go` 的 `Request`）：

```go
// ResponseFormat, when non-nil, asks the endpoint for structured JSON
// output ... Nil omits the field entirely — the common path must stay
// byte-stable for prompt caching.
ResponseFormat *ResponseFormat `json:"ResponseFormat,omitempty"`
```

以及 `provider.go:200` 附近对 tool-call 展示元数据的处理：

```go
// Resolved* fields are Reasonix-local display metadata for stable proxy
// calls ... Provider request builders deliberately serialize only
// provider-visible fields, so these values never alter the provider-visible
// conversation or prompt-cache prefix.
```

另一个关键边界是 `RawContent`（工具结果原文，见 §5.4）**永不**进入 provider 序列化：`ModelMessages`（`internal/provider/projection.go:10`）在交给任何 provider 前剥掉 `RawContent`、`LocalOnly`、决策回执等本地记录，因此"缓存 hash 永不包含它"（SPEC 3.6）：

```go
// ModelMessages removes durable display-only records before a request is
// handed to any provider. Healthy sessions without such records keep their
// original backing slice, preserving the allocation and prompt-cache fast path.
func ModelMessages(msgs []Message) []Message { return projectMessages(msgs, false) }

// ProjectionMessages is ModelMessages for a stored projection, except that
// ToolExecution survives: a projection is also the next compaction's input,
// and only that record says a tool call failed.
func ProjectionMessages(msgs []Message) []Message { return projectMessages(msgs, true) }
```

注意 `needsCopy` 快路径：健康会话没有这类记录时**直接返回原切片**——零拷贝、零字节变化。

---

## 五、上下文管理：唯一阈值、单次事务、阈值以下零改写

长会话最大的缓存杀手是"上下文维护"：传统实现用多级阈值做 prune/snip/摘要，每次维护都改写历史 → 改写点之后的缓存全部作废。Reasonix 的设计文档（`docs/research/cache-aware-compaction-design.md`）开篇即定调：

> 核心约束：canonical transcript 是永久事实源；唯一自动触发是 `compact_ratio`；**缓存状态只影响成本与观测，不触发历史改写**。

### 5.1 唯一自动触发点

`internal/agent/compact.go:91`：

```go
// compactTrigger is the sole automatic context-maintenance boundary. Output
// budgets are intentionally absent: they are clipped against the final request
// at send time and must never make compaction happen earlier than the user's
// configured compact_ratio.
func (a *Agent) compactTrigger() int {
	window := a.effectiveContextWindow()
	...
	ratio := a.compactRatio
	if ratio <= 0 {
		ratio = defaultCompactRatio   // 0.85
	}
	return max(1, int(float64(window)*ratio))
}
```

`triggerTokens = floor(context_window × compact_ratio)`（默认 0.85，可选 0.70/0.80/0.85）。`max_output_tokens` 被刻意排除在触发计算之外——输出预算只在发送时裁剪，绝不让压缩提前发生。

### 5.2 Prepare：唯一自动维护入口，阈值以下直接返回

`internal/agent/context_manager.go` 的 `prepareOnce`：

```go
// Prepare is the sole automatic maintenance entry. Below compact_ratio it does
// nothing. At or above the trigger it runs one summary transaction that either
// installs a checkpoint or records a generation-scoped blocked/failed receipt.
func (m ContextManager) Prepare(ctx context.Context, policy ContextPreparePolicy) (PreparedContext, error) { ... }

func (m ContextManager) prepareOnce(ctx context.Context, policy ContextPreparePolicy) (PreparedContext, error) {
	visible := a.modelVisibleMessages()
	// 阈值估计基于"稳定的 pre-interceptor 请求形状"（消息+tools+角色投影），
	// 扩展 interceptor 只在真实采样请求上跑，避免副作用插件被双重调用。
	est := a.estimatedVisibleRequestTokens(visible)
	...
	if est < fold && !forceFold {
		return prepared, nil    // ★ 阈值以下：不摘要、不投影、不写 sidecar、不发事件
	}
	return m.foldContext(ctx, prepared, policy, inputHash, est, fold, hard, forceFold)
}
```

SPEC 3.6 对"阈值以下"的禁令枚举得非常彻底：

> **阈值以下**绝不改写历史：不摘要、不安装 prune/snip projection、不写 sidecar、不增加 projection version、不发维护事件。**任何改写都会使该点之后的 prompt 缓存失效。**

失败保护也是缓存意识的：摘要失败按 generation 记录 `blocked`/`failed`，**同 generation 不自动再付费**；摘要期间 transcript 变了（`errCompressStaleContext`）则丢弃候选并封锁本 generation，而不是立刻重试制造第二次 miss。

### 5.3 Checkpoint 形态：稳定前缀 + 一条摘要 + 原文尾巴

触发时只做**一次**摘要事务，产物是：

```
[ 稳定前缀（system prompt + pinned 首条 user turn） ]
[ 一条结构化摘要（单次摘要调用，输出上限 16K） ]
[ 最近原文尾部（窗口×10%，clamp 到 32K–96K） ]
```

三个关键预算常量（compact.go）：

```go
// recentTailBudget is the content-construction budget for the recent verbatim
// tail. Production windows use clamp(window×10%, 32K, 96K).
func (a *Agent) recentTailBudget() int { ... }
```

验收规则：候选 ≤ 窗口 50%、严格小于源、低于 `triggerTokens`，**不向 50% 回填**——典型落地只占窗口 10%–30%，给后续增长留出大量"无需维护"的缓存温暖区间。

前缀固定由 `pinnedPrefixLen`（compact.go:293 起）保证：

```go
// pinnedPrefixLen counts the leading messages a fold keeps verbatim ahead of
// everything else: the system prompt and the first user turn (its task + stated
// facts/constraints) when it is small enough to be a brief. Digests are never
// pinned — any digest in the transcript enters the fold region and is merged
// into the next one, so a session cannot accumulate a chain of them.
```

也就是说：**摘要本身不进 prefix**——旧摘要会进入下一次 fold 区域被滚动合并成单条新 digest，provider 可见历史里永远最多一条 summary。这避免了"摘要链"把前缀越撑越大。

其他缓存友好的细节：

- **用户轮次不交给摘要器裁决**：折叠区内每条 user turn 在预算内（单条 ≤1500 tokens，合计 `min(8192, window×5%)`，从最旧开始）原样保留，防止"第 4 轮说的'不许改 public API'"这类约束丢失；`[[keep]]` 前缀可强制保留；
- **失败识别基于结构而非文本**：`KeepErrors` 依据 `ToolExecution` 记录判断工具失败，因此存储投影保留它、发给 provider 时剥离（`ModelMessages` vs `ProjectionMessages` 的唯一差异，见 §四）——否则下一次折叠无法分类上一次刚保护的失败；
- **投影身份用 hash 表达**（`internal/agent/projection.go`）：`CoveredPrefixHash` 指纹"被覆盖的 canonical 前缀"，把 append-only 增长与前缀改写/重写在持久层区分开；`ViewInputHash/ViewOutputHash` 让重试与 resume 时的免费维护幂等。

### 5.4 巨型工具结果：首次可见时限长，之后永不重截

工具结果是上下文膨胀的最大来源。策略（`internal/agent/agent.go:39`、`truncateToolOutputFor`）：

```go
// maxToolOutputBytes caps a single tool result before it goes into the model's
// context. ~32KB is roughly 8K tokens — enough for a full file read or a busy
// grep, while preventing one accidental "read this 5 MB log" from blowing the
// window before the next compaction runs.
const maxToolOutputBytes = 32 * 1024
```

```go
// truncateToolOutput is the first-visible hard cap for a tool result. Under-cap
// bodies are returned byte-identical. Over-cap bodies keep a tool-aware head and
// tail under maxToolOutputBytes; the full original is stored separately as
// RawContent by the session writer. The bounded form is stable for the message
// lifetime and is never re-truncated by later maintenance.
```

设计要点：

- **只截一次**：超限结果在第一次进入模型前生成稳定的 ≤32KB 可见版（按工具类型选 head/tail 策略：read 类保头部 12000 字符，bash 类头尾各 8000），原文存 `RawContent`；
- **之后永不回头**：后续任何维护不再重新截断——可见版字节对该消息的生命周期保持不变，也就是它在 prompt 中的位置永远命中缓存；
- 截断标记携带 toolName/toolCallID，模型需要全文时可重新抓取（用一次新工具调用换上下文体积）。

---

## 六、多模型与多 agent：会话隔离保护各自的缓存

### 6.1 双模型协作（Coordinator）

当 planner 与 executor 是不同模型时，两者跑在**独立 session**（`internal/agent/coordinator.go:108`）：

```go
// Coordinator runs two models in separate sessions to keep each one's prompt
// ... (prefix 只追加增长)
```

SPEC 3.5 总结："两条会话互不混合，prompt prefix 都只追加增长，避免切换模型破坏 prefix cache。"规划侧的深度合约放在同一个稳定 system prompt 里，单轮只追加很小的 `<planner-turn>`；因此除了 prompt 升级的一次性 miss 外，Planner 的 prefix cache 不会被持续破坏（GUIDE 亦述）。

### 6.2 子 agent 委派：小上下文 + 高命中 = 便宜

子 agent 用独立的小 system prompt 与受限工具集。SPEC 中给出实测解读（`docs/SPEC.zh-CN.md:370`）：

> 实测 27 个子运行平均每个 13.4 万 tokens，但那是 9.3 次模型调用上**同一份约 1.4 万上下文被反复重发**的累计值，不是 13.4 万条新内容。在**约 90% 缓存命中**下，一个子 agent 的真实价格平均为 **¥0.017**。

这正是 prefix cache 经济的最佳注脚：计费 token 数 ≠ 成本，命中率才是。

---

## 七、观测闭环：命中率是可度量、可告警的一等指标

设计纪律需要数据验证。Reasonix 把各 provider 迥异的 cache 统计口径统一归一化（`internal/provider/openai/openai.go:1118`）：

```go
// normaliseUsage folds the cache shapes used by OpenAI-compatible providers into
// a single Usage. DeepSeek reports prompt_cache_{hit,miss}_tokens at the top of
// usage; OpenAI and MiMo put cache hits under prompt_tokens_details; some
// compatible gateways return Anthropic-style input/cache counters instead.
func normaliseUsage(u *wireUsage) *provider.Usage {
	...
	hit := u.PromptCacheHitTokens          // DeepSeek: prompt_cache_hit_tokens
	miss := u.PromptCacheMissTokens
	if hit == 0 && u.PromptTokensDetails != nil {
		hit = u.PromptTokensDetails.CachedTokens   // OpenAI 风格
	}
	if hit == 0 {
		hit = u.CacheReadInputTokens               // Anthropic 风格
	}
	...
}
```

下游消费：

- **持久化**：`internal/usagecatalog/catalog.go` 按天/模型/provider rollup `cache_hit` / `cache_miss`；
- **状态栏**：CLI 第二行实时显示缓存命中率与上下文占用（`docs/GUIDE.zh-CN.md:500`）；
- **体检**：`internal/doctor/quality.go` 输出 `cache_hit_percent` 并纳入质量报告；过小窗口会触发"频繁 compaction 降低缓存命中率"的非阻断警告（GUIDE:410）；
- **遥测**：`internal/telemetry/client.go` 把 `cache_hit` 列为允许上报的指标键（不含对话正文）。

---

## 八、机制总览与效果

```
┌──────────────────────────────────────────────────────────────┐
│ 请求形状（每一轮采样）                                          │
│                                                              │
│  [冻结] system prompt = base + 环境快照(24h持久) + memory(boot固化)│
│  [冻结] tools schema（lazy MCP 命中缓存 → 本会话不换字节）          │
│  [增长] canonical 消息（append-only；工具结果首次限长后不再动）      │
│  [增长] ≤1 条滚动摘要 checkpoint（仅 0.85 阈值单次事务安装）        │
│  [变动] 当前 turn 尾部注入：Goal/plan 标记/memory-update/         │
│         background-jobs/hook-context/BM25 召回                  │
└──────────────────────────────────────────────────────────────┘
          │ 序列化边界：ModelMessages 剥 RawContent/LocalOnly，
          │ omitempty 指针字段保证普通请求字节稳定
          ▼
   DeepSeek 自动前缀缓存 → 命中部分 ≈ 1/10 价格 + 免 prefill 延迟
```

效果侧的可验证证据：

- 子 agent 实测约 **90% 缓存命中**、单个子运行真实成本约 **¥0.017**（SPEC:370）；
- compaction 落地后典型仅占窗口 10%–30%，此后长区间无需任何维护，缓存持续温暖（SPEC 3.6）；
- 唯一预期的 miss 发生在 checkpoint 安装那一轮——文档明确"首次安装会预期 cache miss；安装后前缀应保持稳定以利后续 hit"。

---

## 九、可迁移的经验清单

如果要把这套思路搬到其他 agent 系统，核心 checklist：

1. **把 prompt 分区**：明确哪些字节属于"冻结前缀"、哪些属于"append-only 历史"、哪些属于"本轮尾巴"，并给每个分区定一条不可逾越的规则。
2. **动态状态只许进尾巴**：任何会话中途产生的状态（记忆、通知、模式开关）注入当前 user turn，永不回改 system prompt。
3. **警惕"抖动字节"**：环境探测、时间戳、随机 ID、map 序等，要么持久化要么移出前缀；两次请求哪怕只差一个字节也是全量 miss。
4. **schema 字节也是前缀**：工具定义的中途热更新会作废缓存——用"本会话旧字节 + 转发到新实现 + 下会话生效"的延迟新鲜度换稳定。
5. **维护单阈值、单次事务、失败记 receipt**：多级阈值 = 多次改写 = 多次 miss；摘要本身要滚动合并，不许累积成链。
6. **截断只发生一次**：巨型结果在首次可见时限长并存原文，之后任何维护不得重截。
7. **多模型/多 agent 用独立 session**：各条 prompt 只追加增长，互不污染。
8. **把命中率变成一等指标**：统一各 provider 的 cache 统计口径，进状态栏、rollup 与告警——没有度量，纪律会退化。

---

### 附：本报告引用的关键源码位置

| 主题 | 位置 |
|---|---|
| Cache-first 宪法规则 | `REASONIX.md`（Conventions 节） |
| Turn 尾部注入 | `internal/control/input.go:137`（`Compose` / `composeWithGoal`）、`:65`（`StripComposePrefixes`） |
| Memory 两层模型 | `internal/memory/doc.go` |
| 环境快照持久化 | `internal/environment/snapshot.go`（`probeSnapshotTTL = 24h`）、`probe.go` |
| Lazy 工具不换字节 | `internal/plugin/lazy.go`（`trySwap`） |
| Wire 字节稳定 | `internal/provider/openai/openai.go`（`chatMessage`）、`internal/provider/provider.go`（`Request.ResponseFormat`） |
| Provider 边界剥离 | `internal/provider/projection.go:10`（`ModelMessages` / `ProjectionMessages`） |
| 唯一触发阈值 | `internal/agent/compact.go:91`（`compactTrigger`）、`:108`（`hardInputCeiling`） |
| 单次摘要事务 | `internal/agent/context_manager.go`（`Prepare` / `prepareOnce` / `foldContext`） |
| Checkpoint 构造 | `internal/agent/compact.go`（`pinnedPrefixLen`、`recentTailBudget`、`summarySystemPrompt`） |
| 工具结果首次限长 | `internal/agent/agent.go:39`（`maxToolOutputBytes`）、`truncateToolOutputFor` |
| 投影身份 hash | `internal/agent/projection.go`（`CoveredPrefixHash` 等） |
| 双模型会话隔离 | `internal/agent/coordinator.go:108` |
| Usage 归一化 | `internal/provider/openai/openai.go:1118`（`normaliseUsage`） |
| 设计文档 | `docs/research/cache-aware-compaction-design.md`、`docs/SPEC.zh-CN.md` §3.5/3.6 |
