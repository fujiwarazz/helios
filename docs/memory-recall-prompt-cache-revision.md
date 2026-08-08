# Memory 召回与 Prompt Cache（对 branch-tree-and-prompt-cache.md「纪律一」的修订） 【not impl】

> 背景：PR #4（feat/branch-tree-cache）落地了「纪律一：system/memory 前缀每会话冻结一次，不每 run recall」。
> 本文记录一次 Code Review 反馈：**冻结召回是"用大锤敲钉子"**——它为了缓存稳定，把 memory 逐轮召回一并冻死，run 2 起 memory 形同关闭。
> 正确目标是：**既保住 prompt cache，又保留逐轮召回时效性**。参考 shareAI s09（Memory）与 valos 的做法。

---

## 一、问题定位：冲突根源不是"召回动态"，而是"动态召回被放进了缓存前缀"

老实现（PR 前）：

```ts
const recalled = await ports.memory.recall(text);   // 依赖当前 query
system = base + `<memory>\n${recalled}\n</memory>`;  // 塞进 system
```

`system` 是缓存里**最靠前、最大**的块（`cache_control` 打在 system 上）。`recall(text)` 每 run 随 query 变 → system 前缀每 run 漂移 → **整条前缀缓存永不命中**。这是真问题。

PR 的修法（冻结 `systemPrefix = base + 首轮 recall`）确实修好了缓存，但副作用是 memory 召回被冻成"仅首条消息召回一次"，后续轮次拿不到与当前问题相关的记忆。

**关键认识**：缓存失效的原因是"动态内容位于缓存前缀内"，不是"内容动态"。只要把动态召回**移出缓存前缀、放到路径末端**，动态与缓存可以兼得。

## 二、正确设计：索引常驻 system（可缓存）+ 相关记忆按需注入当前 turn（不进前缀）

对齐 shareAI s09 与 valos：把 memory 拆成两条路径。

### 路径一：索引常驻 system（稳定、可缓存）
- `system = base system + memory 索引`。
- 索引 = `MEMORY.md` 的清单（每条一行 `name — description`），**不含正文**。
- 索引变动极少（只在写入/整理记忆时变），因此 system 前缀在一次会话内基本稳定 → 保住缓存。
- 冻结的只应是「base + 索引」这种**低频**内容，而不是「按当前 query 召回的正文」。

### 路径二：相关记忆按需注入当前 user turn（动态、但不破坏缓存）
- 每个 run 开始用当前对话做一次轻量 side-query（LLM 选相关文件名，失败降级关键词匹配），选出 ≤5 条相关记忆。
- 把选中记忆的**正文**注入到**路径末端的当前 user turn**（即 `applyCacheBreakpoints` 断点**之后**的位置），而不是塞进 system。
- 因为它在缓存前缀之后，**换内容不会让前面任何缓存段失效**；同时每 run 都能拿到与当前问题相关的记忆。

示意（缓存段 = system+索引+tools+历史前缀，恒定命中；召回块在断点之后，逐轮可变）：

```
[system(base+索引) 断点]  [tools]  [历史前缀 … 断点]  [当前 turn: <memory>本轮召回正文</memory> + 用户输入]
└──────────────── 命中缓存 ────────────────┘         └────────── 逐轮变化，不影响上面 ──────────┘
```

## 三、对当前代码的落地改动（供 branch-tree-cache 分支采纳）

`session.ts · sendMessage`：

1. `systemPrefix` 只冻结 `base system + 索引`（而非首轮 recall 正文）。
   - 索引来源：`ports.memory` 需暴露一个"列目录"能力（name+description 清单），或先用 `recall` 的轻量形态代替。
2. 新增每 run 的召回注入：`const recalled = await ports.memory.recall(text)`，把结果作为**当前 turn 的前置块**拼进 `userMsg`（或作为本 run 的 lead message），使其落在 `pathToHead()` 末端。
3. provider 侧 `applyCacheBreakpoints` 已把断点打在"倒数第二条 message"，天然把最新 turn（含召回块）留在缓存之外 —— 无需额外改动即可满足"召回不进缓存前缀"。

> 若 `MemoryPort` 暂不区分"索引"与"召回"，可先只做第 2 步（每 run 召回注入到当前 turn），把 `systemPrefix` 收敛为纯 `base system`；索引常驻作为后续增量。这一步就能同时恢复召回时效性并保住缓存。

## 四、与既有设计文档的关系
- 本文**修订** `branch-tree-and-prompt-cache.md` 第五节「纪律一」：由"冻结 base+首轮召回"改为"冻结 base+索引（低频），召回移至当前 turn（高频、缓存前缀之外）"。
- 纪律二（provider 侧静态断点）不变，且天然配合本方案。

---

## 附：本次 Review 的两个相邻 follow-up（非本文主题，记录备查）

### F1 [P1] 压缩边界可能劈开 tool_use / tool_result → Anthropic 400
`maybeCompact` 以 `lastCoveredIdx` 为切点，未保证边界落在 turn 边界。若被覆盖区间末尾是含 `tool_use` 的 assistant、而其 `toolResult` 落在保留的 tail，则新路径首部出现"无对应 tool_use 的孤儿 tool_result"，API 报 400。
建议：kernel 把边界吸附到安全切点（tool turn 整体纳入或整体排除），并补对应测试。

### F2 [P1] 压缩 re-parent 既有节点会追溯性截断共享该节点的其它分支
`tail[0].parentId = summaryNode.id` 改的是物理树上既有节点的父指针。若此前有分支从 `tail[0]`（或其上游、位于未来 tail 内的节点）分叉出去，压缩后这些分支的 `pathToHead` 也会在 summary 边界处提前截断，导致"未参与压缩的旧分支被顺带压缩"，违背"旧分支永远可切回"的承诺。
建议：压缩不 mutate 既有节点，改为「为 tail 头新建 copy 节点挂到 summary 下」或把压缩边界做成 per-branch 视图态。
