# 分支树会话模型 + Prompt Cache 设计记录

> 本文是对 helios plan 第四节(Turn 模型/持久化/回溯)和 LLMProvider Port 的增量设计,
> 记录"消息树存储 + 基于任意 node 重开对话且不删旧分支 + prompt cache 一致性"的方案与决策依据。
> 目标档位:**树优先,cache 做到"不倒退"(从当前 0 命中提升为有命中,且分支不破坏 cache),cache 最优化(动态断点/freeze)留待后续。**

---

## 一、核心诉求

1. 能快速返回某一个历史 node。
2. 基于当前 node 重新对话(往下长出新消息)。
3. 之前的 child tree 不删除,随时可以切回去。
4. 在上述前提下,尽量保住 prompt cache 命中。

---

## 二、关键判断:树不做 Port,存储才做 Port

用 plan 第一节的试金石"这个能力有没有理由被换成另一种实现"逐条过:

- **"对话是树还是线性"没有理由被换掉**——它是 agent loop 的核心世界观。若做成 Port,kernel 的 chatLoop / 事件协议 / rollback 要同时兼容两套世界观,契约会随实现漂移。线性只是树的退化特例(每节点一个孩子)。→ **树是 kernel 内建,P0 钉死。**
- **"节点存哪、怎么存"有理由被换掉**(JSONL / SQLite / 远程)。→ 未来抽 `SessionStorePort`(本期先不做,plan 已有 turns.jsonl 承接)。

一句话:**"对话是一棵树"是 kernel 的语法;"这棵树存哪"是 Port 的实现。语法不可插拔,存储可插拔。**

---

## 三、cache 与分支的关系:不冲突,反而互利

prompt cache(Anthropic `cache_control`、OpenAI 自动前缀缓存)的铁律:**从头逐 token 比对,遇到第一个不同 token,之前全部命中、之后全部失效(前缀敏感)。**

- **回到某 node 继续(HEAD 跳到祖先再往下)**:新路径 `root→...→nodeN→新消息` 的前缀与上次完全一致 → 前缀 cache 全命中。**最优情况。**
- **切回旧分支(HEAD 跳到另一叶子)**:共享祖先 `root→...→分叉点` 仍命中,只有分叉点之后失效(本就不同,失效正确)。

**结论**:因为"不删旧分支、只移 HEAD",历史节点内容不可变,祖先链 cache 天然可复用。树比"截断式回溯"更省——截断永久丢弃历史,树保留着,cache entry 也就有机会复用。

---

## 四、现状诊断

- `llm-anthropic/src/index.ts` 的 `messages.create` **未打任何 cache_control**,system 直接透传 → **当前 cache 命中率为 0**。
- `session.ts:81` 每 run 都 `memory.recall(text)` 拼进 system → system 前缀每 run 漂移,即便开 cache 也基本不命中。

推论:不存在"现有 cache 行为被树破坏"的问题,是从 0 开始加;"不倒退"底线天然满足。

---

## 五、实施方案(三层)

### 第 0 层:契约改动(packages/ports/src/types.ts)

```ts
export interface Message {
  id: string;
  parentId: string | null;   // ← 唯一新增。null = 根。老数据迁移:按数组顺序补成指向前一条
  role: Role;
  content: string | ContentBlock[];
  turnId?: string;
}
```

- `ConversationState` 保留 `messages` 字段名不动(compact-default / noop 在用),只在 Session 内部改用树。
- **不加 `frozen` 字段**(属 cache 最优档,本期不做,理由见第六节)。
- 破坏面 = 1 个可选新增字段,对所有实现包零影响。

### 第 1 层:Session 内部树化(session.ts,核心工作)

`history: Message[]` → `nodes: Map<string, Message>` + `headId: string | null`。

```ts
private readonly nodes = new Map<string, Message>();
private headId: string | null = null;

/** LLM 只看这条:从 HEAD 沿 parentId 回溯到根,反转 */
private pathToHead(): Message[] {
  const path: Message[] = [];
  let cur = this.headId;
  while (cur) { const n = this.nodes.get(cur)!; path.push(n); cur = n.parentId; }
  return path.reverse();
}

/** 唯一写入口:追加节点并把 HEAD 移过去 */
private appendNode(msg: Message): void {
  msg.parentId = this.headId;
  this.nodes.set(msg.id, msg);
  this.headId = msg.id;
}
```

机械替换(全在 Session 类内部,不外溢):

| session.ts 行 | 现在 | 改成 |
|---|---|---|
| 85,104,111,123 | `this.history.push(x)` | `this.appendNode(x)` |
| 158 | `streamMessage(this.history, ...)` | `streamMessage(this.pathToHead(), ...)` |
| 138 | `this.history.slice(before)` | 记 run 开始 headId,收集本条 path 上新增节点 |
| 95,322-323 | `historyLenBefore` / `history.length =` | 见 rollback |

新增三个内建方法(实现诉求 1/2/3):

```ts
fork(nodeId: string): void {          // 回到某 node 继续。不删任何东西,只移 HEAD
  if (!this.nodes.has(nodeId)) throw new Error(`node 不存在: ${nodeId}`);
  this.headId = nodeId;
  this.emit({ type: "head_changed", headId: nodeId });
}
switchBranch(leafId: string): void { this.fork(leafId); }   // 语义同 fork
listBranches(): { leafId: string; depth: number }[] { /* 枚举无 child 的叶子 */ }
```

**rollback 从"破坏性截断"变成"移 HEAD"(减法)**:

```ts
async rollback(turnId: string): Promise<void> {
  const targetNodeId = /* 该 turn 首个节点 id */;
  await this.opts.ports.checkpoint.restore(/* 该节点 ref */);  // 文件还原,保留
  this.fork(targetNodeId);   // 不删 nodes / turnLog,旧分支全在
}
```

**旧 child tree 天然保留**:从不 `nodes.delete`,只移 headId。随时 fork 回任何 node,其整棵子树仍在。

### 第 2 层:cache "不倒退"两条纪律

**纪律一:system/memory 前缀每会话冻结一次,不每 run recall。**
把 `session.ts:81` 的 recall 从每 run 调,挪到 Session 构造/首次对话调一次,存 `this.systemPrefix` 复用。更新记忆 = 显式开新分支。**这是 cache 能否命中的总开关。**

**纪律二:anthropic provider 打静态 cache_control 断点。**
`index.ts:52` 的 system 加 `cache_control: { type: "ephemeral" }`;messages 倒数第二个 message 上再打一个断点。标准做法,不需算最近公共祖先(那是最优档)。

为什么这两条够"不倒退":`pathToHead()` 吐出的祖先链内容与上次逐字符一致(历史节点不可变),Anthropic 按前缀内容匹配,fork 回旧 node 再往下时 `root→node` 前缀自动命中。

---

## 六、为什么本期不做 freeze

freeze = 冻结每个节点发给 API 的确切字节,防"重新序列化产生字节差异"。属"最优"档。

当前 `content: ContentBlock[]` 是纯数据,`toAnthropicMessages` 是确定性转换(无时间戳/随机)→ 同输入必然同字节输出 → **不 freeze 也能命中。**

将来若 compact 改写历史、或引入非确定性序列化,再通过 `Message` 加可选 `frozen` 字段增量补,不返工。

---

## 七、重构量

| 部分 | 改动 | 风险 |
|---|---|---|
| types.ts 加 parentId | 1 行可选字段 | 零 |
| session.ts 树化 | ~40 行,机械替换 + 3 新方法 | 中(有测试兜底) |
| rollback 改 fork | 减法 | 低 |
| recall 改每会话冻结 | 挪几行 | 低 |
| anthropic 加 cache_control | ~4 行 | 低,纯增益 |
| events.ts 加 head_changed | 1 个事件类型 | 零 |

**总量:半天到一天。cache "不倒退"是净增益(0 命中 → 有命中),不增加树本身复杂度。**
安全网:kernel 4 个测试 + openai + cap-cron;`p2-rollback.test.ts` 直接验证 rollback→fork 新语义。

---

## 八、cache 的归属:属于 LLMProvider Port(重要决策)

**不同 provider 的 cache 机制根本不同,因此 cache 的"如何标记/如何计费"必须归 LLMProvider Port 各自实现,不上升到 kernel。**

- **Anthropic**:手动 `cache_control: {type:"ephemeral"}` 断点,最多 4 个,默认 5min TTL(可 1h),显式控制、显式计费。
- **OpenAI**:自动前缀缓存,≥1024 token 自动生效,开发者无手动断点,无需也无法标记。
- **其他 OpenAI 兼容网关**:可能两者皆无,或有自家协议。

**归属原则**:
- **kernel 只负责"提供一条内容稳定、前缀不漂移的消息路径"**(即 `pathToHead()` + system 前缀冻结)——这是所有 provider 命中 cache 的**公共前提**,与具体 provider 无关,放 kernel。
- **"在这条路径上如何标记 cache 断点、如何读回 cache 命中统计"是 provider 私有细节**——放各自 LLMProvider 实现(anthropic 打 cache_control,openai 什么都不做)。

因此:**cache 应与 LLMProvider Port 一起演进,但不需要给 Port 接口加新方法。** kernel 侧只要守住"路径内容稳定"这一前提,provider 侧各自在 `streamMessage` 内部处理自家 cache 策略。`LLMProvider` 接口(`streamMessage`)**签名不变**。

**可选(未来最优档)**:若要把 cache 命中率透传给 UI/计费,可给 `StreamEvent` 增一个可选事件 `{ type: "usage"; cacheRead?: number; cacheWrite?: number; input: number; output: number }`,由各 provider 自行 emit(能拿到就 emit,拿不到就不 emit)——这是向后兼容的可选新增,不破坏契约。本期不做。

---

## 九、compact 在树模型上的落地(summary 节点方案)

前置:compact 是 Port(`CompactStrategyPort` 的 `shouldCompact`/`compact` 是可替换策略),但"何时压、压完怎么塞回历史"是 **kernel 编排职责**,不下放给 Port。当前 loop 缺的正是这段编排(见 agent-loop-review.md Bug 1)。本节定义树模型下这段编排怎么做。

### 9.1 是"同一棵树的新分支",不是"新树"
compact 产出一个 **summary 节点**,挂在被压缩区间的末端之下,HEAD 移到它。**旧的长历史整条保留在树里,作为一条"未压缩旧分支",随时可 `switchBranch` 回去。**

```
root(sys 前缀锚点) → u1 → a1 → tr1 → … → u8 → a8      ← 旧长历史,整条保留,可回溯
                                            ↘
                                             summary节点   ← HEAD 现在在这
                                                ↘
                                                 u9(继续对话)
```

`pathToHead()` 走 `summary节点 → u9`,不再回溯 u1~a8;但一个节点都没删。**关键:是新分支而非新树**——否则丢失回溯能力,与"旧 child tree 不删、随时回去"自相矛盾。

### 9.2 summary 节点该装什么(cache 陷阱)
**只装 summary 文本本身。system prompt / 工具定义 绝不进节点。**

原因:system/tools 是 cache 最靠前的**独立稳定前缀**(走 `opts.system` + tools 参数单独传),对所有分支所有 turn 共享。若把它们复制进 summary 节点 content:① 同样内容存两份;② 请求体里前缀 + 节点各一份 → token 翻倍不减反增;③ 破坏"system 是独立稳定前缀"这一 cache 地基。

正确投影:
```
[system 前缀(不变,走 opts.system)] + [tools(不变)] + [summary 节点(仅摘要文本)] + [u9…]
```
"自包含、能独立成一段对话"这个属性,由 **"恒在的 system 前缀 + summary 节点" 共同满足**,不靠节点自带 system。额外好处:compact 后新分支的 `system+tools` 前缀与压缩前完全一致 → 那段 cache 继续命中,只有 summary 之后是新内容。**compact 不砸 cache,前缀段还接着省。**

### 9.3 summary 节点的 parentId 指向(选法 A)
**summary 节点的 `parentId` 指向被压缩区间的最后一个节点**(上图指向 a8),而非指向 root。
- 好处:旧历史与 summary 在树上父子相连成一条线,从 summary 往上回溯能自然走回完整旧历史;语义清晰("summary 是对上面这段的浓缩")。
- 反例(不采用):parent 指向 root = 近似独立分支,旧历史与新对话分叉过远,回溯体验割裂。

### 9.4 文件量:不是问题(append-only 单文件)
- **不要"一个节点一个文件"**(长会话几百小文件,inode 浪费、扫描慢——即用户担心的场景)。
- **沿用 plan 第四节 append-only 单文件**(`turns.jsonl`,树化后更名 `nodes.jsonl` 更准):**一个 session = 一个 jsonl,每节点一行。**
  - 新增 summary 节点 = 追加一行(几百字节);旧节点行一个不动、不删;HEAD 变化 = 改 `meta.json` 一个字段。
  - compact 的磁盘增量 = **一行摘要文本**,不是一堆文件。文件数恒定(每 session 一个),不随节点数增长。
- 真正增长的是**单文件大小**(节点只增不删,含所有旧分支),可控:
  - 短期无所谓(纯文本几 MB 是小事)。
  - 长期(未来):冷分支归档(久不碰的旧分支挪 `archive/`),或经 `SessionStorePort` 换 SQLite(一表存所有节点按 id 索引,连"文件大小"都不再是问题)。

### 9.5 kernel 编排(补 Bug 1)
loop 每轮开头:
```ts
if (compact.shouldCompact(state)) {
  emit compact_start
  const s = await compact.compact(coveredMessages);   // Port 只产摘要
  const summaryNode = { id, parentId: 末端节点id, role: 'summary'|'user', content: s.text };
  appendNode(summaryNode);   // HEAD 移到 summary 节点,旧节点保留
  emit compact_end
}
```
Port 只回答"要不要压 / 摘成什么";替换动作(建 summary 节点、移 HEAD)由 kernel 做。`Summary.coveredMessageIds` 供 kernel 确定被浓缩区间,不删对应节点(它们留作旧分支)。

---

## 十、落地顺序建议

1. 第 0 层 + 第 1 层地基改造(零行为变化优先:appendNode 永远指向新节点 = 退化为线性,跑绿现有测试)。
2. 加 fork/switchBranch/head_changed + 分支 UI(P1/P2)。
3. 第 2 层 cache 两条纪律(可与 2 并行,anthropic 侧独立)。
4. compact-on-tree 编排(第九节,补 agent-loop Bug 1;summary 节点 = append 一行)。
5. SessionStorePort 抽象(未来)。
6. freeze / 动态断点 / usage 事件(cache 最优档,未来)。
