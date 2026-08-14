# 树形消息压缩：CompactionRecord 机制介绍 【current impl】

> 代码：`packages/kernel/src/session.ts`（`maybeCompact` / `restore` / `writeCompactions`）、
> `packages/kernel/src/messageTree.ts`（`CompactionRecord` / `snapCompactionCut` / `reconstructPath`）。
> 本文介绍**当前实现**的压缩机制。它取代了 `branch-tree-and-prompt-cache.md` §9.3/9.5 最初的
> 「summary 节点挂进物理树、移 HEAD」方案，并解决了 `memory-recall-prompt-cache-revision.md`
> 遗留的 F1（孤儿 tool_result → 400）与 F2（re-parent 误伤兄弟分支）。

---

## 一、要解决什么问题

树形消息模型下做压缩，比线性历史难在三点：

1. **不能误伤兄弟分支**。旧方案 `tail[0].parentId = summary.id` 是 mutate 既有节点——若有分支从被改节点（或其上游）分叉出去，它们的 `pathToHead` 会在压缩边界处被顺带截断，"旧分支永远可切回"的承诺破产（F2）。
2. **不能劈开 tool 对**。切点若把 `tool_use` 留在覆盖侧、`tool_result` 留在保留侧，保留侧出现孤儿 `tool_result`，Anthropic API 直接 400（F1）。
3. **不能砸别人的 KV cache**。任何既有分支的投影（发给 LLM 的消息序列）必须逐字节不变，否则其缓存前缀全废。

## 二、核心思想：压缩记录化

压缩**不是一个对树的修改操作，而是一笔记录**。两条不变量：

- **不变量 1：物理树 append-only。** 一次压缩只产生两样新东西：一个 summary 节点 + 一条 `CompactionRecord`。不 mutate 任何既有节点的 `parentId`、不移 HEAD、不删节点。summary 节点从不作为任何物理节点的父（它的 `parentId` 只存血缘/归档用途）。
- **不变量 2：压缩是 per-branch 视图态。** 记录自带作用域锚点，重建投影时只对「锚点在当前 HEAD 祖先链上」的分支生效；其余分支的投影由纯物理链给出，压缩前后逐字节一致。

投影 = `reconstructPath(物理链, 压缩记录集)`。物理链永远不变 → 不生效的分支投影永远不变。这是结构性保证，不靠调用方小心。

## 三、CompactionRecord 三字段

```
物理链（压缩发生在分支 A 上）:

root → u1 → a1 → … → a8 → t1 → t2 → t3 → u_post → a_post → …   ← 分支 A
       └──────────┘     └──────────┘     └──────┘
       被覆盖区间          保留 tail         压缩后新追加

S = summary 节点（摘要文本），parentId 指向 a8 仅存血缘，不进任何物理链

R = { summaryId: S, firstKeptId: t1, firstPostId: u_post }
```

| 字段 | 指向 | 含义 |
|---|---|---|
| `summaryId` | summary 节点 | 摘要本体，重建时用它**替换**被覆盖区间。节点在 `nodes` Map 中（可取出文本、可持久化、resume 可重建），但没有任何物理边连着它 |
| `firstKeptId` | 保留 tail 的首节点 | 切点边界：从它（含）往下的物理节点原样保留进投影；它严格之上的节点被 summary 取代。**全覆盖压缩时为 null**（无保留 tail，边界退化为 `firstPostId`） |
| `firstPostId` | 压缩后本分支追加的**第一个**新节点（通常是紧随压缩的 userMsg） | **作用域锚点**，不参与拼接，只回答「本记录对当前 HEAD 生不生效」。压缩时先置 `null`，`sendMessage` 追加首节点后回填；`null` 记录永不生效 |

### 为什么锚点必须是压缩后的新节点

若用压缩时的 HEAD（t3）当锚点：t3 可能是多条分支共享的 fork 点，兄弟分支的祖先链上也有它，记录就会对那些分支生效 → F2 复现。`u_post` 是压缩后追加的，**唯一属于本分支**，锚定才精确。

### 重建算法（`reconstructPath`）

```
1. 选记录：从最新往旧遍历，取第一条「firstPostId 在 HEAD 祖先链上」的记录；
   找不到（含 firstPostId=null）→ 投影 = 完整物理链。
2. 定边界：boundary = firstKeptId ?? firstPostId
3. 拼投影：[summary 节点] + [boundary（含）到 HEAD 的物理节点]
```

上例的投影：`[S, t1, t2, t3, u_post, a_post, …]`。注意 system 前缀与 tools 不进任何节点，是独立稳定前缀（见 `branch-tree-and-prompt-cache.md` §9.2），压缩前后逐字节一致。

## 四、安全切点（`snapCompactionCut`，F1 修复）

`CompactStrategyPort.compact()` 返回 `coveredMessageIds`（它浓缩了哪些消息），kernel 据此算切点：

1. 取路径上最后一个被覆盖节点的下标 `lastCoveredIdx`；
2. **tool 对吸附**：若切点右侧首个保留节点是 `toolResult`，说明其配对的 `tool_use` 落在覆盖侧，保留后即成孤儿 → 切点向前 pull-back，直到首个保留节点不是 `toolResult`。被拉回的 tool 对留在 tail，其内容同时进 summary 文本——至多一轮重复，绝不丢数据；
3. 吸附后退空 → 返回 -1，本轮不压缩（空过）。

推论：`firstKeptId` 永远不会是 `toolResult`。

## 五、一次压缩的生命周期

```
sendMessage 开始
  └─ maybeCompact():
       1. ports.compact.shouldCompact(state)?（策略 Port，未加载恒 false）
       2. summary = ports.compact.compact(path)      ← Port 只产摘要文本
       3. lastCoveredIdx = snapCompactionCut(...)    ← kernel 定切点（含吸附）
       4. 建 summary 节点入 nodes（不动物理链）
       5. push 记录 { firstPostId: null, ... }       ← 此刻记录是惰性的
  └─ appendNode(userMsg)                             ← 本 run 首个新节点
  └─ record.firstPostId = userMsg.id                 ← 回填锚点，记录生效
  └─ writeCompactions()                              ← 落盘
```

职责划分：**Port 只回答"要不要压 / 摘成什么"；切点、记录、回填、持久化全是 kernel 编排**。

### abort 安全性

压缩后、回填前 run 被中止 → 记录 `firstPostId` 保持 `null` → `reconstructPath` 跳过它 → 投影回退为完整物理链。惰性默认（inert-by-default），无脏状态。

## 六、持久化与 resume

- `compactions.jsonl`：每行一条记录 + 内联 summary 内容（`summaryContent`）与其血缘父（`summaryParentId`）。**全量重写**（记录数少，重写比重叠追加简单可靠）；节点本体仍在 `turns.jsonl` append-only。
- `restore()`：`turns.jsonl` 全量回放**线性重建**消息树（parentId 按回放顺序重写——**分支结构跨 resume 被拍平，当前不持久化**）；随后回放 `compactions.jsonl`，按原 id 重建 summary 节点（不经 `appendNode`）并恢复记录。老会话无此文件 → 跳过（向后兼容）。
- 线性重建后整条链包含 `firstPostId` → 记录照常生效，压缩视图跨 resume 连续。
- 关键纪律：先回填 `firstPostId` 再写盘，保证恢复出的记录锚点必有效。

## 七、分支与 KV cache 影响矩阵

设压缩覆盖 root..a8、保留 tail=t1..t3、锚点 u_post：

| 场景 | 记录生效？ | 投影 | cache |
|---|---|---|---|
| 分支 A 自身 | 是 | `[S, t1..t3, u_post…]` | system+tools 段命中；summary 起 miss 一次（本质代价，token 总量仍下降） |
| 压缩**前**从 tail 分叉的既有分支 | 否（必须） | 完整物理链 | 零影响 |
| 压缩**后**从 tail 分叉的新分支 | 否（保守） | 完整物理链 | 命中旧前缀；仅不享 token 节省 |
| 压缩后从锚点及之后分叉（常见） | 是 | `[S, tail…]` | 命中压缩后前缀（S 文本共享，互利） |

机制无法区分「压缩前/后从 tail 分叉」（链上都无锚点），锚点规则有意保守地统一不生效——误判代价是 F2 复现，保守代价仅是少数场景不省 token。精细区分方案（nodes Map 插入序当 lamport 钟 + 记录加 `createdSeq`）见 `memory-module-design.md` §7.5，**当前不做**。

## 八、嵌套压缩契约

同一分支多次压缩时，`reconstructPath` 只应用**最新一条**生效记录。这隐含 `CompactStrategyPort` 的契约：**新 summary 文本必须涵盖旧 summary 的内容**。`compact-default` 的输入是含旧 summary 节点的完整投影，天然满足；自定义策略必须遵守，否则投影丢信息。（待办：写入 `ports/compact.ts` 注释固化。）

## 九、已知限制与待办

- `fork()` / `switchBranch()` 未校验 summary 节点（`listBranches` 只在枚举层过滤），直接 `fork(summaryId)` 会把 HEAD 移到 summary 上 → 待补 guard。
- 分支结构跨 resume 拍平（仅压缩记录持久化）；未来 `SessionStorePort` 或节点级持久化可解。
- 被压缩分支的一次性 cache miss 不可避免；压缩越靠后（保留 tail 越长），新内容越少，miss 代价越小——策略上倾向"压前半段、留尾部原样"。
- 与记忆模块的交互（pre-compact 抽取、压缩后重置召回去重）见 `memory-module-design.md` §7.4。
