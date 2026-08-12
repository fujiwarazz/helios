# Code 模式与 Workspace 平台后续演进

**日期：** 2026-08-12
**用途：** 只记录本次首期不实现、但架构必须预留的后续工作。首期范围与实施步骤见 `docs/superpowers/plans/2026-08-12-code-mode-workspace-platform.md`。

## P1：首期稳定后优先补齐

### 1. 多仓 Workspace

- UI 支持一个 Session 选择多个有序 roots，首项是 primary，其余为 additional。
- 文件搜索、Read/Write/Edit、Bash cwd、LSP、MCP、技能和权限检查覆盖全部 roots。
- 每个工具结果必须携带 rootId，禁止仅靠同名相对路径猜仓库。
- 支持独立配置每个 root 的 branch、direct/worktree 和只读状态。
- 对齐 Valos：每个仓库有独立物化目录，Session 运行时归一成 `primaryDir + additionalDirs`。

### 2. Chat 复用已有 Workspace

- New Chat 时允许选择一个已有 Workspace，但仍创建新的 sessionId。
- 只读取 Workspace 级提炼记忆，不读取其他 Session 的原始消息、编辑日志或私有上下文。
- Workspace 文件共享；Session 消息、Diff、EditRecord 和 Artifact 索引继续隔离。
- UI 明示“共享文件/记忆”和“共享会话全文”的区别。

### 3. Artifact 历史页

- 将 `openFile/openDiff/showMarkdown/openUrl` 动作持久化为轻量 ArtifactRef。
- Sidebar 的 Artifacts 页面按 sessionId/workspaceId 筛选和恢复。
- 文件 Artifact 保存 rootId + relativePath + revision，不复制整个文件；需要不可变证据时再保存 content hash/blob。
- Electron 支持系统编辑器打开，Web 支持内置预览，CLI 输出可点击路径或纯文本 Diff。

### 4. Bash 与外部进程的完整编辑审计

- 用 Sandbox overlay、文件系统 journal 或 pre/post tree diff 覆盖 Bash、格式化器和 LSP 写入。
- 将变更尽量归因到 toolUseId；无法精确归因时至少绑定 turnId。
- EditRecord 大文件改用 blob/hash，避免在 JSONL 重复保存完整 before/after。

### 5. 共享 App Shell 与 In-process Transport

- 当 Electron/Web 的 ModeSwitch、WorkspaceComposer 和 Session 生命周期稳定后，抽取 `@helios/ui-shell`。
- 为嵌入式消费方增加 In-process Transport，避免必须伪装成 WS 或 Electron IPC。
- 保持 Workspace RPC 与 Session RPC 传输无关。

## P2：云端数据与 Runtime

### 6. 云 Metadata Store

- 为 WorkspaceCatalog、SessionCatalog、BindingStore、MemoryStore、EditRecordStore 提供数据库/对象存储实现。
- 引入 tenantId/userId，所有主键和查询都带租户边界。
- 加入 schemaVersion、幂等键、乐观锁、软删除和审计日志。
- 本地 Workspace 可选择只把 metadata/会话数据上云，代码仍留在本地。
- 明确端到端加密、数据保留和导出/删除策略。

### 7. Cloud Sandbox Runtime

- RuntimeRegistry 支持 `local` 与 `cloud-sandbox` provider。
- Sandbox 按 binding 拉取/挂载 Workspace，返回 runtimeId 和 materialized roots。
- 加入启动、休眠、恢复、超时、配额、网络策略、密钥注入和日志收集。
- Session 恢复必须先验证 runtime 状态；失效时可重新物化，但保持 workspaceId/rootId 不变。

### 8. Workspace Replica 与跨 Sandbox 同步

- 定义 `WorkspaceReplica { workspaceId, replicaId, runtimeId, revision, state }`。
- Git 仓库优先用 commit/branch/patch 作为同步协议；非 Git Chat Workspace 需要对象清单和内容寻址 blob。
- 明确单写者、多写者、冲突检测、合并和人工决策策略。
- Workspace Memory 独立版本化，不能靠复制整个运行目录同步。
- 在该能力完成前，禁止产品承诺跨 Sandbox 实时共享文件。

### 9. 云端 Git 凭据

- 凭据只通过 Secret Manager 注入短生命周期 Sandbox，不写 Catalog/Session。
- 支持 GitHub/GitLab App、OAuth token、Deploy Key 和 known_hosts 管理。
- Clone/fetch/push 需要域名策略、网络 egress 策略和审计事件。

## P3：远程开发与高级协作

### 10. SSH Runtime

- 与“SSH URL 执行 git clone”严格区分：SSH Runtime 在远端机器执行工具。
- 定义远端健康检查、目录 allowlist、命令取消、端口转发、凭据和日志模型。
- MaterializedWorkspace 路径属于远端 runtime，消费端不得当成本机路径打开。

### 11. Worktree/分支生命周期管理

- Worktree 列表、清理、孤儿检测、锁和磁盘配额。
- 从默认分支创建、从已有分支附着、完成后选择保留/提交/删除。
- 检测 direct 模式脏工作区并提供显式策略。

### 12. 多人共享 Workspace 与权限

- Workspace owner/member/role 权限模型。
- 读、写、执行、管理 Git 凭据和查看 Session 的权限拆分。
- Session 共享与 Workspace 共享分离，默认不因加入 Workspace 而看到所有聊天全文。

## 后续启动条件

- 多仓：单仓 binding、rootId 路径归一和权限测试稳定后启动。
- Chat 复用：Workspace Memory 的读边界和 Session 隔离测试稳定后启动。
- 云 Store：本地 Store 接口不再泄漏绝对路径或 Node 类型后启动。
- Cloud Sandbox：RuntimeRegistry 已能在本地通过同一接口重建 Runtime 后启动。
- 跨 Sandbox 同步：先完成 replica/revision 设计评审和故障演练，不与 Cloud Sandbox 首版捆绑上线。
