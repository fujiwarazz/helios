# 记忆模块设计（Memory Module） 【design】

> 参考实现：code-agent-view `vectorx-code` 的 `memoryService`（分层 scope + 索引/主题两级存储 + 逐轮召回 + post-turn 抽取 + autoDream 整理）。
> 本文是 helios 记忆模块的目标设计。读路径部分是对 `memory-recall-prompt-cache-revision.md` 的落地展开；写路径为新增。
> 落地顺序见末节「分阶段落地」，P0 之前本文均为设计态。

---

## 一、设计决策（已确认）

### D1 记忆目录：user home 下按项目隔离

采用 code-agent-view 同款布局，**不进仓库、不污染 workspace**：

```
~/.helios/projects/<project-key>/memory/
  MEMORY.md      # 索引：≤200 行 / ≤25KB
  <topic>.md     # 主题文件：每个 ≤4KB
```

`project-key` 计算规则（对齐 code-agent-view 的 sanitize 逻辑，加短哈希防碰撞）：
- 优先取 workspace id 前 6 位；
- 否则取 primaryDir 绝对路径，`[\/\\:]` 替换为 `_`、去前导 `_`，再拼 6 位路径哈希后缀。

> 注：放弃「workspace 内 `.helios/memory/`」方案（可 git 化、随分支演进）的同时，也放弃了 checkpoint-git 对记忆的天然版本化。若后续需要，可加一个 workspace 内 scope 作为补充层，不影响本设计。

### D2 写管道执行体：复用 kernel session（后台 run），模型可切换

post-turn 抽取与 dream 整理都是**完整的 agent 任务**（要读记忆目录、判重、写文件、更新索引），不做专用轻量 LLM 调用，直接复用 kernel session 起后台 run。

模型切换能力已由现有架构保证，无需新机制：
- `LLMOptions` = `{ provider?, model?, ... }`，`SessionOptions.llmOptions` 每 session 独立；
- 同 provider 换模型 → 后台 session 传不同 `model`；
- 跨 provider → `LLMProvider` 是多实例 Port（`LiveLLMRegistry` 按 `id` 选用），传不同 `provider`，前提是 `helios.config.json` 注册了多个 LLMProvider 插件。

**当前默认行为写死：继承主会话 `llmOptions`**；但接口与配置都留覆盖入口（见 §5 `MemoryLLMConfig`），后续要换便宜模型只改配置。

---

## 二、总体架构

```
┌──────────────────────────── kernel session ────────────────────────────┐
│ 读路径                                                                  │
│  ① systemPrefix = base + MEMORY.md 索引   ← 每会话冻结一次（可缓存）      │
│  ② 每 run: recall(query) → 注入当前 user turn ← 缓存断点之后，逐轮可变    │
│ 写路径（fire-and-forget 事件，port 内部频率控制）                          │
│  ③ onRunFinished  → post-turn extract 后台 session（写记忆）             │
│  ④ onSessionIdle  → dream consolidation 后台 session（整理记忆）         │
└─────────────────────────────────────────────────────────────────────────┘
```

三层职责：
- **ports**：`MemoryPort` v2 契约（索引/召回分离 + 写管道事件钩子）；
- **kernel**：session 接入读路径（冻结索引、逐轮注入、会话级去重），并在 run 结束/idle 时触发写管道事件；
- **adapter**（`memory-fs` 及后续 `memory-auto`）：存储、召回排序、频率控制、后台 session 编排、工具门控。

---

## 三、存储模型与限额

索引只放指针，正文永远在主题文件里。常量直接沿用 code-agent-view 验证过的值：

| 常量 | 值 | 作用 |
|---|---|---|
| `INDEX_LIMIT_LINES` | 200 | 索引行数硬限，超出截断 + 附 WARNING 行 |
| `INDEX_MAX_BYTES` | 25_000 | 索引字节硬限 |
| `TOPIC_FILE_MAX_BYTES` | 4096 | 单主题文件字节限 |
| `RECALL_TOP_K` | 5 | 单轮召回主题数上限 |
| `RECALL_SESSION_MAX_BYTES` | 60KB | 会话级召回字节预算，耗尽后本会话不再召回 |

索引行格式：`- [Title](topic.md) — one-line hook`（单行 ≤150 字符；超过 ~200 字符说明把正文写进了索引，整理时应瘦身）。

---

## 四、MemoryPort v2 接口

```ts
// packages/ports/src/memory.ts
export const MEMORY_PORT_API_VERSION = 2;

export interface MemoryRecallItem { key: string; content: string }

export interface MemoryRecallOptions {
  excludeKeys?: Iterable<string>;  // 本会话已浮现/已被 Read 过的主题
  signal?: AbortSignal;            // 跟随主 run 的 abort
  maxItems?: number;               // 默认 RECALL_TOP_K
}

/** 写管道触发时交给 port 的上下文（不含 kernel 内部对象，保持契约窄） */
export interface MemoryWriteContext {
  projectKey: string;
  /** 最近若干条 user/assistant 消息的文本序列化（extract 原料） */
  recentTranscript?: string;
  /** 后台 run 的 LLM 配置（默认 = 主会话 llmOptions，由 kernel 填） */
  llm: LLMOptions;
}

/** 写管道各环节的模型覆盖入口；缺省环节继承主会话 llmOptions */
export interface MemoryLLMConfig {
  rank?: LLMOptions;     // 召回排序 sidecar（P1）
  extract?: LLMOptions;  // post-turn 抽取（P2）
  dream?: LLMOptions;    // 整理（P3）
}

export interface MemoryPort {
  /** 稳定索引文本（低频变化），用于冻结进 system 前缀 */
  loadIndex(): Promise<string>;

  /** 按当前 query 召回主题正文（高频、逐轮），实现侧做 LLM ranking / 关键词降级 */
  recall(query: string, opts?: MemoryRecallOptions): Promise<MemoryRecallItem[]>;

  /** 主动写入（供工具层 / hook 显式调用） */
  remember(entry: MemoryEntry): Promise<void>;

  /** 写管道事件：默认 noop，kernel fire-and-forget 调用，port 内部做频率控制 */
  onRunFinished?(ctx: MemoryWriteContext): void;
  onSessionIdle?(ctx: MemoryWriteContext): void;
}
```

要点：
- `loadIndex` / `recall` 分离是核心，对应「索引常驻 system + 召回注入当前 turn」两条路径；`recall` 返回结构化 item，注入格式由 kernel 决定。
- 写管道**事件驱动**而非 kernel 主动 await：频率控制（turn 阈值、最小间隔、idle 兜底）全部收敛在 port 实现内，kernel 只在生命周期点调一下。
- 兼容：apiVersion 升 2，`pluginLoader` 按 version 校验；可提供 v1→v2 适配器（`loadIndex` 复用旧 `recall`，写管道 noop）。
- 降级语义不变：不加载 MemoryPort → `loadIndex` 空串、不注入，对话照常。

---

## 五、读路径：kernel 改动

`session.ts · sendMessage`（落地 `memory-recall-prompt-cache-revision.md` 第二、三节）：

```ts
// ① 冻结前缀只含低频内容：base + 索引（不再是首轮 recall 正文）
if (this.systemPrefix === null) {
  const index = await ports.memory.loadIndex();
  const parts = [this.opts.system];
  if (index) parts.push(`<memory-index>\n${index}\n</memory-index>`);
  if (this.sessionStartContext) parts.push(`<hook-context>\n${this.sessionStartContext}\n</hook-context>`);
  this.systemPrefix = parts.join("\n\n");
}

// ② 每 run 召回，注入当前 user turn（pathToHead 末端、缓存断点之后）
const recalled = await ports.memory.recall(text, {
  excludeKeys: this.surfacedMemoryKeys,
  signal: abort.signal,
});
const memoryBlock = recalled.length
  ? `<memory>\n${recalled.map(r => `## ${r.key}\n${r.content}`).join("\n\n")}\n</memory>\n\n`
  : "";
const userContent = memoryBlock + text + (submitDecision.additionalContext ?? "");
```

配套 session 状态：
- `surfacedMemoryKeys: Set<string>`：本会话已浮现的主题，召回时排除，命中后累加；
- `readMemoryKeys: Set<string>`（P1）：拦截 Read 类工具结果，路径在记忆目录内的主题标记为已读，不再重复推送；
- **作用域定为会话全局而非 per-branch**：记忆浮现过一次即可，切分支不应重复推；
- **compact 发生后清空两个集合**（对齐 code-agent-view `resetAutoMemoryRecallState`）：压缩后记忆可重新浮现。

provider 侧 `applyCacheBreakpoints` 断点打在「倒数第二条 message」，召回块天然落在缓存前缀之外，**provider 无需改动**。

---

## 六、召回排序（adapter 内部，两档）

- **P0 关键词降级**：索引行/主题 preview 与 query 做词项匹配取 top-k，零成本、零延迟；LLM 不可用时的兜底。
- **P1 LLM sidecar**：抄 `memoryRankLlm.ts`——索引引用的主题清单 + 每个主题 200 字 preview 喂给小模型，返回严格 JSON `{"selected":[...]}`（≤5 条、路径必须逐字命中清单、为空返回空数组）；解析失败/调用失败降级关键词。
  - 模型走 `MemoryLLMConfig.rank`，缺省继承主会话；
  - 必须可 abort（跟随 run 的 AbortSignal），避免主 run 已取消还在花排序的钱；
  - latency 预案：若实测排序拖慢首 token，再拆 start/consume 两半（run 开始即异步发起、tool loop 间隙收割），接口不变。

---

## 七、写路径（adapter 内部，复用 kernel session）

两个后台 run 都是「受限 session」：独立的 toolRegistry 子集（文件读写 + glob/grep）+ 路径门控 wrapper（写工具仅允许记忆目录内路径，搜索工具限定记忆目录；对齐 `forkToolPolicy.ts` 的 `isPathInsideDir` 门控）。

### 7.1 Post-turn extract（P2，写新记忆）

- **触发**：`onRunFinished` 内计数，满足任一且过最小间隔：
  - 累计 ≥10 个 run 且距上次 ≥10min → 立即；
  - 空闲 30min 兜底（每 run 重置 idle timer；阈值已到但间隔未满时清零计数，防止活跃会话的 idle 路径永不触发——此坑 code-agent-view 修过，直接抄修正版逻辑）。
- **输入**：最近消息序列化（≤100K 字符，取尾部）+ 记忆目录现有 .md 清单（≤80 个文件名）。
- **行为**（system prompt 要点）：只写记忆目录、先读后写、优先更新索引链接与新建小主题文件（事实/约定/命令/API/坑）、跳过琐碎闲聊、结束后一行汇报。
- **模型**：`MemoryLLMConfig.extract`，关 thinking；缺省继承主会话。

### 7.2 Dream consolidation（P3，整理记忆）

- **触发**：`onSessionIdle` debounce 30min + 距上次完成 ≥24h；后续可挂 `cap-cron` 让用户可见可控。
- **行为**：四阶段 prompt（照抄 `memoryAutoDreamPrompt.ts`）：
  1. Orient：列目录、读索引、 skim 主题文件；
  2. Gather：找漂移的事实（与代码库现状矛盾的记忆）；
  3. Consolidate：合并近重复、相对日期转绝对日期、删除被证伪的事实（从源头改）；
  4. Prune & Index：索引维持 ≤200 行 / ~25KB，删过时指针、瘦身超长行。
- **模型**：`MemoryLLMConfig.dream`，可开 thinking；缺省继承主会话。

### 7.3 频率与成本参数汇总

| 参数 | 值 | 说明 |
|---|---|---|
| extract turn 阈值 | 10 run | 累计触发 |
| extract 最小间隔 | 10min | 抑制突发连发 |
| extract idle 兜底 | 30min | 空闲触发 |
| dream debounce | 30min | 连续活动期不打扰 |
| dream 最小间隔 | 24h | 全局硬限 |
| transcript 上限 | 100K 字符 | 取尾部 |

所有后台 LLM 调用经 costmeter 记账时打 `source: "memory_extract" | "memory_dream" | "memory_rank"` 标签，纳入 `cost-optimization-layer.md` 的观测口径。

---

### 7.4 记忆 × 压缩的交互（树模型）

压缩的记录化方案（`CompactionRecord` + `reconstructPath`，物理树 append-only、per-branch 锚点作用域）保证：未压缩分支的投影与 KV cache 逐字节不受影响；被压缩分支只有 `summary` 段之后 miss 一次，`system+索引` 与 `tools` 段继续命中。记忆模块在此之上遵守三条：

1. **Pre-compact 抽取**：`maybeCompact` 确定安全切点后，把**被覆盖区间**（`path[0..lastCoveredIdx]`）序列化作为 transcript 调 `ports.memory.onCompact?.(ctx)`（`MemoryWriteContext` 同构）。不变量：「被压缩掉的内容必然先经过记忆抽取」，压缩成为记忆沉淀的天然触发器，比纯频率兜底精确。抽取本身仍受 §7.3 最小间隔约束（压缩密集时不重复烧钱），但**间隔未满时也要记录 covered 区间摘要落盘**，允许丢时效不丢内容。
2. **记忆对压缩分支 cache 零扰动**：索引冻结在 system 前缀，压缩前后逐字节一致；summary 节点只装摘要文本，**不复制记忆索引/正文**（前缀里已有，重复 = token 翻倍）。
3. **压缩后重置召回去重**：`surfacedMemoryKeys` / `readMemoryKeys` 清空（见 §五），允许被压掉的记忆主题重新浮现。

另：`CompactStrategyPort` 需遵守隐式契约——嵌套压缩时新 summary 必须涵盖旧 summary 内容（`reconstructPath` 只应用最新一条生效记录）。`compact-default` 输入为含旧 summary 节点的完整投影，天然满足；应写入 ports 注释固化。

### 7.5 边界分析：分叉点落在压缩切点之后（保留尾部）

设压缩覆盖 root..a8、保留 tail=t1..t3、锚点 u_post。从 tail 中部分叉按时机分三种：

| 分叉时机 | 记录是否生效 | 投影 | cache | 评价 |
|---|---|---|---|---|
| ① 压缩前已存在的尾部分叉 | 否（必须） | 完整历史 | 零影响 | 若生效 = 追溯性投影变更（F2 类 bug），锚点规则精确阻挡 |
| ② 压缩后新建的尾部分叉 | 否（保守） | 完整历史 | 命中旧前缀 | 正确、cache 安全，仅不享 token 节省（超集信息，方向安全） |
| ③ 压缩后从锚点及之后分叉（常见） | 是 | [S, tail…] | 命中压缩后前缀 | 分支与压缩互利 |

记录机制无法区分①和②（链上都无锚点），锚点规则有意保守地统一不生效——误判代价是 F2 复现，保守代价仅是②不省 token。若未来要让②继承 summary：利用 nodes Map 插入序（天然 lamport 钟，resume 按 turns.jsonl 顺序回放可恢复），记录增加 `createdSeq`，扩展规则「锚点在链上 或（firstKeptId 在链上 且 其下自有节点 seq 均 > createdSeq）」。**当前不做**，记为已知 trade-off。

附带待办：`fork()` / `switchBranch()` 未校验 summary 节点（`listBranches` 只在枚举层过滤），直接 `fork(summaryId)` 会把 HEAD 移到 summary 上，应在两个入口补 `summaryIds` guard。

## 八、与既有机制的契合

| 机制 | 结合方式 |
|---|---|
| prompt cache 纪律 | 索引进冻结前缀（低频）、召回进当前 turn（缓存断点之后）——修订文档方案的原样落地 |
| branch tree | 去重集合会话全局；compact 后清空；压缩不触碰记忆目录；压缩触发 pre-compact 抽取（见 §7.4） |
| hooks | SessionStart 注入仍在冻结前缀内；后续可加 `MemoryLoaded` hook 给插件改索引的口子 |
| cap-cron | dream 调度可迁移到 cron 设施，对用户可见可配 |
| costmeter | 记忆相关调用打 source 标签，成本可观测 |
| checkpoint | 记忆在 home 目录、不进 checkpoint；若未来加 workspace 内 scope 层再议 |

---

## 九、分阶段落地

- **P0**：`MemoryPort` v2（loadIndex/recall 分离 + 事件钩子定义）+ kernel 读路径改造 + `memory-fs` 关键词召回。此步即完整落地修订文档，缓存与召回时效兼得。
- **P1**：LLM ranking sidecar + `readMemoryKeys` 去重 + 会话字节预算。
- **P2**：post-turn extract 后台 session + 工具路径门控 + 频率控制。
- **P3**：dream 整理（idle 钩子起步，后续接 cap-cron）。
- **P4（可选）**：分层 scope（managed-policy / team / project-local / user 全局），以及把 AGENTS.md 类项目指令纳入 memory port 统一加载（对齐 code-agent-view 的 8 级 scope 注入顺序）。

## 十、测试要点

- 前缀稳定性：同会话 run 2+ 的 system 前缀与 run 1 逐字节一致（索引不变时）；
- 召回注入位置：召回块出现在当前 user turn，且不影响缓存断点前的任何段；
- 去重：同主题不重复浮现；Read 读过的主题不再推送；compact 后可重新浮现；
- 限额：索引/主题/会话预算超限时的截断与 WARNING 行为；
- 降级：无 LLM 配置时关键词召回可用；ranking 失败自动降级；
- 频率控制：turn 阈值/最小间隔/idle 兜底三条触发路径；阈值到但间隔未满时计数清零、idle 路径仍可达；
- 门控：后台 session 写工具越界路径被拒绝；
- abort：主 run 取消时进行中的 ranking 立即终止。
