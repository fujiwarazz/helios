# Code Mode Workspace Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Helios 增加默认 Chat、可切换 Code 的单仓工作流，并把仓库导入、Git Clone、direct/worktree 物化、Session 绑定、编辑记录和 Workspace 记忆下沉为 Electron/Web/CLI 共用的平台能力。

**Architecture:** 新增 `@helios/workspace`，用稳定 workspaceId/rootId 管理来源和本地物化；Host 通过 RuntimeRegistry 在连接时解析 binding，再创建 workspace-scoped Kernel。Kernel 的工具 cwd 与 Session 数据目录分离，UI 只发送稳定 ID，Electron/Web/CLI 分别提供目录入口和传输适配。

**Tech Stack:** TypeScript 5、Node.js 20、pnpm workspace、Vitest、React、Electron IPC、WebSocket、系统 Git CLI

---

## 1. 本期需求与边界

- 默认 Chat，主页面显式切换 Code；Sidebar 不分叉。
- Chat 自动创建独立托管 Workspace；Code 选择本地目录或 HTTPS/SSH Git Clone。
- 运行方式支持 direct/worktree，默认 direct；非 Git 目录禁用 worktree。
- 首期单仓，平台模型使用 `roots[]`；首次发送后服务端锁定 binding。
- Chat/Code 共用 Kernel 工具；文件在 Workspace，Session 消息/编辑记录按 sessionId 隔离。
- Electron 使用原生目录选择；Web 的本地目录只代表 Host 可访问且被 allowlist 的目录；CLI 使用 flags。
- 首期不做多仓 UI、SSH Runtime、Cloud Sandbox、跨 Sandbox 同步和完整 Artifact 历史页。

详细设计：`docs/superpowers/specs/2026-08-12-code-mode-workspace-platform-design.md`。后续范围：`docs/code-mode-workspace-platform-follow-ups.md`。

## 2. 文件结构与职责

### 新建

- `packages/workspace/package.json`：平台包依赖和 scripts。
- `packages/workspace/tsconfig.json`：继承仓库 TypeScript 配置。
- `packages/workspace/src/types.ts`：Workspace、root、binding、materialized、edit DTO 的单一真源。
- `packages/workspace/src/paths.ts`：dataRoot 下所有受管路径构造和 ID 校验。
- `packages/workspace/src/catalog.ts`：Workspace JSON Catalog。
- `packages/workspace/src/repositoryService.ts`：本地目录导入、Git Clone、Git 状态探测。
- `packages/workspace/src/materializer.ts`：direct/worktree 物化和互斥锁。
- `packages/workspace/src/sessionCatalog.ts`：全局 Session 元数据、binding、旧数据兼容读取。
- `packages/workspace/src/memoryStore.ts`：Workspace 提炼记忆文件 Store。
- `packages/workspace/src/editRecordStore.ts`：Session 编辑 JSONL Store。
- `packages/workspace/src/runtimeRegistry.ts`：MaterializedWorkspace 到 Kernel/Session 的生命周期。
- `packages/workspace/src/index.ts`：公共导出。
- `packages/workspace/src/*.test.ts`：以上组件的单元测试。
- `apps/web/src/components/ModeSwitch.tsx`：Chat/Code 切换。
- `apps/web/src/components/WorkspaceComposer.tsx`：Web 仓库选择与 Clone 表单。
- `apps/electron/src/components/ModeSwitch.tsx`：Electron 模式切换。
- `apps/electron/src/components/WorkspaceComposer.tsx`：Electron 仓库选择与目录按钮。
- `apps/electron/electron/directoryDialog.ts`：可测试的原生目录选择窄适配。

### 修改

- `packages/ports/src/types.ts`：Tool 文件变更描述元数据；KernelContext 保持工具工作目录语义。
- `packages/kernel/src/kernel.ts`：分离 workDir/sessionDataRoot，支持编辑记录注入。
- `packages/kernel/src/session.ts`：Session 数据目录注入、扩展 SessionMeta、首次持久化 binding 钩子。
- `packages/kernel/src/builtin/tools.ts`：Write/Edit 声明目标文件。
- `packages/kernel/src/agentLoop/executeTools.ts`：成功编辑前后采集记录。
- `packages/host/src/index.ts`：RuntimeRegistry 驱动的 WS/Electron Host、Workspace RPC、兼容旧入口。
- `packages/ui-chat/src/ChatView.tsx`：通用 composer slot、发送 gate 和首发回调。
- `packages/ui-chat/src/styles/chat.css`：composer header 布局。
- `apps/web/src/App.tsx`、`apps/web/src/lib/rpc.ts`、`apps/web/server/host.ts`：Web 状态和 Host 配置。
- `apps/electron/src/App.tsx`、`apps/electron/src/lib/rpc.ts`、`apps/electron/src/electronRpc.ts`：Electron 状态与 launch request。
- `apps/electron/electron/main.ts`、`apps/electron/electron/preload.ts`、`apps/electron/src/global.d.ts`：平台启动和安全目录 IPC。
- `apps/cli/src/index.ts`：Code/Clone/Workspace/Worktree flags。
- 各 package 的 `package.json`：加入 `@helios/workspace` 依赖。

## 3. 实施任务

### Task 1: 建立 Workspace 领域类型与安全路径布局

**Files:**
- Create: `packages/workspace/package.json`
- Create: `packages/workspace/tsconfig.json`
- Create: `packages/workspace/src/types.ts`
- Create: `packages/workspace/src/paths.ts`
- Create: `packages/workspace/src/paths.test.ts`
- Create: `packages/workspace/src/index.ts`

- [ ] **Step 1: 写安全路径和类型测试**

在 `paths.test.ts` 覆盖：合法 ID 生成预期路径；`../x`、绝对路径、斜杠和空 ID 被拒绝；受管 Chat、Clone、Worktree、Session 和 Memory 路径均位于 dataRoot 下。

```ts
it("rejects ids that can escape dataRoot", () => {
  const paths = new WorkspacePaths("/data/helios")
  expect(() => paths.sessionDir("../outside")).toThrow(/invalid id/)
})

it("keeps managed roots below dataRoot", () => {
  const paths = new WorkspacePaths("/data/helios")
  expect(paths.managedRoot("ws_1")).toBe("/data/helios/managed-workspaces/ws_1/root")
  expect(paths.editLog("sess_1")).toBe("/data/helios/sessions/sess_1/edits.jsonl")
})
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `pnpm vitest run packages/workspace/src/paths.test.ts`
Expected: FAIL，提示 `@helios/workspace` 或 `WorkspacePaths` 尚不存在。

- [ ] **Step 3: 实现类型和 WorkspacePaths**

`types.ts` 至少完整导出：

```ts
export type SessionMode = "chat" | "code"
export type WorkspaceKind = "managed-chat" | "local-directory" | "git-clone"
export type MaterializationStrategy = "direct" | "worktree"

export interface WorkspaceRoot {
  id: string
  displayName: string
  source:
    | { type: "managed" }
    | { type: "local"; path: string }
    | { type: "git"; remoteUrl: string; repositoryId: string }
  git?: { repoRoot: string; defaultBranch?: string }
}

export interface Workspace {
  id: string
  name: string
  kind: WorkspaceKind
  roots: WorkspaceRoot[]
  createdAt: number
  updatedAt: number
}

export interface WorkspaceRootBinding {
  rootId: string
  strategy: MaterializationStrategy
  branch?: string
  revision?: string
}

export interface SessionWorkspaceBinding {
  sessionId: string
  mode: SessionMode
  workspaceId: string
  roots: WorkspaceRootBinding[]
  runtimeId?: string
  createdAt: number
}

export interface MaterializedWorkspace {
  workspaceId: string
  primaryDir: string
  additionalDirs: string[]
  roots: Array<{ rootId: string; absolutePath: string; readOnly: boolean }>
}

export interface SessionLaunchRequest {
  mode: SessionMode
  workspaceId?: string
  roots?: WorkspaceRootBinding[]
}

export interface WorkspaceSummary {
  id: string
  name: string
  kind: WorkspaceKind
  roots: Array<{ id: string; displayName: string; git: boolean }>
}

export interface CloneWorkspaceRequest { remoteUrl: string; name?: string }
export interface ImportLocalWorkspaceRequest { path: string; name?: string }

export interface EditRecord {
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

`WorkspacePaths` 用 `resolve(dataRoot)` 固定根，并用 `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/` 校验每个 ID；所有路径只由已校验 ID 和固定段组成。`package.json` 同时导出 `"./types": "./src/types.ts"`，且该文件只能包含类型，供浏览器 type-only import。

- [ ] **Step 4: 运行包测试和类型检查**

Run: `pnpm vitest run packages/workspace/src/paths.test.ts && pnpm --filter @helios/workspace typecheck`
Expected: 全部 PASS，TypeScript 无错误。

- [ ] **Step 5: 提交**

```bash
git add packages/workspace
git commit -m "feat(workspace): add workspace domain model and paths"
```

### Task 2: 实现 Workspace Catalog 和托管 Chat Workspace

**Files:**
- Create: `packages/workspace/src/catalog.ts`
- Create: `packages/workspace/src/catalog.test.ts`
- Modify: `packages/workspace/src/index.ts`

- [ ] **Step 1: 写 Catalog 失败测试**

测试使用 `mkdtemp`，覆盖 `createManagedChat` 创建真实 root、`get/list` round-trip、损坏 JSON 返回带文件名的错误、相同 ID 的并发写不产生半文件。

```ts
const workspace = await catalog.createManagedChat("New chat")
expect(workspace.kind).toBe("managed-chat")
expect(workspace.roots).toHaveLength(1)
await expect(stat(paths.managedRoot(workspace.id))).resolves.toBeDefined()
expect(await catalog.get(workspace.id)).toEqual(workspace)
```

- [ ] **Step 2: 确认测试失败**

Run: `pnpm vitest run packages/workspace/src/catalog.test.ts`
Expected: FAIL，提示 `WorkspaceCatalog` 未导出。

- [ ] **Step 3: 实现原子 JSON Catalog**

实现 `LocalWorkspaceCatalog`：

```ts
export interface WorkspaceCatalog {
  get(id: string): Promise<Workspace | undefined>
  list(): Promise<Workspace[]>
  put(workspace: Workspace): Promise<void>
  createManagedChat(name?: string): Promise<Workspace>
}
```

`put` 先写同目录的 `<id>.json.tmp-<pid>-<nonce>`，再 `rename`；`createManagedChat` 先 `mkdir(root, {recursive:true})` 再写 Catalog。`list` 只读取 `.json`，按 `updatedAt` 倒序。

- [ ] **Step 4: 跑测试**

Run: `pnpm vitest run packages/workspace/src/catalog.test.ts`
Expected: PASS，包含 create/get/list/corruption/atomic-write 用例。

- [ ] **Step 5: 提交**

```bash
git add packages/workspace/src/catalog.ts packages/workspace/src/catalog.test.ts packages/workspace/src/index.ts
git commit -m "feat(workspace): persist workspace catalog"
```

### Task 3: 实现本地目录导入与 Git Clone

**Files:**
- Create: `packages/workspace/src/repositoryService.ts`
- Create: `packages/workspace/src/repositoryService.test.ts`
- Modify: `packages/workspace/src/index.ts`

- [ ] **Step 1: 写 RepositoryService 测试**

覆盖：本地目录经 realpath 归一；allowlist 外拒绝；Git 目录识别 repo root/default branch；非 Git 目录可 direct；HTTPS/SSH URL 都以参数数组传给 Git；Clone 使用临时目录并在成功后 rename；失败不留下正式 Catalog 记录。

```ts
await expect(service.importLocalDirectory(outside)).rejects.toThrow(/outside allowed roots/)
const imported = await service.importLocalDirectory(repo)
expect(imported.roots[0]?.source.type).toBe("local")

await service.cloneRepository("git@github.com:org/repo.git")
expect(git.run).toHaveBeenCalledWith([
  "clone", "--", "git@github.com:org/repo.git", expect.stringContaining(".tmp-"),
])
```

- [ ] **Step 2: 确认红灯**

Run: `pnpm vitest run packages/workspace/src/repositoryService.test.ts`
Expected: FAIL，提示 `LocalRepositoryService` 未定义。

- [ ] **Step 3: 实现 GitRunner 和 RepositoryService**

```ts
export interface GitRunner {
  run(args: string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string }>
}

export interface RepositoryService {
  importLocalDirectory(path: string, name?: string): Promise<Workspace>
  cloneRepository(remoteUrl: string, name?: string): Promise<Workspace>
  inspectGit(path: string): Promise<{ repoRoot: string; defaultBranch?: string } | undefined>
}
```

生产 GitRunner 使用 `execa("git", args, { shell: false, reject: true })`。Clone URL 只允许 `https://`、`ssh://` 和 Git scp-like `user@host:path`；目标由 `WorkspacePaths.repositorySource(repositoryId)` 生成，禁止调用方提供。目录 allowlist 比较前对候选和允许根均 `realpath`。

- [ ] **Step 4: 跑测试和真实 Git 冒烟测试**

Run: `pnpm vitest run packages/workspace/src/repositoryService.test.ts`
Expected: PASS。

Run: `tmp_dir=$(mktemp -d); git init "$tmp_dir/source"; pnpm vitest run packages/workspace/src/repositoryService.test.ts -t "imports a real local git repository"`
Expected: PASS；测试清理自己的临时目录。

- [ ] **Step 5: 提交**

```bash
git add packages/workspace
git commit -m "feat(workspace): import local repositories and clone git remotes"
```

### Task 4: 实现 direct/worktree Materializer

**Files:**
- Create: `packages/workspace/src/materializer.ts`
- Create: `packages/workspace/src/materializer.test.ts`
- Modify: `packages/workspace/src/index.ts`

- [ ] **Step 1: 写物化测试**

覆盖：managed/local/clone 的 direct 返回正确路径；worktree 对非 Git root 拒绝；默认分支缺失时使用当前 HEAD；相同 binding 并发调用只创建一次；结果始终包含 rootId；首期多个 roots 返回明确 `single-root` 错误而不是静默忽略。

```ts
const result = await materializer.materialize(workspace, {
  sessionId: "sess_1",
  mode: "code",
  workspaceId: workspace.id,
  roots: [{ rootId: workspace.roots[0]!.id, strategy: "direct" }],
  createdAt: 1,
})
expect(result.primaryDir).toBe(await realpath(repo))
expect(result.additionalDirs).toEqual([])
```

- [ ] **Step 2: 确认失败**

Run: `pnpm vitest run packages/workspace/src/materializer.test.ts`
Expected: FAIL，提示 `LocalWorkspaceMaterializer` 未定义。

- [ ] **Step 3: 实现 Materializer**

```ts
export interface WorkspaceMaterializer {
  materialize(workspace: Workspace, binding: SessionWorkspaceBinding): Promise<MaterializedWorkspace>
}
```

direct 返回 source 的 realpath。worktree 使用 `git worktree add <generated-path> <branch-or-HEAD>`；每个 `${workspaceId}:${rootId}:${branch}` 使用进程内 Promise lock；路径已存在时先用 `git worktree list --porcelain` 验证归属，归属不符即报错。不要自动删除用户 worktree。

- [ ] **Step 4: 跑测试**

Run: `pnpm vitest run packages/workspace/src/materializer.test.ts`
Expected: PASS，Git 集成用例实际执行临时 repo 的 `git worktree add`。

- [ ] **Step 5: 提交**

```bash
git add packages/workspace
git commit -m "feat(workspace): materialize direct and worktree roots"
```

### Task 5: 将 Session 数据从 workDir 分离并增加全局 Session Catalog

**Files:**
- Create: `packages/workspace/src/sessionCatalog.ts`
- Create: `packages/workspace/src/sessionCatalog.test.ts`
- Modify: `packages/kernel/src/session.ts`
- Modify: `packages/kernel/src/kernel.ts`
- Modify: `packages/kernel/test/resume.test.ts`
- Modify: `packages/kernel/test/list-sessions-ports.test.ts`
- Modify: `packages/workspace/src/index.ts`

- [ ] **Step 1: 为 Kernel 写失败测试**

新增用例：`workDir=/repo`、`sessionDataRoot=/state/sessions` 时 turn/meta 只出现在 `/state/sessions/<id>`；resume 能恢复；不传新参数仍读取旧 `<workDir>/.helios/sessions`，保持 API 兼容。

```ts
const kernel = new Kernel({ workDir, sessionDataRoot, manifest })
await kernel.start()
const session = kernel.createSession({ askQuestion })
await session.sendMessage("hello")
await expect(readFile(join(sessionDataRoot, session.id, "meta.json"), "utf8")).resolves.toContain(session.id)
await expect(access(join(workDir, ".helios", "sessions", session.id))).rejects.toBeDefined()
```

- [ ] **Step 2: 确认 Kernel 测试失败**

Run: `pnpm vitest run packages/kernel/test/resume.test.ts packages/kernel/test/list-sessions-ports.test.ts`
Expected: FAIL，`sessionDataRoot` 尚未进入 KernelOptions。

- [ ] **Step 3: 修改 Kernel/Session 持久化边界**

在 `KernelOptions` 增加 `sessionDataRoot?: string`。SessionOptions 接收 `sessionDir: string`，`turnsDir()` 直接返回该值。默认值仍为 `join(workDir, ".helios", "sessions")` 以兼容现有嵌入方。另给 `CreateSessionOptions` 增加 `beforeFirstRun?: () => Promise<void>`；`Session.sendMessage()` 在追加用户消息和执行任何工具前只调用一次，失败则本次 run 不开始。Runtime Registry 用它原子创建 binding，从而满足“首次发送才落绑定”，同时避免 Agent 已改文件但 binding 尚未保存。扩展 `SessionMeta`：

```ts
export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  lastRunIndex: number
  lastTurnIndex: number
  mode?: "chat" | "code"
  workspaceId?: string
}
```

Kernel 产品路径不负责全局 list；保留的 `listSessions()` 扫描其 `sessionDataRoot`。

- [ ] **Step 4: 实现 SessionCatalog 与 binding create-once**

```ts
export interface SessionCatalog {
  list(): Promise<SessionMeta[]>
  getMeta(sessionId: string): Promise<SessionMeta | undefined>
  getBinding(sessionId: string): Promise<SessionWorkspaceBinding | undefined>
  createBinding(binding: SessionWorkspaceBinding): Promise<void>
}
```

`createBinding` 使用 exclusive create (`open(path, "wx")`)；文件存在时只有内容完全相同才幂等成功，否则抛 `SessionBindingConflictError`。Legacy Reader 仅接收宿主明确配置的旧 roots，不扫描整个磁盘。

- [ ] **Step 5: 跑迁移和兼容测试**

Run: `pnpm vitest run packages/kernel/test/resume.test.ts packages/kernel/test/list-sessions-ports.test.ts packages/workspace/src/sessionCatalog.test.ts`
Expected: PASS；测试证明新数据不进入 repo、旧数据可读、冲突 binding 被拒绝。

- [ ] **Step 6: 提交**

```bash
git add packages/kernel packages/workspace
git commit -m "refactor(session): separate session state from workspace files"
```

### Task 6: Workspace Memory 与 Runtime Registry

**Files:**
- Create: `packages/workspace/src/memoryStore.ts`
- Create: `packages/workspace/src/memoryStore.test.ts`
- Create: `packages/workspace/src/runtimeRegistry.ts`
- Create: `packages/workspace/src/runtimeRegistry.test.ts`
- Modify: `packages/memory-fs/src/index.ts`
- Modify: `packages/memory-fs/src/index.test.ts`
- Modify: `packages/workspace/src/index.ts`

- [ ] **Step 1: 写 Memory 隔离测试**

两个 workspaceId 写入不同记忆，新 Session 只能读取自身 Workspace 的 `MEMORY.md`；Session 首次构造前缀后修改记忆，不改变已运行 Session 的冻结前缀。

```ts
await memory.writeIndex("ws_a", "A memory")
await memory.writeIndex("ws_b", "B memory")
expect(await memory.readIndex("ws_a")).toBe("A memory")
expect(await memory.readIndex("ws_b")).not.toContain("A memory")
```

- [ ] **Step 2: 写 Runtime Registry 失败测试**

覆盖新 Chat 自动 Workspace、Code binding 解析、resume 先读 binding、相同 runtime key 复用 Kernel、release 后停止引用、缺失本地路径返回结构化错误且绝不使用 `process.cwd()`。

- [ ] **Step 3: 确认红灯**

Run: `pnpm vitest run packages/workspace/src/memoryStore.test.ts packages/workspace/src/runtimeRegistry.test.ts`
Expected: FAIL，两个实现尚不存在。

- [ ] **Step 4: 实现 MemoryStore 和 memory-fs storageDir**

`WorkspaceMemoryStore` 只允许 workspaceId 生成目录；主题 key 使用与 ID 等价的安全字符集。`@helios/memory-fs` 支持 manifest option `storageDir`：传入时读写该目录，不传时保留当前 `.helios/memory` 行为。Runtime Registry 为每个 Workspace 复制 manifest 并只覆写 MemoryPort entry 的 `options.storageDir`。

- [ ] **Step 5: 实现 RuntimeRegistry**

```ts
export interface BoundSession {
  kernel: Kernel
  session: Session
  binding: SessionWorkspaceBinding
  materialized: MaterializedWorkspace
}

export interface RuntimeRegistry {
  createSession(request: SessionLaunchRequest, options: CreateSessionOptions): Promise<BoundSession>
  resumeSession(sessionId: string, options: CreateSessionOptions): Promise<BoundSession>
  release(runtimeId: string): void
}
```

Chat 无 workspaceId 时调用 `createManagedChat`。Code 必须携带 Catalog 中存在的 workspaceId。`createSession` 只在内存中持有草稿 binding，并把 `sessionCatalog.createBinding(binding)` 注入 Session 的 `beforeFirstRun`；空草稿断开时不进入会话列表。runtime key 由 workspaceId、root binding、materialized paths、manifest hash 组成；Kernel 的 `workDir` 是 primaryDir，`sessionDataRoot` 是全局 sessions 根。

- [ ] **Step 6: 跑测试**

Run: `pnpm vitest run packages/memory-fs/src/index.test.ts packages/workspace/src/memoryStore.test.ts packages/workspace/src/runtimeRegistry.test.ts`
Expected: PASS，且 resume 测试断言 Kernel workDir 等于原 binding 解析路径。

- [ ] **Step 7: 提交**

```bash
git add packages/workspace packages/memory-fs
git commit -m "feat(workspace): add workspace memory and runtime registry"
```

### Task 7: 让 Host 使用 Runtime Registry 并开放 Workspace RPC

**Files:**
- Modify: `packages/host/src/index.ts`
- Modify: `packages/host/src/index.test.ts`
- Modify: `packages/host/src/electronIpc.test.ts`
- Modify: `packages/host/package.json`

- [ ] **Step 1: 写 WS/Electron Host 失败测试**

覆盖：launch Chat、launch Code、resume；`sessions.list` 跨 Workspace；`workspaces.list/importLocal/clone`；客户端伪造绝对 materialized path 不被采用；binding 冲突返回 RPC error；断开释放 runtime 引用。

```ts
const launch: SessionLaunchRequest = {
  mode: "code",
  workspaceId: workspace.id,
  roots: [{ rootId: root.id, strategy: "direct" }],
}
const client = await connectWs({ launch })
expect(await client.call("session.workspace")).toMatchObject({ workspaceId: workspace.id })
```

- [ ] **Step 2: 确认现有 Host 不支持 Registry**

Run: `pnpm vitest run packages/host/src/index.test.ts packages/host/src/electronIpc.test.ts`
Expected: 新用例 FAIL，提示 Workspace RPC 或 Registry serve 入口不存在。

- [ ] **Step 3: 使用平台的传输无关 DTO**

从 `@helios/workspace/types` type-only 导入 `SessionLaunchRequest`、`WorkspaceSummary`、`CloneWorkspaceRequest`、`ImportLocalWorkspaceRequest`。`packages/workspace/package.json` 为 `./types` 提供无副作用 subpath export。请求只允许 workspace/root 稳定 ID 和用户输入的 source，不包含 `primaryDir`、`additionalDirs` 或 materialized absolute path；`@helios/protocol` 保持通用传输层，不依赖 Workspace 领域。

- [ ] **Step 4: 实现 Registry Host**

新增：

```ts
serveWorkspaceHostOverWs({ registry, catalog, repositories, port, host, askQuestion })
serveWorkspaceHostOverElectronIpc({ registry, catalog, repositories, bridge, onConnect, askQuestion })
```

连接参数必须是二选一：`resumeSessionId` 或 `launch`。Host 得到 BoundSession 后复用现有 `bindSession` 事件桥接，但 `sessions.list` 改查 SessionCatalog，新增 `session.workspace` 和 Workspace RPC。旧 `serveKernelOverWs/ElectronIpc` 保留并通过固定 Kernel adapter 维持现有测试与消费方。

- [ ] **Step 5: 跑 Host 和 Protocol 回归**

Run: `pnpm vitest run packages/host packages/protocol`
Expected: 新旧 Host 测试全部 PASS，现有 WS/Electron transport 用例无回归。

- [ ] **Step 6: 提交**

```bash
git add packages/workspace/package.json packages/host
git commit -m "feat(host): bind sessions through workspace runtime registry"
```

### Task 8: 记录 Write/Edit 并广播最小 Artifact 动作

**Files:**
- Create: `packages/workspace/src/editRecordStore.ts`
- Create: `packages/workspace/src/editRecordStore.test.ts`
- Modify: `packages/ports/src/types.ts`
- Modify: `packages/kernel/src/builtin/tools.ts`
- Modify: `packages/kernel/src/agentLoop/executeTools.ts`
- Modify: `packages/kernel/src/agentLoop/types.ts`
- Modify: `packages/kernel/src/events.ts`
- Modify: `packages/kernel/src/kernel.ts`
- Modify: `packages/kernel/test/agent-loop-fixes.test.ts`
- Modify: `packages/workspace/src/runtimeRegistry.ts`

- [ ] **Step 1: 写 EditRecord Store 测试**

验证 append/list、损坏 JSONL 单行跳过并告警、路径只接受 rootId + 安全相对路径、大文件记录上限返回明确错误而不是截断成伪完整记录。

- [ ] **Step 2: 写 Kernel 工具归因失败测试**

用 mock FileSystemPort 执行 Write/Edit，断言 observer 收到同一 toolUseId、operation、before/after；失败 Edit 不记录；Read 不记录；observer 失败只产生 logger warning，工具成功结果不被改成失败。

```ts
expect(records).toEqual([
  expect.objectContaining({
    sessionId: session.id,
    toolUseId: "tool_1",
    relativePath: "src/a.ts",
    operation: "update",
    before: "old",
    after: "new",
  }),
])
```

- [ ] **Step 3: 确认红灯**

Run: `pnpm vitest run packages/workspace/src/editRecordStore.test.ts packages/kernel/test/agent-loop-fixes.test.ts`
Expected: 新用例 FAIL，Tool 尚无 mutation metadata。

- [ ] **Step 4: 增加 Tool mutation 契约并实现记录**

在 `Tool` 增加：

```ts
fileMutations?: (input: unknown) => Array<{
  path: string
  operationHint: "write" | "edit" | "delete"
}>
```

Write/Edit 返回目标 path。`executeTools` 在执行前经 FileSystemPort 读取存在文件作为 before，成功后读取 after，调用 Session 注入的 `recordEdit`。RuntimeRegistry 把 absolute path 归一为当前 materialized root 的 rootId + relativePath，再写 EditRecordStore。

- [ ] **Step 5: 增加 Artifact 事件**

成功记录后发出：

```ts
{
  type: "artifact_action",
  action: "openDiff",
  sessionId,
  workspaceId,
  rootId,
  relativePath,
  before,
  after,
}
```

Host 原样广播；UI 未实现专用 Diff 时继续显示通用工具卡，不能因此阻塞编辑。

- [ ] **Step 6: 跑测试**

Run: `pnpm vitest run packages/workspace/src/editRecordStore.test.ts packages/kernel/test/agent-loop-fixes.test.ts packages/host/src/index.test.ts`
Expected: PASS；测试明确注明 Bash 变更不产生逐文件 EditRecord。

- [ ] **Step 7: 提交**

```bash
git add packages/ports packages/kernel packages/workspace packages/host
git commit -m "feat(workspace): bind file edits and artifact actions to sessions"
```

### Task 9: 扩展通用 Chat Composer，不耦合仓库业务

**Files:**
- Modify: `packages/ui-chat/src/ChatView.tsx`
- Modify: `packages/ui-chat/src/ChatView.test.tsx`
- Modify: `packages/ui-chat/src/styles/chat.css`
- Modify: `packages/ui-chat/src/index.ts`

- [ ] **Step 1: 写组件失败测试**

覆盖 composerHeader 渲染位置、`canSubmit=false` 禁止 Enter/按钮发送、异步 `onBeforeSubmit` 完成后才调用 client、失败时保留输入、`onFirstSubmitted` 只在第一次成功发送后调用一次。

```tsx
render(
  <ChatView
    client={client}
    composerHeader={<div data-testid="workspace-composer">repo</div>}
    canSubmit={false}
  />,
)
expect(screen.getByTestId("workspace-composer")).toBeVisible()
expect(screen.getByTestId("send-button")).toBeDisabled()
```

- [ ] **Step 2: 确认红灯**

Run: `pnpm vitest run packages/ui-chat/src/ChatView.test.tsx`
Expected: 新用例 FAIL，props 未定义。

- [ ] **Step 3: 实现通用 props**

```ts
export interface ChatViewProps {
  client: IChatClient
  renderTool?: RenderTool
  placeholder?: string
  examplePrompts?: string[]
  composerHeader?: ReactNode
  canSubmit?: boolean
  onBeforeSubmit?: (text: string) => void | Promise<void>
  onFirstSubmitted?: () => void
}
```

`onBeforeSubmit` 失败时不清空 textarea；成功后再清空并 `send`。App Shell 在 `onBeforeSubmit` 中先把 Workspace 控件切成 locked；Host 随后的 `beforeFirstRun` 是权威锁。若发送失败，App Shell 调 `session.workspace` 判断 binding 是否已创建：已创建则保持 locked，未创建才恢复草稿。用 ref 保证 `onFirstSubmitted` 每次 ChatView 生命周期只调用一次。发送中的既有 Stop 行为不变。

- [ ] **Step 4: 跑 UI Chat 回归**

Run: `pnpm vitest run packages/ui-chat`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ui-chat
git commit -m "feat(ui-chat): add workspace-aware composer extension points"
```

### Task 10: 接入 Web 模式切换和服务器 Workspace

**Files:**
- Create: `apps/web/src/components/ModeSwitch.tsx`
- Create: `apps/web/src/components/WorkspaceComposer.tsx`
- Create: `apps/web/src/components/WorkspaceComposer.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/lib/rpc.ts`
- Modify: `apps/web/src/styles/shell.css`
- Modify: `apps/web/server/host.ts`
- Create: `apps/web/server/host.test.ts`
- Modify: `apps/web/package.json`

- [ ] **Step 1: 写 Web UI 失败测试**

覆盖默认 Chat、切 Code 后显示仓库选择、无有效 Workspace 时禁用发送、选择 direct 默认值、worktree 只对 Git 开启、首发后控件锁定、换仓提示新建会话、Sidebar 不变化。

- [ ] **Step 2: 写 Web Host 安全失败测试**

配置临时 `HELIOS_WORKSPACE_ROOTS`，断言 allowlist 内导入成功、外部路径/符号链接逃逸失败；非 localhost 且无 allowlist 时 capability 返回 `localImport:false`。

- [ ] **Step 3: 确认红灯**

Run: `pnpm vitest run apps/web`
Expected: 新 ModeSwitch/WorkspaceComposer 用例 FAIL。

- [ ] **Step 4: 实现 Web App 状态机**

使用以下显式状态，避免多个 boolean 产生非法组合：

```ts
type ComposerState =
  | { mode: "chat"; locked: boolean }
  | { mode: "code"; locked: false; workspaceId?: string; rootId?: string; strategy: "direct" | "worktree" }
  | { mode: "code"; locked: true; workspaceId: string; rootId: string; strategy: "direct" | "worktree" }
```

预选择改变时重连一个未持久化草稿 Session；服务端接受首发后转 locked。`wsUrlFor` 编码 launch DTO，但不编码绝对路径。恢复会话时以 `session.workspace` 回填并锁定。

- [ ] **Step 5: 替换 Web Host 启动**

`apps/web/server/host.ts` 构造 WorkspacePaths、Catalog、RepositoryService、Materializer、SessionCatalog、MemoryStore、EditRecordStore 和 RuntimeRegistry，然后调用 `serveWorkspaceHostOverWs`。`dataRoot` 来自 `HELIOS_DATA_ROOT`，缺省 `~/.helios`；允许根来自路径分隔的 `HELIOS_WORKSPACE_ROOTS`。

- [ ] **Step 6: 跑 Web 测试和手工冒烟**

Run: `pnpm vitest run apps/web && pnpm --filter @helios/web typecheck`
Expected: PASS。

Run: `HELIOS_DATA_ROOT=$(mktemp -d) HELIOS_WORKSPACE_ROOTS="$PWD" pnpm --filter @helios/web dev`
Expected: 页面默认 Chat；切换 Code 可选择当前仓库；发送后选择器锁定；刷新后恢复同一会话和仓库。

- [ ] **Step 7: 提交**

```bash
git add apps/web
git commit -m "feat(web): add chat and code workspace modes"
```

### Task 11: 接入 Electron 原生目录选择和 Workspace Host

**Files:**
- Create: `apps/electron/src/components/ModeSwitch.tsx`
- Create: `apps/electron/src/components/WorkspaceComposer.tsx`
- Create: `apps/electron/src/App.test.tsx`
- Create: `apps/electron/electron/directoryDialog.ts`
- Create: `apps/electron/electron/directoryDialog.test.ts`
- Modify: `apps/electron/src/App.tsx`
- Modify: `apps/electron/src/lib/rpc.ts`
- Modify: `apps/electron/src/electronRpc.ts`
- Modify: `apps/electron/src/global.d.ts`
- Modify: `apps/electron/electron/preload.ts`
- Modify: `apps/electron/electron/main.ts`
- Modify: `apps/electron/src/styles/shell.css`
- Modify: `apps/electron/package.json`
- Modify: `packages/host/src/electronIpc.test.ts`

- [ ] **Step 1: 写 preload 与 main 安全测试**

验证 Renderer 只能调用 `selectDirectory(): Promise<string | undefined>`；preload 不暴露 `ipcRenderer`；`directoryDialog.ts` 的取消路径返回 undefined；main 只调用固定的 `openDirectory` 配置且不允许 renderer 传 dialog properties。

- [ ] **Step 2: 写 Electron App 状态测试**

复用 Web 的产品行为断言，并额外验证“选择本地目录”调用 preload API 后只把返回值发给主进程 import RPC，Clone 使用主进程 Git 环境。

- [ ] **Step 3: 确认红灯**

Run: `pnpm vitest run apps/electron packages/host/src/electronIpc.test.ts`
Expected: 新用例 FAIL，目录 IPC 和 launch DTO 尚不存在。

- [ ] **Step 4: 实现最小 preload API**

```ts
contextBridge.exposeInMainWorld("heliosDesktop", {
  selectDirectory: () => ipcRenderer.invoke("helios:select-directory"),
})
```

主进程 handler 调用 `dialog.showOpenDialog(win, { properties: ["openDirectory"] })` 并只返回首个 filePath。窗口关闭时移除 handler。

- [ ] **Step 5: 构造 Electron Workspace Platform**

把当前固定 `REPO_ROOT` Kernel 替换为与 Web 同构的平台组件和 `serveWorkspaceHostOverElectronIpc`。`ElectronConnectRequest` 携带 resume 或 launch。Renderer 的状态机和锁定规则与 Web 一致，目录按钮为唯一端差异。

- [ ] **Step 6: 跑构建与手工冒烟**

Run: `pnpm vitest run apps/electron packages/host/src/electronIpc.test.ts && pnpm --filter @helios/electron typecheck && pnpm --filter @helios/electron build`
Expected: 测试、类型检查和 Vite/preload 构建全部成功。

Run: `HELIOS_DATA_ROOT=$(mktemp -d) pnpm --filter @helios/electron dev`
Expected: 原生目录选择可导入仓库；SSH Git Clone 使用系统 agent；direct 为默认；首发后锁定；Chat 文件位于临时 dataRoot。

- [ ] **Step 7: 提交**

```bash
git add apps/electron packages/host/src/electronIpc.test.ts
git commit -m "feat(electron): add native workspace selection for code mode"
```

### Task 12: 接入 CLI flags 和恢复约束

**Files:**
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/test/cli.e2e.test.ts`
- Modify: `apps/cli/package.json`

- [ ] **Step 1: 写 CLI E2E 失败测试**

覆盖：无 flags 创建 Chat Workspace；`--code .` direct；`--code <path> --worktree`；`--clone <ssh-or-https>`；`--workspace <id>`；`--resume` 恢复原 binding；`--resume` 与 `--code/--clone/--workspace` 同时出现返回 exit 2；Clone 失败返回 exit 1 且无 binding。

- [ ] **Step 2: 确认红灯**

Run: `pnpm vitest run apps/cli/test/cli.e2e.test.ts`
Expected: 新 flags 用例 FAIL。

- [ ] **Step 3: 实现参数解析和平台调用**

定义完整互斥规则：

```ts
interface CliOptions {
  message?: string
  resume?: string
  codePath?: string
  cloneUrl?: string
  workspaceId?: string
  worktree: boolean
}
```

无 code/clone/workspace/resume 为 Chat；三种 Code source 互斥；worktree 只能和 Code source 同用。CLI 不直接 `new Kernel(process.cwd())`，而是构造相同平台并调用 Registry。`--resume` 完全忽略当前 cwd，按 binding 解析。

- [ ] **Step 4: 跑 CLI E2E**

Run: `pnpm vitest run apps/cli/test/cli.e2e.test.ts && pnpm --filter @helios/cli typecheck`
Expected: PASS，错误用例断言稳定 exit code 和 stderr。

- [ ] **Step 5: 提交**

```bash
git add apps/cli
git commit -m "feat(cli): select and resume workspace-bound sessions"
```

### Task 13: 跨端验收、迁移验证和文档收尾

**Files:**
- Create: `packages/workspace/src/workspace.e2e.test.ts`
- Modify: `README.md`
- Modify: `docs/three-client-status.md`
- Modify: `docs/superpowers/specs/2026-08-12-code-mode-workspace-platform-design.md`（仅修正实施中确认的接口差异）

- [ ] **Step 1: 写跨端共享能力 E2E**

在进程内启动临时 WS Host，创建两个 Workspace 和三个 Session，验证：全局列表、恢复绑定、路径隔离、Chat 文件位置、Code direct 编辑、worktree 隔离、EditRecord 归属、旧 Session 迁移。

- [ ] **Step 2: 跑全量验证**

Run: `pnpm typecheck`
Expected: 所有 workspace package TypeScript 检查通过。

Run: `pnpm test`
Expected: Vitest 全量通过，无 unhandled rejection 和 open handle。

Run: `git diff --check`
Expected: 无 trailing whitespace、冲突标记或空白错误。

- [ ] **Step 3: 执行验收脚本**

使用临时 dataRoot 和临时 Git repo，依次验证 CLI Chat、CLI Code direct、CLI Code worktree、Web Host resume。检查以下事实：

```text
Chat 文件：<dataRoot>/managed-workspaces/<workspaceId>/root/
Session：<dataRoot>/sessions/<sessionId>/
Clone：<dataRoot>/repositories/<repositoryId>/source/
Worktree：<dataRoot>/worktrees/<workspaceId>/<rootId>/
Memory：<dataRoot>/workspace-memory/<workspaceId>/
```

Expected: 每个目录与 Catalog/binding 一致，原仓库只在 direct 用例被修改，worktree 用例不修改原仓库工作树。

- [ ] **Step 4: 更新用户文档**

README 写明三端入口、环境变量、direct 风险、SSH Git 凭据来源、Web 本地目录语义和数据位置。`three-client-status.md` 将 Code 模式标为已支持，并明确 Bash 编辑审计限制与后续文档链接。

- [ ] **Step 5: 最终提交**

```bash
git add packages/workspace/src/workspace.e2e.test.ts README.md docs
git commit -m "docs: document code mode workspace workflows"
```

## 4. 风险与缓解

| 风险 | 影响 | 缓解方式 | 验证证据 |
|---|---|---|---|
| direct 误改用户原仓库 | 数据损失 | 默认值虽为 direct，但 UI 明示真实修改；依赖现有 checkpoint/rollback；不自动清理 | Electron/Web/CLI direct E2E 只修改指定 repo |
| 路径穿越或符号链接逃逸 | 读取服务器/其他 Workspace 文件 | realpath + allowlist + WorkDirGuard；客户端不传可信物化路径 | RepositoryService、Web Host、fs-node 安全测试 |
| Session 恢复到错误 cwd | 在错误仓库执行工具 | resume 必须先读 binding；找不到 root 直接报错，禁止 cwd fallback | RuntimeRegistry resume 测试 |
| Session Catalog 迁移丢历史 | 历史不可恢复 | 新旧双读、只复制 Session 记录、不移动代码；迁移前保留旧目录 | legacy resume/migration 测试 |
| SSH/HTTPS 凭据泄漏 | 安全事件 | 继承宿主 credential helper/agent；不持久化 token/私钥；日志清洗 URL userinfo | Clone error 测试与日志断言 |
| Clone/Worktree 并发竞态 | 半目录、错误归属 | 临时目录 + rename；workspace/root 锁；已存在目录用 Git porcelain 验证 | 并发 materializer 测试 |
| Kernel 缓存泄漏 | 内存、hook 或 listener 累积 | Registry 引用计数；连接 close 调 release；缓存 key 含物化和 manifest 签名 | Host disconnect 测试和 open-handle 检查 |
| 首发与 UI 锁定竞态 | 同一 Session 绑定两个仓库 | binding 使用 exclusive create；UI 锁定只是体验，服务端 create-once 才是权威 | 双首发冲突测试 |
| Web “本地”概念误导 | 用户以为可选浏览器电脑文件 | 文案标注 Host 目录；远程/无 allowlist 时隐藏入口；Clone 始终可用 | Web capability/UI 测试 |
| Bash 修改未进入 EditRecord | 审计不完整 | 明确首期只保证 Write/Edit；Diff/checkpoint 仍反映结果；不把日志作为安全边界 | Bash 限制测试和文档 |
| before/after 体积过大 | Session Store 膨胀 | 首期设明确单记录字节上限并报告审计不完整；后续改 blob/hash | EditRecord 大文件测试 |
| Electron preload 权限扩大 | Renderer 获得 Node 能力 | 仅暴露无参数 `selectDirectory`；contextIsolation/sandbox 保持开启 | preload API 测试、构建检查 |
| Electron/Web UI 漂移 | 行为不一致 | 共享 DTO、相同状态联合类型和验收用例；稳定后再抽 ui-shell | 两端状态测试矩阵 |
| worktree 磁盘残留 | 磁盘增长 | 首期不自动删除，展示物化位置；生命周期管理列入后续 | 退出后 worktree 仍可恢复的测试 |

## 5. 验收标准

### 功能

- [ ] Web/Electron 首屏默认 Chat；切 Code 后 Sidebar 不变、输入区出现仓库选择器。
- [ ] 三端 Chat 都创建独立 managed Workspace，文件不写入 Helios 仓库。
- [ ] Electron、CLI、本地 Web Host 能导入本地目录；三端 Host 都能执行 HTTPS/SSH Git Clone。
- [ ] direct 为默认；Git root 可选 worktree；非 Git root 无法选择 worktree。
- [ ] 首条消息后，前端禁用选择器，后端拒绝不同 binding；新会话可换仓库。
- [ ] Session 列表跨 Workspace 展示；resume 回到原 Workspace 和物化方式。
- [ ] Write/Edit 产生 sessionId、workspaceId、rootId、relativePath、toolUseId、before/after。
- [ ] Artifact action 带稳定路径身份；未实现专用预览的消费方仍能完成会话。
- [ ] Workspace Memory 只在同 workspaceId 的 Session 间共享，其他 Session 全文不被读取。

### 安全与兼容

- [ ] Workspace A 的工具不能读写 Workspace B 或 allowlist 外路径，包括符号链接逃逸。
- [ ] Clone 不接受任意目标目录，不把凭据写入 Catalog/Session/日志。
- [ ] 旧 `serveKernelOverWs/ElectronIpc` 用例继续通过。
- [ ] 旧 `<workDir>/.helios/sessions` 会话可恢复并迁移，新会话不再写入代码仓库。
- [ ] Web 远程 Host 未配置 allowlist 时不暴露本地目录浏览。
- [ ] Electron sandbox/contextIsolation 保持开启，Renderer 无 Node 全量能力。

### 工程质量

- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm test` 通过。
- [ ] `git diff --check` 通过。
- [ ] 无未处理 Promise、测试 open handle 或 Session listener 泄漏。
- [ ] 文档明确 direct 风险、数据位置、Web 本地语义和 Bash 审计限制。

## 6. 发布策略

1. 先合并 Tasks 1-8，平台能力和兼容 Host 保持 UI 不变。
2. 用 feature flag `HELIOS_CODE_MODE=1` 灰度 Web/Electron；CLI flags 可同时开放。
3. 观察 Clone 失败率、Runtime 创建耗时、resume 失败、Catalog 损坏和 EditRecord 失败计数。
4. 灰度稳定后默认展示 Code 切换；旧固定 Kernel serve API 至少保留一个发布周期。
5. 多仓、云端和跨 Sandbox 工作只从 `docs/code-mode-workspace-platform-follow-ups.md` 单独立项，不扩入本计划。
