# helios Web UI 完整需求（Anthropic 风格重构）

> 从"最小演示 UI"升级为产品级对话界面。视觉走 Anthropic 风（米黄暖底 + 线条感），
> 结构为「侧边栏 + 完整 ChatView」。本文档区分**本期实现**与**占位/未来**，并标注每项触碰的架构。

---

## 本期范围（已确认）

- ✅ 视觉重构（Anthropic 风）+ 侧边栏骨架 + 会话列表 + New chat + **完整 ChatView**（纯前端为主）。
- ⏳ Projects / Artifacts / Ports：**本期只定语义 + 占位（Ports 出只读真数据）**，完整功能未来做。
- 语义定档：Projects = 独立 workDir + 会话组；Artifacts = 文件产物浏览器；Ports = 只读展示（运行时 link 为 v2）。

---

## 一、视觉基调（Anthropic 风格）

- **色板**：暖白/米黄底（`#FAF7F0` 主背景，`#F5F1E8` 侧边栏），近黑正文（`#1A1A18`），赭石/暖橙点缀（`#C15F3C` 一类，克制使用）。
- **线条感**：分隔用 1px 细边框（`#E8E1D4`）而非投影卡片；圆角小（4–8px）；大量留白。
- **字体**：标题可用人文衬线或高质量无衬线；正文无衬线；等宽字体用于代码/工具输出。
- **禁止**：重投影、高饱和大色块、渐变滥用——保持克制、编辑感。
- 明确只做 light mode（暖色本就为亮色设计）；dark mode 未来。

---

## 二、侧边栏结构（自上而下）

1. **顶部**：品牌区 + `＋ New chat` 主按钮（暖橙描边/填充）。
2. **导航区**（图标+文字）：Projects / Artifacts / Ports / Customize。
3. **会话列表**：按时间分组（Today / Yesterday / Previous 7 days / Older），每项显示 title + 相对时间，hover 出操作（重命名/删除）。当前会话高亮。
4. **底部**：连接状态条（复用 `IChatClient.onState`：连接中/已连接/已断开）+（未来）用户区。
- 侧边栏可折叠。

---

## 三、完整 ChatView（本期重点，纯前端）

在现有极简 ChatView 基础上补齐：

- **消息气泡**：user（右/暖色浅底）、assistant（左/无底或极浅）、角色清晰但不喧宾夺主。
- **流式渲染**：text-delta 实时累加（已由 useChat reducer 支持）；流式光标。
- **Markdown 渲染**：assistant 文本走 markdown（代码块高亮、列表、表格）。
- **工具卡片**：走 `ToolRenderer` descriptor（label/status/detail/expandable）；无 descriptor 走通用兜底（工具名+状态点）。running/success/error 三态视觉区分；可展开看输入/输出。
- **输入区**：多行输入框（Enter 发送 / Shift+Enter 换行）、发送/停止按钮（停止调 cancel）、isStreaming 时禁用发送显示停止。
- **空态**：无消息时的引导页（示例提示词）。
- **待补（本期不做，docs 记录）**：虚拟列表/长会话分页、审批卡片交互（AskUserQuestion 深度 UI）、附件上传。

### 3.1 回退 / checkpoint / 分支导航（把 turn/tree 能力接到 UI）

后端已按 turn 组织、且有 checkpoint 与 message tree 能力，UI 要把它兑现。**分两个层次，递进实现**（层次一是层次二的退化特例：线性 = 单分支的树）。

**层次一：turn 级"回到此处重聊"= rollback（本期做，host 已有 `rollback` RPC）**
- ChatView 每个 turn 边界（assistant 回复结束处）显示断点标记 + "⟲ 从这里重新开始"入口。
- 点击 → 确认（会丢弃该 turn 之后的当前路径）→ 调 `rollback(turnId)`：CheckpointPort 还原文件快照 + HEAD 移到该 turn 锚点 → UI 移除之后的消息、回到输入态。
- 视觉：用时间轴/断点标记表达"这是一个可回退检查点"，区别于普通消息。
- **注意**：`rollback` 语义已是"减法"（移 HEAD 不删节点），所以被回退的分支在 tree 里仍在，为层次二铺垫。

**层次二：分支导航 = Claude 式"兄弟版本切换"（等 branch-tree 分支合入后做）**
- 呈现形态（已定）：被 fork 过的消息处显示 `< 2/3 >` 左右切换兄弟版本，用户只感知"这条消息试了几个版本"，**不暴露"树"的概念**。不做完整树状导航图。
- "编辑一条旧消息重发" = **fork 出新兄弟分支**（旧节点不变），非改写旧节点 content。
- 靠 `head_changed` 事件实时高亮当前在哪个版本；靠 `listBranches()` 得知有哪些分支叶子。

**依赖缺口（层次二实现前必须补）**：
- 合入 `feat/branch-tree-cache`（含 `fork`/`switchBranch`/`listBranches`/`BranchInfo` + `head_changed`/`rollback` 事件——已在该分支实现）。
- **host 补 RPC**：当前 host 只暴露 `sessionId/history/sendMessage/rollback`，缺 `fork(nodeId)`/`switchBranch(leafId)`/`listBranches()`，且需把 `head_changed` 纳入事件广播。

### 3.2 ⚠️ prompt cache 保护（UI 侧硬约束，违反即废 cache）

fork/switchBranch 本身对 cache 友好（回旧 node，`root→node` 前缀逐字节不变，cache 自动命中）。但 UI 有两种操作会破坏前缀一致性，**禁止**：

1. **禁止在前端改写历史消息 content 后原地重发**。"编辑重发"必须映射成 `fork(旧节点父) + 发新消息`（旧节点不可变、作为兄弟分支保留），绝不改旧节点 content——改了前缀字节变化，该分支 cache 全废且违背"历史不可变"。
2. **禁止前端自己拼消息数组整体发给 sendMessage**。UI 只传一句话（现有 `sendMessage(text)`），消息路径由后端 `pathToHead()` 从 HEAD 投影组装——cache 命中依赖后端发出字节与上次一致，这个一致性由后端保证，前端绕过就破坏。

一句话：**UI 对 cache 的唯一责任 = 不绕过后端树模型。回退/切分支/编辑重发一律通过 rollback/fork/switchBranch 让后端移 HEAD，前端不改历史节点、不自拼消息数组。做到这两条，cache 保护自动成立（后端 pathToHead + system 前缀冻结已保证）。**

---

## 四、New chat + 会话列表（本期做，需后端补 1 个 RPC）

**New chat**：新建一个 session 并切换过去。
**会话列表**：列出历史 session（title/createdAt），点击切换。

**架构触碰 + 依赖缺口**：
- 数据已在盘上：`<workDir>/.helios/sessions/<id>/meta.json`（title/createdAt）。kernel 有 `resumeSession(id)` 但**无 `listSessions()`** → 需新增。
- host 现有 handler 仅 sessionId/history/sendMessage/rollback → 需新增 RPC：`sessions.list()` / `session.create()` / `session.switch(id)`。
- **多会话 ⚠️**：当前 host 是"一连接一 session"，且多 session 共享同一 workDir → CheckpointPort（workDir 级快照）会互踩（见 agent-loop-review）。**本期若支持多会话切换，必须要么串行（同一时刻一个活跃 run），要么用 Projects 的独立 workDir 隔离（见五）。** 本期最小实现建议：会话列表可切换查看历史，但并发跑 run 的隔离标注为已知限制。

---

## 五、Projects（本期占位，语义已定）

**语义**：project = 一个独立 workDir + 归属其下的一组会话（+ 可选专属 manifest/配置）。
**为什么这么定**：它顺便解决第四节的 workDir 互踩——不同 project 绑不同 workDir，会话隔离自然成立。所以 Projects 不只是 UI 分组，是 **workDir 隔离的正确抽象**。

**架构触碰（未来实现时）**：
- 新数据模型：project = { id, name, workDir, manifest?, sessionIds[] }，持久化（如 `~/.helios/projects.json`）。
- kernel/host：`createSession` 要能按 project 指定 workDir（现在 workDir 是 Kernel 级固定，见 kernel.ts:119）→ 需让 Session 能带自己的 workDir，或一 project 一 Kernel 实例。
- RPC：`projects.list/create/open/delete`。
**本期**：侧边栏入口置灰或显示"即将推出"，不接后端。

---

## 六、Artifacts（本期占位，语义已定）

**语义**：agent 生成/修改的**文件产物浏览器**——列出本次会话/项目里被 Write/Edit 触及的文件，点开看内容 + diff（对接 CheckpointPort 的快照可做 before/after）。**不是**可渲染 HTML 预览（那是更大的另一件事，未来再议）。

**架构触碰（未来实现时）**：
- 数据来源：workDir 文件系统 + tool 执行记录（哪些文件被 Write/Edit）。事件流里 tool_execution 已带工具名/输入 → 可提取"被改文件"列表。
- diff：CheckpointPort 每 turn 快照可提供 before 版本。
- RPC：`artifacts.list()` / `artifacts.read(path)` / `artifacts.diff(path, turnId)`（经 FileSystemPort，受 PathGuard 约束——不能越 workDir）。
**本期**：入口占位。

---

## 七、Ports（本期只读展示，运行时 link = v2）

**本期形态**：一个"已装 Ports / 可用工具"只读面板。数据来自现有 `kernel.listTools()`（可加 RPC `ports.list()` 暴露 manifest 里已装的 port + 各 provider 的工具）。展示：port 名、来源包、提供的工具、启用状态（只读）。

**⚠️ 运行时 link 为什么是 v2（不是画个市场页那么简单）**：
- 现状：`PORT_META` + `PortName` 是**编译期封闭集合**；实现由启动时 manifest 一次性装配后冻结（见 pluginLoader.ts）。
- "运行时 link 一个 port 进正在跑的 agent" 需要贯穿 **UI → protocol → host → kernel** 的纵切：
  1. kernel 新增"启动后动态 activate 一个 CapabilityProvider"的能力（现在 start() 后冻结）。
  2. **范围必须限定在 CapabilityProvider（加工具/能力）**，不含运行时替换单实例 Port（memory/checkpoint 替换会破坏进行中会话状态，已排除）。
  3. link 的物理形式 = host（node）侧 `import()` 一个本地 port 目录（`importPlugin` 已支持 `./path` 本地路径）——**只能在 host 端做，浏览器不能 import 本地/跑 node 实现**。
  4. 新 RPC：`ports.link({path})` / `ports.toggle(name)`，host 转调 kernel 动态激活。
- 结论：本期只读；运行时 link 单独立项做 v2，UI 先把只读列表和"link"按钮（置灰/提示 v2）画出来。

---

## 八、Customize（本期做轻量版）

配置面板，本期做纯前端 + 配置持久化（localStorage 不可用则内存/后端存）：
- system prompt 自定义（覆盖默认）。
- 模型选择（从已注册 LLMProvider 列表选）。
- 主题（本期仅暖色，占位）。
- 连接设置（WS host:port）。
**架构触碰**：system/model 要能传给 host 的 createSession（现在 llmOptions 在 Kernel 级）→ 可能需 RPC 支持按会话覆盖。本期若嫌重，Customize 先只做"连接设置 + 主题占位"，其余标未来。

---

## 九、本期交付清单

**纯前端（apps/web + ui-chat）**：
- Anthropic 风视觉系统（色板/字体/间距 token）。
- 侧边栏组件（可折叠、导航、会话列表分组、连接状态）。
- 完整 ChatView（markdown、工具卡片三态、流式、停止、回溯入口、空态）。
- Projects/Artifacts/Ports/Customize 占位页（Ports 出只读真数据）。

**需后端新增（最小）**：
- RPC + kernel：`sessions.list()`（列历史会话，数据已在 meta.json）。
- RPC：`ports.list()`（暴露已装 port/工具，只读）。
- （New chat 多会话若做）`session.create/switch` + 多会话隔离限制标注。

**docs 记录未做**：Projects/Artifacts 完整功能、Ports 运行时 link（v2 纵切方案）、虚拟列表、审批 UI、dark mode、附件。

---

## 十、关键风险与依赖（动手前须知）

1. **多会话 × workDir 互踩**：New chat 若允许多会话并发 run，checkpoint 会互相覆盖。本期要么串行、要么等 Projects 的 workDir 隔离。别给虚假并发承诺。
2. **运行时 link 是纵切非 UI**：Ports 市场的"安装"本质是 kernel 热插拔能力，本期只读，v2 单独立项。
3. **浏览器能力边界**：link/跑 port 实现只能在 host(node)，web 仅发指令。
4. **本机验证**：视觉/交互最终需真机 + 真实 LLM 网关端到端确认（沙箱无网跑不了 vite/真模型）。
