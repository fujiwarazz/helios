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
- `packages/workspace/src/legacySessionMigrator.ts`：从显式 legacy root 合成 Workspace/binding 并原子迁移。
- `packages/workspace/src/memoryStore.ts`：Workspace 提炼记忆文件 Store。
- `packages/workspace/src/editRecordStore.ts`：Session 编辑 JSONL Store。
- `packages/workspace/src/mutationCoordinator.ts`：root 级变更串行、revision/fingerprint 审计。
- `packages/workspace/src/workspaceFingerprint.ts`：检测 direct root 的 Helios/外部修改。
- `packages/workspace/src/dataRootLease.ts`：首期单 Host 独占 dataRoot。
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
- `packages/kernel/src/pluginLoader.ts`：收集并释放可 Disposable 的插件实例。
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
- `pnpm-lock.yaml`：记录新增 workspace 依赖图。

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
    | { type: "git"; remoteIdentity: string; repositoryId: string }
  git?: { defaultBranch?: string }
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
  materializationId: string
  branch?: string
  revision?: string
}

export interface WorkspaceRootSelection {
  rootId: string
  strategy: MaterializationStrategy
  branch?: string
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
  roots?: WorkspaceRootSelection[]
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

export interface SessionRecord {
  schemaVersion: 1
  meta: { id: string; title: string; createdAt: number; updatedAt: number }
  binding: SessionWorkspaceBinding
  state: "starting" | "running" | "idle" | "interrupted"
  auditStatus: "complete" | "incomplete"
  auditGaps: Array<{ toolUseId?: string; reason: string; createdAt: number }>
}
```

所有 JSON envelope 和 JSONL row 从首版带 `schemaVersion: 1`，读取时做运行时校验。`WorkspacePaths` 用 `resolve(dataRoot)` 固定根，并用 `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/` 校验每个 ID；worktree 路径为 `<workspaceId>/<materializationId>/<rootId>`，锁也以其真实绝对路径为 key。`package.json` 同时导出 `"./types": "./src/types.ts"`，且该文件只能包含类型，供浏览器 type-only import。

- [ ] **Step 4: 运行包测试和类型检查**

Run: `pnpm install && pnpm vitest run packages/workspace/src/paths.test.ts && pnpm --filter @helios/workspace typecheck`
Expected: pnpm-lock.yaml 已更新、新 workspace 依赖 symlink 已创建、测试 PASS、TypeScript 无错误。后续 Task 每次修改 package dependency 后都重新运行 `pnpm install` 并 stage pnpm-lock.yaml；若 Vite/Vitest 无法解析 subpath export，再在对应 app 配置中增加显式 alias 并测试，不能只假设 workspace 自动解析。

- [ ] **Step 5: 提交**

```bash
git add packages/workspace pnpm-lock.yaml
git commit -m "feat(workspace): add workspace domain model and paths"
```

### Task 2: 实现 Workspace Catalog 和托管 Chat Workspace

**Files:**
- Create: `packages/workspace/src/catalog.ts`
- Create: `packages/workspace/src/catalog.test.ts`
- Modify: `packages/workspace/src/index.ts`

- [ ] **Step 1: 写 Catalog 失败测试**

测试使用 `mkdtemp`，覆盖 `createManagedChat` 创建真实 root、`get/list` round-trip、schemaVersion 校验/迁移、损坏 JSON 返回带文件名的错误、相同 ID 的并发写不产生半文件。

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

Catalog 文件使用 `{ schemaVersion: 1, workspace }` envelope。`put` 先写同目录的 `<id>.json.tmp-<pid>-<nonce>`，fsync 文件后再 `rename`；`createManagedChat` 先 `mkdir(root, {recursive:true})` 再写 Catalog。`list` 只读取 `.json`，按 `updatedAt` 倒序；未知 schemaVersion 返回 `UnsupportedSchemaVersionError`。

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

覆盖：本地目录经 realpath 归一；allowlist 外拒绝；Git 目录识别 repo root/default branch；非 Git 目录可 direct；无 userinfo 的 HTTPS/SSH URL 都以参数数组传给 Git；`https://token@host/repo.git` 被拒绝；Catalog、Session 和日志只出现脱敏 remoteIdentity；Clone 使用临时目录并在成功后 rename；取消/超时/SSH host-key 失败会终止子进程且不留下正式 Catalog 记录。

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
  run(args: string[], options?: {
    cwd?: string
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<{ stdout: string; stderr: string }>
}

export interface RepositoryService {
  importLocalDirectory(path: string, name?: string): Promise<Workspace>
  cloneRepository(remoteUrl: string, options?: {
    name?: string
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<Workspace>
  inspectGit(path: string): Promise<{ repoRoot: string; defaultBranch?: string } | undefined>
}
```

生产 GitRunner 使用 `execa("git", args, { shell: false, reject: true, cancelSignal: signal, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })`，取消/超时时清理子进程树。HTTPS URL 拒绝全部 userinfo；`ssh://git@host/path` 允许 username 但拒绝 password；继续支持 Git scp-like `user@host:path`。持久化前规范化为无密码 remoteIdentity。目标由 `WorkspacePaths.repositorySource(repositoryId)` 生成，禁止调用方提供。目录 allowlist 比较前对候选和允许根均 `realpath`。

- [ ] **Step 4: 跑测试和真实 Git 冒烟测试**

Run: `pnpm vitest run packages/workspace/src/repositoryService.test.ts`
Expected: PASS。

Run: `pnpm vitest run packages/workspace/src/repositoryService.test.ts -t "imports a real local git repository"`
Expected: PASS；测试自身使用 `mkdtemp`/`afterEach(rm)` 管理临时 repo，不由外层 shell 遗留目录。

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

覆盖：managed/local/clone 的 direct 返回正确路径；worktree 对非 Git root 拒绝；默认分支缺失时使用当前 HEAD；相同 materializationId 并发调用只创建一次；不同 Session/branch 使用不同物理路径和锁；已存在路径必须同时匹配 repo、branch、HEAD、materializationId；结果始终包含 rootId；首期多个 roots 返回明确 `single-root` 错误而不是静默忽略。

```ts
const result = await materializer.materialize(workspace, {
  sessionId: "sess_1",
  mode: "code",
  workspaceId: workspace.id,
  roots: [{
    rootId: workspace.roots[0]!.id,
    strategy: "direct",
    materializationId: `direct-${workspace.roots[0]!.id}`,
  }],
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

direct 返回 source 的 realpath，materializationId 为 root 派生稳定值。worktree 的 materializationId 在创建 Session 时生成，首期默认包含 sessionId；路径为 `<dataRoot>/worktrees/<workspaceId>/<materializationId>/<rootId>`。`git worktree add <generated-path> <branch-or-HEAD>` 按真实绝对路径使用进程内 Promise lock；路径已存在时用 `git worktree list --porcelain` 和 HEAD 校验 repo、branch、revision、binding identity，任一不符即报错。不要自动删除已提交 Session 引用的 worktree。

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
- Create: `packages/workspace/src/legacySessionMigrator.ts`
- Create: `packages/workspace/src/legacySessionMigrator.test.ts`
- Modify: `packages/kernel/src/session.ts`
- Modify: `packages/kernel/src/agentLoop/types.ts`
- Modify: `packages/kernel/src/kernel.ts`
- Modify: `packages/kernel/test/resume.test.ts`
- Modify: `packages/kernel/test/list-sessions-ports.test.ts`
- Modify: `packages/workspace/src/index.ts`

- [ ] **Step 1: 为 Kernel 写失败测试**

新增用例：`workDir=/repo`、`sessionDataRoot=/state/sessions` 时 turn/kernel meta 只出现在 `/state/sessions/<id>`；resume 能恢复；不传新参数仍读取旧 `<workDir>/.helios/sessions`，保持低层 API 兼容。另做故障注入：首发 record 创建前崩溃时 Session 不存在；record 原子创建后、首个 turn 前崩溃时 Session 以 interrupted 可见；不得出现只有 binding 没有 meta 的状态。

```ts
const kernel = new Kernel({ workDir, sessionDataRoot, manifest })
await kernel.start()
const session = kernel.createSession({ askQuestion })
await session.sendMessage("hello")
await expect(readFile(join(sessionDataRoot, session.id, "kernel-meta.json"), "utf8")).resolves.toContain(session.id)
await expect(access(join(workDir, ".helios", "sessions", session.id))).rejects.toBeDefined()
```

- [ ] **Step 2: 确认 Kernel 测试失败**

Run: `pnpm vitest run packages/kernel/test/resume.test.ts packages/kernel/test/list-sessions-ports.test.ts`
Expected: FAIL，`sessionDataRoot` 尚未进入 KernelOptions。

- [ ] **Step 3: 修改 Kernel/Session 持久化边界**

在 `KernelOptions` 增加 `sessionDataRoot?: string`。SessionOptions 接收 `sessionDir: string`，`turnsDir()` 直接返回该值；Kernel 自有状态改名为 `kernel-meta.json`。默认数据根仍为 `join(workDir, ".helios", "sessions")` 以兼容现有嵌入方。给 `CreateSessionOptions` 增加 `beforeFirstRun?: (text: string) => Promise<void>`、`onRunStateChange?: (state: "running" | "idle" | "interrupted") => Promise<void>`；`Session.sendMessage()` 在追加用户消息和执行任何工具前只调用一次 beforeFirstRun，失败则本次 run 不开始。整个多-turn run 在 try/catch/finally 中保持 running，全部 turn 与 agent_end 持久化后才 idle；异常/dispose 中断为 interrupted；完整落盘的用户取消可 idle。Runtime Registry 用 beforeFirstRun 原子创建包含 meta+binding+状态的 SessionRecord，而不是分别写两个文件。

```ts
export interface KernelSessionMeta {
  schemaVersion: 1
  id: string
  title: string
  createdAt: number
  updatedAt: number
  lastRunIndex: number
  lastTurnIndex: number
}
```

`TurnRecord` 和持久化 compaction row 同样增加 `schemaVersion: 1`；读取缺少该字段的现有行时按 legacy v0 校验并转换，未知非 1 版本拒绝。测试覆盖多-turn run 状态转换、异常/取消/dispose、turn/compaction v0 迁移和 runIndex 连续性。

Kernel 产品路径不负责全局 list；保留的 `listSessions()` 扫描其 `sessionDataRoot` 和 `kernel-meta.json`，只作为兼容 API。

- [ ] **Step 4: 实现 SessionCatalog 与 binding create-once**

```ts
export interface SessionCatalog {
  list(): Promise<SessionRecord[]>
  get(sessionId: string): Promise<SessionRecord | undefined>
  create(record: SessionRecord): Promise<void>
  updateState(sessionId: string, state: SessionRecord["state"]): Promise<void>
  appendAuditGap(sessionId: string, gap: SessionRecord["auditGaps"][number]): Promise<void>
  reconcileInterrupted(): Promise<number>
}
```

`create` 将 `{schemaVersion, meta, binding, state:"starting", auditStatus, auditGaps}` 写入临时文件、fsync、再用 exclusive rename/link 语义提交为唯一 `session.json`；文件存在时只有 binding 完全相同才幂等成功，否则抛 `SessionBindingConflictError`。`updateState` 采用 temp+rename。启动时 `reconcileInterrupted()` 将遗留 starting/running 改为 interrupted，并设置 auditStatus=incomplete、追加 ungraceful-shutdown gap。

实现 `LegacySessionMigrator`：Electron/Web 注入旧固定 REPO_ROOT；CLI 注入当前 cwd 或 `--legacy-workdir`。只检查显式 roots，命中多个返回 `AmbiguousLegacySessionError`。命中一个时先导入该 workDir 为 local-directory Workspace，生成 code/direct binding；校验旧 `meta.json` 并转换为带版本的 `kernel-meta.json`，将 turns/compactions v0 转为 v1 后写入全局临时目录，最后原子提交 `session.json`。保留旧目录且重复迁移幂等；测试恢复后的 title/createdAt 和下一 runIndex/turnIndex 连续。

- [ ] **Step 5: 跑迁移和兼容测试**

Run: `pnpm vitest run packages/kernel/test/resume.test.ts packages/kernel/test/list-sessions-ports.test.ts packages/workspace/src/sessionCatalog.test.ts packages/workspace/src/legacySessionMigrator.test.ts`
Expected: PASS；测试证明新数据不进入 repo、各崩溃边界可恢复、旧数据能合成 Workspace/binding、歧义会报错、冲突 SessionRecord 被拒绝。

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
- Create: `packages/workspace/src/dataRootLease.ts`
- Create: `packages/workspace/src/dataRootLease.test.ts`
- Modify: `packages/memory-fs/src/index.ts`
- Modify: `packages/memory-fs/src/index.test.ts`
- Modify: `packages/memory-fs/package.json`
- Modify: `packages/fs-node/src/index.ts`
- Modify: `packages/fs-node/src/index.test.ts`
- Modify: `packages/kernel/src/pluginLoader.ts`
- Modify: `packages/kernel/src/kernel.ts`
- Modify: `packages/kernel/test/kernel.test.ts`
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

覆盖新 Chat 自动 Workspace、Code binding 解析、resume 先读 SessionRecord、相同 runtime key 复用 Kernel、最后一个引用 release 后异步释放插件资源、缺失本地路径返回结构化错误且绝不使用 `process.cwd()`。覆盖草稿租约：空草稿断连后过期，scavenger 只删除无 SessionRecord 引用的 managed root/runtime；已首发草稿和已提交 worktree 永不被误删。`LocalDataRootLease` 使用 `proper-lockfile` 独占 dataRoot，第二个进程/实例得到明确错误，dispose 后可重新获取。

- [ ] **Step 3: 确认红灯**

Run: `pnpm vitest run packages/workspace/src/memoryStore.test.ts packages/workspace/src/runtimeRegistry.test.ts`
Expected: FAIL，两个实现尚不存在。

- [ ] **Step 4: 实现 MemoryStore 和 memory-fs storageDir**

`WorkspaceMemoryStore` 只允许 workspaceId 生成目录；主题 key 使用与 ID 等价的安全字符集。`@helios/fs-node` 导出 `createGuardedFileSystem(root)`；`@helios/memory-fs` 支持受信 manifest option `storageDir`，传入时以该目录构造一套独立 WorkDirGuard，而不是复用代码 Workspace 的 FileSystemPort；不传时保留当前 `.helios/memory` 行为。Runtime Registry 只用 `WorkspacePaths.memoryDir(workspaceId)` 覆写 MemoryPort entry，任意客户端路径不得进入该 option。

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
  release(runtimeId: string): Promise<void>
  scavengeExpiredDrafts(now?: number): Promise<number>
}
```

`createSession` 先生成 sessionId，再生成 worktree materializationId 并物化。Chat 无 workspaceId 时调用 `createManagedChat`；Code 必须携带 Catalog 中存在的 workspaceId。Registry 只在内存中持有带 `expiresAt` 的草稿 binding，并把 `sessionCatalog.create(SessionRecord)` 注入 Session 的 `beforeFirstRun(text)`；空草稿断开时不进入会话列表，客户端也不保存其 sessionId。runtime key 由 workspaceId、root binding、materialized paths、manifest hash 组成；Kernel 的 `workDir` 是 primaryDir，`sessionDataRoot` 是全局 sessions 根。

`pluginLoader` 收集实现了 `{ dispose(): void | Promise<void> }` 的 Port/Capability；新增幂等 `Kernel.dispose()`，最后一个 runtime 引用释放时按逆加载顺序 await dispose。草稿 scavenger 先查 SessionCatalog 引用：无记录时删除 managed root，并用 `git worktree remove --force` 清理由该草稿 materializationId 创建的 worktree；一旦存在 SessionRecord 就绝不自动删除。

平台 Host 启动第一步 `await LocalDataRootLease.acquire(dataRoot)`，底层使用 `proper-lockfile` 的 stale/heartbeat 机制；关闭时最后释放。首期拒绝两个 Electron/Web/CLI Host 共用同一 dataRoot，错误文案提示设置不同 `HELIOS_DATA_ROOT`。这使进程内 root Promise lease 在首期具备跨消费方安全前提。

- [ ] **Step 6: 跑测试**

Run: `pnpm install && pnpm vitest run packages/fs-node/src/index.test.ts packages/memory-fs/src/index.test.ts packages/kernel/test/kernel.test.ts packages/workspace/src/dataRootLease.test.ts packages/workspace/src/memoryStore.test.ts packages/workspace/src/runtimeRegistry.test.ts`
Expected: PASS；resume 使用原 binding 路径，Memory 不能逃出 dataRoot，最后 release 关闭资源，scavenger 不删除已提交 Workspace。

- [ ] **Step 7: 提交**

```bash
git add packages/workspace packages/memory-fs packages/fs-node packages/kernel pnpm-lock.yaml
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

从 `@helios/workspace/types` type-only 导入 `SessionLaunchRequest`、`WorkspaceRootSelection`、`WorkspaceSummary`、`CloneWorkspaceRequest`、`ImportLocalWorkspaceRequest`。`packages/workspace/package.json` 为 `./types` 提供无副作用 subpath export。launch 只允许 rootId/strategy/branch，不包含 materializationId、runtimeId、`primaryDir`、`additionalDirs` 或绝对路径；`@helios/protocol` 保持通用传输层，不依赖 Workspace 领域。

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
- Create: `packages/workspace/src/mutationCoordinator.ts`
- Create: `packages/workspace/src/mutationCoordinator.test.ts`
- Create: `packages/workspace/src/workspaceFingerprint.ts`
- Create: `packages/workspace/src/workspaceFingerprint.test.ts`
- Modify: `packages/ports/src/types.ts`
- Modify: `packages/kernel/src/builtin/tools.ts`
- Modify: `packages/kernel/src/agentLoop/executeTools.ts`
- Modify: `packages/kernel/src/agentLoop/runTurnLoop.ts`
- Modify: `packages/kernel/src/agentLoop/types.ts`
- Modify: `packages/kernel/src/events.ts`
- Modify: `packages/kernel/src/kernel.ts`
- Modify: `packages/kernel/src/session.ts`
- Modify: `packages/kernel/test/agent-loop-fixes.test.ts`
- Modify: `packages/kernel/test/kernel.test.ts`
- Modify: `packages/workspace/src/runtimeRegistry.ts`

- [ ] **Step 1: 写 EditRecord Store 测试**

验证 append/list、schemaVersion、损坏 JSONL 单行跳过并告警、路径只接受 rootId + 安全相对路径、大文件记录上限返回明确错误而不是截断成伪完整记录。另测 MutationCoordinator：direct root 的整个 Agent run 串行；持久化 journal 的 revision 记录 session/run owner 和 before/after fingerprint；IDE/Git/外部进程修改会体现在 fingerprint 告警。明确测试 Workspace Platform Session 的 rollback 只移动消息 HEAD，从不调用 CheckpointPort.restore；旧 Kernel 兼容路径继续通过原有文件 restore 测试。

- [ ] **Step 2: 写 Kernel 工具归因失败测试**

用 mock FileSystemPort 执行 Write/Edit，断言 observer 收到同一 toolUseId、operation、before/after；失败 Edit 不记录；Read 不记录；observer 失败时工具成功结果不被改成失败，但 SessionCatalog 必须持久化 auditStatus=incomplete/auditGap 并广播 warning。

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

Run: `pnpm vitest run packages/workspace/src/editRecordStore.test.ts packages/workspace/src/workspaceFingerprint.test.ts packages/workspace/src/mutationCoordinator.test.ts packages/kernel/test/agent-loop-fixes.test.ts`
Expected: 新用例 FAIL，Tool 尚无 mutation metadata。

- [ ] **Step 4: 增加 Tool mutation 契约并实现记录**

在 `Tool` 增加：

```ts
fileMutations?: (input: unknown) => Array<{
  path: string
  operationHint: "write" | "edit" | "delete"
}>
```

在 `CreateSessionOptions -> SessionOptions -> RunLoopDeps` 明确传递 `recordEdit`、`markAuditGap` 和 `mutationCoordinator`，不得使用模块全局变量。Write/Edit 返回目标 path。`executeTools` 在执行前经 FileSystemPort 读取存在文件作为 before，成功后读取 after，调用 recordEdit。RuntimeRegistry 把 absolute path 归一为当前 materialized root 的 rootId + relativePath，再写 EditRecordStore；记录失败调用 SessionCatalog.appendAuditGap 并发事件。

direct 模式在 `Session.sendMessage` 进入 checkpoint 之前获取 root mutation lease，直到全部 turn/agent_end/SessionRecord 状态持久化后释放；首期即使最终只读也保守串行。journal 位于 `workspace-state/<workspaceId>/<materializationId>/mutations.jsonl`，每行 `{schemaVersion:1, revision, sessionId, runId, beforeFingerprint, afterFingerprint, createdAt}`。Git fingerprint 覆盖 HEAD/index/tracked/ignored/untracked 内容 hash；非 Git 使用排除 `.git/.helios/node_modules` 的 Merkle hash。

给 CreateSessionOptions 增加 `rollbackPolicy?: "full" | "conversation-only"`，默认 full 以兼容旧低层入口；RuntimeRegistry 创建的 Session 一律传 conversation-only。该模式的 `Session.rollback` 只移动 HEAD 和重写会话状态，不调用 CheckpointPort.restore。Host 返回 rollback capability，UI 固定显示“回退对话，不修改文件”；首期不提供绕过开关。

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

Run: `pnpm vitest run packages/workspace/src/editRecordStore.test.ts packages/workspace/src/workspaceFingerprint.test.ts packages/workspace/src/mutationCoordinator.test.ts packages/kernel/test/agent-loop-fixes.test.ts packages/kernel/test/kernel.test.ts packages/host/src/index.test.ts`
Expected: PASS；Bash 不产生逐文件 EditRecord，但整个 run 被串行并推进 journal；Workspace Platform rollback 永不覆盖文件；审计失败可在恢复后看到；重启后 journal revision 连续。

- [ ] **Step 7: 提交**

```bash
git add packages/ports packages/kernel packages/workspace packages/host
git commit -m "feat(workspace): bind file edits and artifact actions to sessions"
```

### Task 9: 扩展通用 Chat Composer，不耦合仓库业务

**Files:**
- Modify: `packages/ui-chat/src/ChatView.tsx`
- Modify: `packages/ui-chat/src/ChatView.test.tsx`
- Modify: `packages/ui-chat/src/types.ts`
- Modify: `packages/ui-chat/src/useChat.ts`
- Modify: `packages/ui-chat/src/RpcChatClient.ts`
- Modify: `packages/ui-chat/src/styles/chat.css`
- Modify: `packages/ui-chat/src/index.ts`

- [ ] **Step 1: 写组件失败测试**

覆盖 composerHeader 渲染位置、`canSubmit=false` 禁止 Enter/按钮发送、异步 `onBeforeSubmit` 完成后才调用 client、失败时保留输入、`onFirstSubmitted` 只在第一次成功发送后调用一次。增加 rollbackMode：conversation-only 显示“回退对话，不修改文件”且 RPC 不请求 restore；full 保持旧兼容文案/行为。

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
  rollbackMode?: "full" | "conversation-only"
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

配置临时 `HELIOS_WORKSPACE_ROOTS`，断言 allowlist 内导入成功、外部路径/符号链接逃逸失败。断言 Host 默认绑定 `127.0.0.1`，`HELIOS_WEB_HOST=0.0.0.0` 或其他非 loopback 地址会在监听前失败；这使首期不需要假装已有远程鉴权。

- [ ] **Step 3: 确认红灯**

Run: `pnpm vitest run apps/web`
Expected: 新 ModeSwitch/WorkspaceComposer 用例 FAIL。

- [ ] **Step 4: 实现 Web App 状态机**

读取 `host.capabilities` 中的 `codeMode`；其值由 Host 的 `HELIOS_CODE_MODE=1` 产生。flag 关闭时不渲染 ModeSwitch、不开放 import/clone RPC，保持 Chat；开启时使用以下显式状态，避免多个 boolean 产生非法组合：

```ts
type ComposerState =
  | { mode: "chat"; locked: boolean }
  | { mode: "code"; locked: false; workspaceId?: string; rootId?: string; strategy: "direct" | "worktree" }
  | { mode: "code"; locked: true; workspaceId: string; rootId: string; strategy: "direct" | "worktree" }
```

预选择改变时重连一个未持久化草稿 Session；服务端接受首发后转 locked。`wsUrlFor` 编码 launch DTO，但不编码绝对路径。恢复会话时以 `session.workspace` 回填并锁定。

- [ ] **Step 5: 替换 Web Host 启动**

`apps/web/server/host.ts` 先获取 LocalDataRootLease，再构造 WorkspacePaths、Catalog、RepositoryService、Materializer、SessionCatalog、MemoryStore、EditRecordStore 和 RuntimeRegistry，然后调用 `serveWorkspaceHostOverWs`；shutdown 最后释放 lease。`dataRoot` 来自 `HELIOS_DATA_ROOT`，缺省 `~/.helios`；允许根来自路径分隔的 `HELIOS_WORKSPACE_ROOTS`；host 缺省 `127.0.0.1` 且只接受 loopback。`HELIOS_CODE_MODE` 同时控制 capability 和 Workspace mutation RPC，避免只隐藏 UI。

- [ ] **Step 6: 跑 Web 测试和手工冒烟**

Run: `pnpm vitest run apps/web && pnpm --filter @helios/web typecheck`
Expected: PASS。

Run: `HELIOS_CODE_MODE=1 HELIOS_DATA_ROOT=$(mktemp -d) HELIOS_WORKSPACE_ROOTS="$PWD" pnpm --filter @helios/web dev`
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

验证 Renderer 只能调用 `selectAndImportDirectory(): Promise<WorkspaceSummary | undefined>`；preload 不暴露 `ipcRenderer` 或真实 filePath；`directoryDialog.ts` 的取消路径返回 undefined；main 只调用固定的 `openDirectory` 配置，拿到路径后在主进程直接调用 RepositoryService。直接调用通用 RPC 伪造 `/etc` 等未授权路径必须被拒绝。

- [ ] **Step 2: 写 Electron App 状态测试**

复用 Web 的产品行为断言，并额外验证“选择本地目录”调用 preload API 后只收到 WorkspaceSummary，Clone 使用主进程 Git 环境。`HELIOS_CODE_MODE` 关闭时 ModeSwitch 和 Workspace mutation API 均不可用。

- [ ] **Step 3: 确认红灯**

Run: `pnpm vitest run apps/electron packages/host/src/electronIpc.test.ts`
Expected: 新用例 FAIL，目录 IPC 和 launch DTO 尚不存在。

- [ ] **Step 4: 实现最小 preload API**

```ts
contextBridge.exposeInMainWorld("heliosDesktop", {
  selectAndImportDirectory: () => ipcRenderer.invoke("helios:select-and-import-directory"),
})
```

主进程 handler 调用 `dialog.showOpenDialog(win, { properties: ["openDirectory"] })`，将首个 filePath 直接交给主进程 RepositoryService，最后只返回 WorkspaceSummary。Renderer 到 Host 的 `workspaces.importLocal` 在 Electron adapter 中不注册；窗口关闭时移除 handler。

- [ ] **Step 5: 构造 Electron Workspace Platform**

主进程先获取 LocalDataRootLease，再把当前固定 `REPO_ROOT` Kernel 替换为与 Web 同构的平台组件和 `serveWorkspaceHostOverElectronIpc`；app 退出时最后释放 lease。`ElectronConnectRequest` 携带 resume 或 launch。Renderer 的状态机和锁定规则与 Web 一致，目录授权在主进程闭环。主进程读取 `HELIOS_CODE_MODE` 并通过 `host.capabilities` 返回，关闭时不注册 Clone/import mutation handler。

- [ ] **Step 6: 跑构建与手工冒烟**

Run: `pnpm vitest run apps/electron packages/host/src/electronIpc.test.ts && pnpm --filter @helios/electron typecheck && pnpm --filter @helios/electron build`
Expected: 测试、类型检查和 Vite/preload 构建全部成功。

Run: `HELIOS_CODE_MODE=1 HELIOS_DATA_ROOT=$(mktemp -d) pnpm --filter @helios/electron dev`
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

覆盖：无 flags 创建 Chat Workspace；`--code .` direct；`--code <path> --worktree`；`--clone <ssh-or-https>`；`--workspace <id>`；`--resume` 恢复原 binding；`--resume --legacy-workdir <path>` 迁移旧会话；`--resume` 与 `--code/--clone/--workspace` 同时出现返回 exit 2；Clone 失败/超时/Ctrl+C 返回 exit 1 且无 SessionRecord。

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
  legacyWorkDir?: string
  worktree: boolean
}
```

无 code/clone/workspace/resume 为 Chat；三种 Code source 互斥；worktree 只能和 Code source 同用；legacyWorkDir 只能与 resume 同用。CLI 先获取 LocalDataRootLease，不直接 `new Kernel(process.cwd())`，而是构造相同平台并调用 Registry，退出时释放 lease。全局 SessionRecord 存在时 `--resume` 完全忽略当前 cwd；不存在时 Legacy Locator 只检查 `--legacy-workdir` 或当前 cwd。SIGINT 触发 AbortController，取消 Git/Agent 子进程后退出。

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

在进程内启动临时 loopback WS Host，创建两个 Workspace 和三个 Session，验证：全局列表、恢复绑定、路径隔离、Chat 文件位置、Code direct 编辑、按 materializationId 的 worktree 隔离、EditRecord/审计状态归属、旧 Session 迁移、首发崩溃 reconciliation、草稿 scavenger、最后引用释放。增加两个 direct Session 交错运行：整个 run 串行；IDE 模拟进程直接改文件后产生 fingerprint 告警。对 Workspace Platform 执行 rollback 时只移动对话 HEAD，文件内容保持不变。第二个 Host 使用同一 dataRoot 时启动失败。

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
Worktree：<dataRoot>/worktrees/<workspaceId>/<materializationId>/<rootId>/
Memory：<dataRoot>/workspace-memory/<workspaceId>/
```

Expected: 每个目录与 Catalog/binding 一致，原仓库只在 direct 用例被修改，worktree 用例不修改原仓库工作树；SessionRecord/JSONL 都有 schemaVersion；Catalog/Session/日志不含测试 token；非 loopback Web 启动失败；Electron 伪造路径失败。

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
| direct 误改或回退覆盖原仓库 | 数据损失 | UI 明示真实修改；整个 run 串行；平台 rollback 固定 conversation-only | direct E2E、回退后文件不变测试 |
| 路径穿越或符号链接逃逸 | 读取服务器/其他 Workspace 文件 | realpath + allowlist + WorkDirGuard；客户端不传可信物化路径 | RepositoryService、Web Host、fs-node 安全测试 |
| Session 恢复到错误 cwd | 在错误仓库执行工具 | resume 必须先读 binding；找不到 root 直接报错，禁止 cwd fallback | RuntimeRegistry resume 测试 |
| Session Catalog 迁移丢历史 | 历史不可恢复 | 显式 legacy roots；合成 Workspace/binding；临时复制后原子提交；保留旧目录 | legacy 单命中/多命中/重试测试 |
| SSH/HTTPS 凭据泄漏 | 安全事件 | HTTPS userinfo 直接拒绝；只存 remoteIdentity；继承 credential helper/agent | Catalog/Session/日志 token 扫描 |
| Clone/Worktree 并发竞态 | 半目录、错误归属 | 临时目录 + rename；按真实物理路径锁；materializationId 隔离 Session | 并发 materializer 和双分支测试 |
| Git/SSH 子进程挂起 | 资源泄漏、请求永不结束 | AbortSignal、超时、GIT_TERMINAL_PROMPT=0、子进程树清理 | 取消/超时/host-key 失败测试 |
| Kernel 缓存泄漏 | 内存、hook 或 listener 累积 | Registry 引用计数；最后 release await Kernel/插件 dispose | Host disconnect、dispose 和 open-handle 检查 |
| 首发与 UI 锁定竞态/崩溃 | 半会话或双 binding | 单一 SessionRecord exclusive create；状态 reconciliation；UI 不是权威 | 双首发和崩溃边界测试 |
| Web Host 未授权远程访问 | 代码泄漏、远程执行 | 首期强制 loopback；远程认证/授权另立项 | 非 loopback 启动失败测试 |
| Web “本地”概念误导 | 用户以为可选浏览器电脑文件 | 文案标注 Host 目录；无 allowlist 时隐藏入口；Clone 始终可用 | Web capability/UI 测试 |
| Bash 修改未进入 EditRecord | 审计不完整 | 明确首期只保证 Write/Edit；Diff/checkpoint 仍反映结果；不把日志作为安全边界 | Bash 限制测试和文档 |
| before/after 体积过大 | Session Store 膨胀 | 首期设明确单记录字节上限并报告审计不完整；后续改 blob/hash | EditRecord 大文件测试 |
| Electron preload 权限扩大 | Renderer 伪造路径或获得 Node 能力 | 仅暴露无参数 `selectAndImportDirectory`；路径不离开主进程；保持 sandbox | forged RPC、preload API、构建检查 |
| Electron/Web UI 漂移 | 行为不一致 | 共享 DTO、相同状态联合类型和验收用例；稳定后再抽 ui-shell | 两端状态测试矩阵 |
| 已提交 worktree 磁盘残留 | 磁盘增长 | 草稿 worktree 自动清理；已提交 worktree 不自动删除并展示位置；管理 UI 列入后续 | 草稿删除、已提交恢复测试 |
| 草稿 Workspace 泄漏 | managed root/runtime 持续增长 | draft lease、断连 release、启动 scavenger、删除前反查 SessionRecord | 草稿过期与已提交保留测试 |
| 本地持久化模型升级失败 | 数据损坏或无法读取 | 首版 schemaVersion、运行时校验、显式 migrator、未知版本拒绝 | 每类 Store 的版本测试 |
| 多 Host 共用 dataRoot | 跨进程锁失效、状态互相覆盖 | 首期通过 OS 文件锁独占 dataRoot；第二 Host 明确失败 | LocalDataRootLease 双实例/释放测试 |

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
- [ ] 两个 direct Session 的整个 Agent run 串行；外部修改会产生 fingerprint 告警。
- [ ] Workspace Platform rollback 只回退对话 HEAD，用户仓库文件保持不变，UI 明确提示该语义。
- [ ] 首发中断后 Session 要么不存在，要么以 interrupted 状态可见；草稿过期不会删除已提交 Workspace。

### 安全与兼容

- [ ] Workspace A 的工具不能读写 Workspace B 或 allowlist 外路径，包括符号链接逃逸。
- [ ] Clone 不接受任意目标目录，不把凭据写入 Catalog/Session/日志。
- [ ] Clone/Worktree 的取消、超时和 SSH host-key 失败会终止子进程且不留下正式记录。
- [ ] 旧 `serveKernelOverWs/ElectronIpc` 用例继续通过。
- [ ] 旧 `<workDir>/.helios/sessions` 会话可恢复并迁移，新会话不再写入代码仓库。
- [ ] Web 首期只能监听 loopback；未配置 allowlist 时不暴露本地目录浏览。
- [ ] Electron sandbox/contextIsolation 保持开启，Renderer 无 Node 全量能力，也不能提交任意本地路径。
- [ ] 所有新持久化 envelope/row 带 schemaVersion，未知版本拒绝读取。

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
