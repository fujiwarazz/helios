# Code 模式与 Workspace 平台设计

**日期：** 2026-08-12
**状态：** 根据独立评审修订，待复核
**范围：** Helios Electron、Web、CLI 的首期 Code 模式，以及三端共用的 Workspace 平台能力

## 1. 结论

Helios 首期采用“轻量平台化 Workspace”方案：默认进入 Chat，用户可在主页面切换到 Code；Sidebar 不变，Code 的差异集中在输入区上方的仓库选择器。仓库可来自宿主可见的本地目录，或通过 HTTPS/SSH Git URL 执行 `git clone`。运行方式可选“原仓库”或“Worktree”，默认原仓库，对齐 Codex 的低打扰行为。

Code/Chat 不应成为两套 Agent。二者共用 Kernel、工具、Session、编辑记录和 Artifact 协议；差别仅在首次发送前如何得到 Workspace：

- Chat 自动得到一个独立的托管 Workspace。
- Code 必须选择一个仓库 Workspace。
- 首条消息发送时，`sessionId` 与 Workspace 绑定并锁定；换仓库需新建会话。

首期 UI 只允许一个仓库，但平台数据结构从第一天使用 `roots[]`，避免未来多仓迁移。云端 Sandbox、跨 Sandbox 文件同步和云数据存储不在首期实现范围，只通过稳定 ID、Store 接口和 Runtime 接口保留替换点。

## 2. 需求

### 2.1 用户可见需求

1. 首页默认是 Chat，可显式切换到 Code；切换交互参考 Valos。
2. Sidebar、会话列表和其他入口在两种模式下保持一致。
3. Code 输入区上方可选择代码仓库：
   - 宿主可访问的本地目录；
   - HTTPS 或 SSH Git URL，首期只执行 `git clone`，不提供 SSH Runtime；
   - 原仓库或 Worktree，默认原仓库。
4. 首期一个会话绑定一个仓库；首次发送后仓库、物化方式和分支不可修改。
5. Chat 和 Code 都能读写文件。Chat 文件写入该 Chat 的独立 Workspace，Code 文件写入绑定的仓库或 Worktree。
6. 会话消息、编辑记录、Diff 和产物引用按 `sessionId` 隔离；文件本体属于 Workspace。
7. 恢复历史会话时，系统能先找到 Workspace，再恢复正确 Runtime 和 Session。
8. Electron、Web 和 CLI 的入口不同，但最终进入同一 Workspace Platform 和 Kernel。

### 2.2 平台能力需求

- Workspace Catalog：保存稳定 Workspace 身份、来源和 roots。
- Repository Service：导入本地目录、Git Clone、仓库状态检查。
- Materializer：把稳定 Workspace 解析成当前宿主可使用的绝对目录，支持 `direct` 和 `worktree`。
- Session Binding：持久化 `sessionId -> workspaceId + roots + runtimeId`。
- Runtime Registry：按绑定创建或复用 Workspace-scoped Kernel。
- Workspace Memory：按 `workspaceId` 保存共享提炼记忆；Session 只读注入，不读取其他 Session 全文。
- Edit Record Store：按 `sessionId` 保存可审计的文件编辑记录。
- 可替换 Store/Runtime 接口：本地实现先落地，未来可换云 Metadata Store 和 Cloud Sandbox Runtime。

### 2.3 非目标

- 首期 UI 不支持一个会话选择多个仓库。
- 不做 SSH 远程命令执行、远程目录挂载或 SSH Runtime。
- 不做浏览器本机目录直通远程 Web Host；浏览器无法把本机绝对路径安全交给服务端工具。
- 不做 Cloud Sandbox、跨 Sandbox Workspace 同步、冲突合并和离线副本。
- 不做完整的 Artifact 历史管理页。
- 不让运行中的 Session 动态换仓库，也不把 `KernelOptions.workDir` 变成可变全局状态。

## 3. Valos 的实现与 Helios 的取舍

### 3.1 Valos 如何做

本节结论基于本地 `code-agent-view` 父仓库提交 `e26da559fe5f0691b820132d1aabf19b15eae7c7`，其中 `modules/code-agent` submodule 固定在 `eb00aa5d5bb4c9f3e51bd1deb56af671b3c76c62`。关键证据路径：

- `modules/code-agent/packages/vectorx-code/src/agentLoop/types/agent/workspaceDirs.ts`：WorkspaceDirs 定义。
- `apps/valos-electron/src/workbench/taskspace/electron-main/taskSpaceModelService.ts`：仓库、worktree 和 taskWorkDir 物化。
- `apps/valos-electron/src/workbench/taskspace/electron-main/taskSpaceStorage.ts`：Normal group 共享目录。
- `modules/code-agent/packages/revan-core/src/services/session/node/sessionDiffService.ts`：会话 Diff/编辑记录。
- `modules/code-agent/packages/revan-core/src/services/artifactView/`：Artifact 广播和文件内容读取。

Valos 用 TaskSpace 分离 Group、Activity、Task 和 Repo，并在创建 Session 前把选择归一成路径层对象：

```ts
interface WorkspaceDirs {
  workspaceId: string
  primaryDir: string
  additionalDirs: string[]
}
```

有序仓库列表的第一项成为 `primaryDir`，其余成为 `additionalDirs`。Shell、搜索、LSP、MCP、技能加载和权限判断都使用这组目录，而不是只依赖单个 cwd。每个仓库有独立的 `taskWorkDir`。

Valos 的 Normal/Chat 在没有代码仓库时使用 Group 共享目录，形如 `~/<App>-Projects/normal_group_space/<groupId>/`。文件编辑会直接写 Workspace，同时在全局 Session 目录的 `code_tool_record.json` 中记录 `agentId`、`toolUseId`、`filepath`、`before`、`after`、`operation` 和 `userAction`。Artifact 主要是 Runtime 带 `sessionId` 发出的 `openFile`、`openDiffView`、Markdown 或 URL 动作，由 Electron/Web/CLI 各自消费，并非另一份文件数据库。

### 3.2 Helios 借鉴什么

- 使用稳定 `workspaceId`，运行前再解析实际目录。
- 首期单仓但数据模型保留有序 roots，为多仓预留。
- 文件本体与 Session 元数据分开：文件在 Workspace，编辑审计在 Session Store。
- Runtime 发送语义化 Artifact 动作，消费端只负责展示。
- 所有文件权限基于解析后的 Workspace roots，而不是 UI 传来的任意路径。

### 3.3 Helios 不照搬什么

- 不复制完整 TaskSpace/Group/Activity 领域模型；当前产品复杂度不需要。
- Chat 默认使用独立 Workspace，而不是默认 Group 共享目录。
- 不在首期实现 Valos 的多仓执行链和云 RepoPool。
- 不把 Electron 主进程实现当平台接口；平台包必须可由 Web Host 和 CLI 复用。

## 4. 核心领域模型

```ts
type SessionMode = "chat" | "code"
type WorkspaceKind = "managed-chat" | "local-directory" | "git-clone"
type MaterializationStrategy = "direct" | "worktree"

interface Workspace {
  id: string
  name: string
  kind: WorkspaceKind
  roots: WorkspaceRoot[]
  createdAt: number
  updatedAt: number
}

interface WorkspaceRoot {
  id: string
  displayName: string
  source:
    | { type: "managed" }
    | { type: "local"; path: string }
    | { type: "git"; remoteIdentity: string; repositoryId: string }
  git?: {
    defaultBranch?: string
  }
}

interface WorkspaceRootBinding {
  rootId: string
  strategy: MaterializationStrategy
  materializationId: string
  branch?: string
  revision?: string
}

interface WorkspaceRootSelection {
  rootId: string
  strategy: MaterializationStrategy
  branch?: string
}

interface SessionWorkspaceBinding {
  sessionId: string
  mode: SessionMode
  workspaceId: string
  roots: WorkspaceRootBinding[]
  runtimeId?: string
  createdAt: number
}

interface SessionRecord {
  schemaVersion: 1
  meta: {
    id: string
    title: string
    createdAt: number
    updatedAt: number
  }
  binding: SessionWorkspaceBinding
  state: "starting" | "running" | "idle" | "interrupted"
  auditStatus: "complete" | "incomplete"
  auditGaps: Array<{ toolUseId?: string; reason: string; createdAt: number }>
}

interface MaterializedWorkspace {
  workspaceId: string
  primaryDir: string
  additionalDirs: string[]
  roots: Array<{
    rootId: string
    absolutePath: string
    readOnly: boolean
  }>
}
```

首期要求 `roots.length === 1`，但 Catalog、绑定和 Materializer 均不得把 root 写成单字段。`primaryDir/additionalDirs` 只存在于运行时解析结果，持久化的 Session 绑定以稳定 ID 和来源定义为主；本地目录 source 可以保存绝对路径，因为它本身就是宿主资源，但恢复时必须重新校验其存在性和权限。Git Catalog 只保存无凭据的 remote identity、repositoryId 和分支元数据，受管 repo 的物理路径由 Materializer 从 dataRoot 推导。HTTPS URL 含 userinfo 时直接拒绝，token/密码不得持久化。

`materializationId` 是稳定的物化身份：direct 使用 rootId 派生值；worktree 首期按 Session 生成，确保不同 Session/分支不共享物理 worktree。`runtimeId` 只是可失效的运行时提示，不参与恢复正确性；恢复以 workspaceId、root binding 和 materializationId 为准。

编辑记录：

```ts
interface EditRecord {
  schemaVersion: 1
  id: string
  sessionId: string
  workspaceId: string
  rootId: string
  toolUseId: string
  relativePath: string
  operation: "create" | "update" | "delete"
  before?: string
  after?: string
  createdAt: number
}
```

路径必须以 `rootId + relativePath` 保存，不能只保存绝对路径。绝对路径是某个 Runtime 副本的实现细节，未来迁移到云 Sandbox 后会变化。

## 5. 本地数据布局

由各宿主注入 `dataRoot`，本地默认值可为 `~/.helios`：

```text
~/.helios/
  workspaces/
    <workspaceId>.json
  managed-workspaces/
    <workspaceId>/root/              # Chat 独立文件空间
  repositories/
    <repositoryId>/source/           # 受管 git clone
  worktrees/
    <workspaceId>/<materializationId>/
      materialization.json                    # 来源 reference 与隔离分支元数据
      <rootId>/                               # Session 隔离 worktree
  workspace-memory/
    <workspaceId>/MEMORY.md
    <workspaceId>/<topic>.md
  workspace-state/
    <workspaceId>/<materializationId>/mutations.jsonl
  .host.lock                         # 首期单 Host 独占 dataRoot
  sessions/
    <sessionId>/
      session.json                    # SessionRecord，原子首发提交
      turns.jsonl
      compactions.jsonl
      edits.jsonl
      kernel-meta.json
```

本地目录的 `direct` 模式不会复制源代码；Workspace Catalog 只记录来源，文件仍在原目录。Git Clone 由平台放到受管目录。Session 数据不再写到 `<workDir>/.helios/sessions`，避免历史列表被当前仓库切碎，也避免 Chat 文件、会话元数据和代码仓库生命周期互相绑死。

`worktree` 不直接再次检出用户已占用的 `main`/feature 分支，而是从所选 reference 创建 `helios/<materializationId>` 独立分支。物化目录外的 `materialization.json` 保存 reference、revision 和实际工作分支，恢复时同时校验 Git common dir、注册路径、元数据和 HEAD，避免误复用其他仓库或来源分支。

所有持久化 JSON/JSONL 记录首期即带 `schemaVersion`，读取时做运行时校验；未知大版本拒绝读取，已知旧版本通过显式 migrator 转换，不做无提示猜测。

旧数据采用确定性迁移：

1. Electron/Web 将旧固定 `REPO_ROOT` 作为显式 legacy root；CLI 将当前 cwd 或用户提供的 `--legacy-workdir` 作为 legacy root。
2. Legacy Locator 只检查这些显式 roots 下的 `<workDir>/.helios/sessions/<sessionId>`；命中多个时返回歧义错误。
3. 将 legacy workDir 导入为 `local-directory` Workspace，生成 code/direct binding；复制 turn、compaction 和旧 meta 到全局临时 Session 目录。
4. 以一次原子 rename 提交带最小 meta、binding 和 `state: "idle"` 的 `session.json`，之后 resume 只走全局 Store。
5. 迁移不移动用户仓库文件，也不删除旧 Session；失败可安全重试。

## 6. 平台组件

```text
Electron / Web / CLI
        │ launch/resume request
        ▼
Workspace Platform
  ├─ WorkspaceCatalog
  ├─ RepositoryService
  ├─ WorkspaceMaterializer
  ├─ SessionCatalog / SessionBindingStore
  ├─ WorkspaceMemoryStore
  └─ EditRecordStore
        │ MaterializedWorkspace
        ▼
RuntimeRegistry
        │ workspace-scoped Kernel
        ▼
Kernel + Ports
```

建议新建 `@helios/workspace`，Node 本地实现位于同一个包中，但通过接口组织，避免 UI 依赖 Node API：

- `WorkspaceCatalog`：创建、读取、列出 Workspace。
- `RepositoryService`：`importLocalDirectory`、`cloneRepository`、`inspectGit`。
- `WorkspaceMaterializer`：`materialize(binding)`，实现 direct/worktree。
- `SessionCatalog`：全局列会话、读取绑定、写 Session 元数据。
- `RuntimeRegistry`：`createSession`、`resumeSession`、`release`；Kernel 实例按物化 root 和配置签名缓存。
- `WorkspaceMemoryStore`：以 workspaceId 为边界读取提炼记忆。
- `EditRecordStore`：追加和列出 Session 编辑记录。
- `WorkspaceMutationCoordinator`：按物理 root 串行化变更，记录 revision/owner/fingerprint，支撑外部修改告警与审计。

`Kernel` 继续只消费已经解析好的 `workDir`。Runtime Registry 不修改运行中的 Kernel cwd，而是为不同物化 Workspace 创建或复用 Kernel。首期单仓时 `workDir = primaryDir`。Registry 对 Kernel 做引用计数；最后一个引用释放时调用异步 `Kernel.dispose()`，由 Kernel 反向释放已加载的 Port、Capability、watcher 和子进程。

首期一个 dataRoot 只允许一个 Electron/Web/CLI Host 进程持有，通过 `.host.lock` 的跨进程原子 lockfile + heartbeat 保证；第二个 Host 必须提示改用其他 `HELIOS_DATA_ROOT`。进程内 mutation lease 因而足以串行，mutation journal 仍持久化 schemaVersion、revision、sessionId、runId、before/after fingerprint 和时间，供重启后的审计与外部变化提示。

## 7. Chat、Code 与 Session 生命周期

### 7.1 新 Chat

1. 用户点击 New Chat；UI launch request 为 `{ mode: "chat" }`。
2. Host 创建 `managed-chat` Workspace，其 root 位于 `managed-workspaces/<workspaceId>/root`。
3. Runtime Registry 物化并启动 Kernel。
4. 首次发送前 Session 是带过期时间的草稿；断连释放，启动 scavenger 清理没有 SessionRecord 引用的过期 managed root/runtime 和由该草稿创建的 worktree。已有 SessionRecord 引用的 worktree 永不由草稿清理器删除。
5. 首次发送时由一次性 `beforeFirstRun(text)` 原子创建 `session.json`，其中同时含最小 meta、binding、`state: "starting"` 和审计状态；随后改为 `running` 再执行 Agent run。
6. 整个 Agent run（包含全部工具 turn）期间保持 `running`；只有所有 turn 和 agent_end 数据都持久化后才改为 `idle`。异常或 dispose 中断改为 `interrupted`；能完整持久化的用户取消可回到 `idle`。启动 reconciliation 将遗留的 `starting/running` 标成 `interrupted`，同时追加“非正常退出”的 auditGap。
7. Chat 生成的文件直接位于该独立 Workspace；编辑记录写入 `sessions/<sessionId>/edits.jsonl`。

### 7.2 新 Code

1. UI 切到 Code，显示 Workspace Composer。
2. 用户选择已有 Workspace，或导入本地目录/执行 Git Clone。
3. 用户选择 direct/worktree，默认 direct。非 Git 目录禁用 worktree。
4. 选择变化时，UI 可重建尚未持久化的草稿 Session；不会污染会话列表。
5. 首次发送时 Host 通过 `beforeFirstRun(text)` 原子创建完整 SessionRecord；UI 先乐观锁定选择器，失败后再查询服务端权威 SessionRecord 决定是否解锁。
6. 后续切换仓库会创建新 Session；服务端拒绝修改已有 binding，不能只依赖前端禁用按钮。

### 7.3 Resume

1. Host 从全局 Session Catalog 读取并校验 `session.json`；找不到时才进入显式 Legacy Locator。
2. Catalog 读取 Workspace source；Materializer 验证/恢复实际目录。
3. Runtime Registry 获取对应 Kernel。
4. Kernel 从全局 Session 目录恢复 turn/compaction 数据。
5. 若本地目录已移动、Git 凭据失效或 Worktree 丢失，返回结构化恢复错误，UI 提供“重新定位”或“新建会话”，不得默默切到其他目录。

## 8. UI 与三端差异

### 8.1 共享 UI 边界

`@helios/ui-chat` 只新增通用扩展位，不引入 Git 或 Workspace 业务：

- `composerHeader?: ReactNode`：在输入框上方渲染模式/仓库控件。
- `canSubmit?: boolean`：物化未完成或选择无效时禁用发送。
- `onBeforeSubmit?: (text) => Promise<void> | void`：首发时锁定 UI 草稿。
- `onFirstSubmitted?: () => void`：服务端接受首条消息后固定选择。

Electron/Web 各自的 App Shell 提供 `ModeSwitch` 和 `WorkspaceComposer`，共享 DTO 和 RPC helper，不把仓库业务塞进 `ChatView`。若两端实现继续高度同构，可在本功能稳定后再抽 `ui-shell`；首期不以抽壳为前置条件。

### 8.2 Electron

- 本地目录使用 `dialog.showOpenDialog({ properties: ["openDirectory"] })`。
- Renderer 只能通过 preload 暴露的 `selectAndImportDirectory()` 请求选择；主进程在原生 dialog 返回后直接调用 RepositoryService，并只把 WorkspaceSummary 返回 Renderer。Renderer 永远不能向通用 import RPC 提交任意绝对路径。
- Git Clone、Worktree、Catalog 和 Runtime 均在主进程执行。
- SSH Git 继承主进程环境的 `git`、`ssh-agent` 和用户 known_hosts；不把私钥传给 Renderer。

### 8.3 Web

- 首期 Web Host 仅允许绑定 loopback 地址，启动时若 host 不是 `127.0.0.1`、`::1` 或 `localhost` 则拒绝启动；远程部署所需认证、Origin/CSRF 和租户授权单独列入后续文档。
- “本地目录”指 Web Host 所在机器可见的目录，不是浏览器用户电脑的目录。
- Host 仅允许浏览/导入 `HELIOS_WORKSPACE_ROOTS` 配置的根目录；RPC 必须使用路径 guard、realpath 和 allowlist，禁止任意服务器路径探测。
- 未配置允许根目录时隐藏“本地目录”，只提供 Catalog 中已有 Workspace 和 Git Clone。
- Clone、Materialize 和 Agent Runtime 都在 Web Host 执行。浏览器仅持有 workspaceId，不传可信绝对路径。

### 8.4 CLI

建议入口：

```text
helios                         # Chat，独立托管 Workspace
helios --code .                # Code，当前目录，direct
helios --code /path/to/repo --worktree
helios --clone git@host:org/repo.git
helios --workspace <id>
helios --resume <sessionId>
```

`--resume` 以持久化 binding 为准，不允许同时用 `--code` 覆盖仓库。无交互场景中的 Clone/Worktree 错误以非零退出码和可读 stderr 返回。

## 9. Host、Protocol 与 Kernel 修改边界

### 9.1 Host

当前 Host 在连接建立时把一个固定 Kernel 的 Session 绑到 Transport。目标改为：

- `serveWorkspaceHostOverWs` / `serveWorkspaceHostOverElectronIpc` 接收 Runtime Registry。
- 新连接请求携带 `resumeSessionId` 或 `SessionLaunchRequest`。
- Host 通过 Registry 得到 `{ kernel, session, binding }` 后再调用 Session RPC 绑定。
- `sessions.list` 从全局 Session Catalog 查询，不再调用当前 Kernel 扫描当前 workDir。
- Workspace RPC 至少包括 `workspaces.list`、`workspaces.importLocal`、`workspaces.clone`、`workspaces.inspect`。

为了平滑迁移，可保留 `serveKernelOverWs` 和 `serveKernelOverElectronIpc` 作为旧测试/嵌入方的兼容包装，内部构造单 Workspace Registry。

### 9.2 Contracts 与 Protocol

可序列化 Workspace DTO 由 `@helios/workspace` 的无副作用 `types.ts` 单一导出，浏览器消费方只做 type-only import；Node 路径操作和 Git 实现不进入 contracts。`@helios/protocol` 继续只负责通用 RPC envelope/transport，不反向依赖 Workspace 领域。WS query/Electron connect request 只传 mode、workspaceId、`WorkspaceRootSelection` 和 sessionId；materializationId、runtimeId 和实际路径只能由 Host 生成。所有请求均由 Host 根据 Catalog 重新解析。

### 9.3 Kernel

- `KernelOptions` 新增明确的 Session 数据目录或 Session Store 注入点；`workDir` 仍是工具工作目录。
- mode/workspaceId 只属于平台 `SessionRecord.binding`；Kernel 私有 `KernelSessionMeta` 只保存 title、时间和 run/turn index。
- `Session` 的 turn/compaction 持久化改用注入路径，不再拼 `<workDir>/.helios/sessions`。
- `Kernel.listSessions()` 标记兼容用途；产品会话列表移到 Host 的 Session Catalog。
- `KernelContext.workDir` 继续用于工具和 hooks；Workspace 共享记忆通过按 workspaceId 配置的 MemoryPort 读取。

## 10. 编辑记录、产物和记忆

### 10.1 编辑绑定与并发

首期给 Tool 增加可选的文件变更描述元数据，Write/Edit 明确声明目标路径。工具执行器在成功写入前后读取内容并追加 EditRecord，路径经当前 materialized root 归一为 `rootId + relativePath`。记录失败不得使已经成功的文件编辑回滚，但必须持久化 `auditStatus: "incomplete"` 和 auditGap，并向 UI 广播警告。

同一物理 direct root 可被多个 Session 读取，但整个 Agent run（从 checkpoint 前到 agent_end 持久化后）由 WorkspaceMutationCoordinator 保守串行，即使最终只读也不提前放锁。每个 run 记录 root fingerprint：Git root 使用 HEAD、index、tracked/ignored/untracked 内容 hash；非 Git root 使用排除 `.git/.helios/node_modules` 的内容 Merkle hash。Fingerprint 用于展示外部变化告警和审计，不能证明 run 期间每个字节的来源。

因此首期所有 Workspace Platform Session 的 rollback policy 固定为 `conversation-only`：只移动消息树 HEAD，不调用全目录 CheckpointPort.restore，也不静默覆盖文件。旧低层 `serveKernel*` 兼容入口保留既有行为；新 Host/UI 必须明确显示“回退对话，不修改文件”。可证明来源的 overlay/journal 与安全文件恢复单独列入后续，完成前不开放自动文件 rollback。Worktree 因 materializationId 按 Session 隔离，但同样遵守此保守策略。

Bash 可任意修改文件，无法仅靠参数可靠推断 `toolUseId -> file`。首期通过 turn checkpoint / Git diff 展示其结果，但不承诺逐文件 EditRecord；后续引入文件系统 journal 或 Sandbox overlay 后再补齐。这个限制必须在 UI 和验收中明确，避免把不完整审计误当安全边界。

### 10.2 产物

文件本体只保存一份，位于 Workspace。Runtime 可广播带 `sessionId/workspaceId/rootId` 的语义动作：

- `openFile`
- `openDiff`
- `showMarkdown`
- `openUrl`

Electron、Web、CLI 分别消费；首期不复制文件到 Artifact 数据库。`edits.jsonl` 和消息中的工具事件提供最小可恢复索引，完整 Artifact 历史页列入后续文档。

### 10.3 Workspace 记忆

共享记忆位于 `workspace-memory/<workspaceId>`，不是某个 Session 的消息全文。该目录使用独立、受 dataRoot 限制的 FileSystemPort，而不是 Workspace 的 WorkDirGuard；`memory-fs` 通过受信 `storageDir` 构造专用 guarded filesystem。新 Session 首次构造 system prefix 时只读一次 Workspace 级提炼记忆，与当前 prompt cache 的“每会话冻结前缀”纪律一致。首期不自动合并其他会话全文，也不跨 Sandbox 同步。

## 11. 安全与错误处理

- 本地路径必须 `realpath` 后再做 allowlist/Workspace root 校验，防止 `..` 和符号链接越界。
- Git 命令使用参数数组调用，不拼 shell 字符串；Remote URL、branch 和目标目录分别校验。HTTPS userinfo 一律拒绝；生产 GitRunner 支持 AbortSignal、超时和子进程树清理，默认 `GIT_TERMINAL_PROMPT=0`，交互认证由宿主 credential helper/ssh-agent 预先完成。
- Clone 目标由平台生成，用户不能指定任意覆盖目录；失败时保留诊断日志并清理未完成临时目录。
- SSH 私钥和 token 不进入 Workspace Catalog、Session Meta、日志或前端 RPC；认证继承宿主 Git credential helper/ssh-agent。
- direct 模式会真实修改用户原仓库，UI 在选择时明确提示；worktree 是隔离选项但不是安全 Sandbox。Workspace Platform 首期 rollback 只回退对话，不覆盖文件。
- 同一 Workspace 的物化操作按 workspaceId 加锁；并发 Clone/Worktree 创建要幂等。
- SessionRecord 采用 create-once 语义；重复首发只能读到同一 binding，冲突请求返回错误。
- Resume 找不到路径时不得回退到进程 cwd。

## 12. 验收口径摘要

- 三端均能创建 Chat 独立 Workspace，文件不写入 Helios 源码仓库。
- Electron、Web Host 和 CLI 均能使用 Git Clone；Electron/本地 Web/CLI 能导入宿主本地目录。
- Code 默认 direct，可选择 worktree；非 Git 目录只允许 direct。
- 首发后服务端拒绝换 Workspace；新会话可选择其他 Workspace。
- Session 列表跨 Workspace 可见；resume 回到原 Workspace。
- 进程在首发各持久化边界崩溃后，Session 要么不存在，要么以 interrupted 状态可见，不允许出现仅有 binding 的隐藏半会话。
- Write/Edit 产生含 sessionId、workspaceId、rootId、相对路径和 before/after 的记录。
- Workspace A 的 Session 无法读写 Workspace B 的路径。
- 旧 `<workDir>/.helios/sessions` 会话可从显式 legacy root 合成 Workspace/binding 并迁移；多 root 命中时明确报错。
- Web 不能通过 RPC 枚举 allowlist 外的服务器目录。
- Web 首期非 loopback 绑定会启动失败；Electron Renderer 不能提交未经原生 dialog 授权的绝对路径。

具体任务、命令和逐项验收见实施 Plan；云端、多仓和完整 Artifact 历史见独立后续文档。
