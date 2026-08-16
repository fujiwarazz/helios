# Helios

Helios 是一个可插拔的代码 Agent，提供 Electron、Web 和 CLI 三种消费端。三端共用 Kernel、Session、Workspace Catalog、Git 物化和编辑审计能力。

## Chat 与 Code

- Electron/Web 默认进入 Chat。每个 Chat 自动创建独立的托管 Workspace，文件不会写入 Helios 仓库。
- CLI 默认进入 Code：以启动目录所在的 Git 仓库根（无 Git 时即该目录）作为 Workspace，`direct` 直接修改原仓库，语义对齐 pi/claude-code/codex；`--chat` 退回托管 Chat Workspace。同一目录重复启动复用同一个 Workspace 条目，共享 memory、会话与编辑记录。
- 设置 `HELIOS_CODE_MODE=1` 后，Electron/Web 主页面显示 Chat/Code 切换；Sidebar 不变，Code 的仓库选择器位于输入框上方。CLI 不需要该开关。
- Code 可导入宿主本地目录或通过 HTTPS/SSH URL 执行 Git Clone。
- 默认 `direct`，Agent 会直接修改原仓库；Git 仓库可选 `worktree`，平台会创建 `helios/<materializationId>` 隔离分支。
- 首条消息发送后 Workspace 绑定锁定；切换仓库需要新建会话。
- 平台回退仅回退对话，不修改文件。

## 启动

先安装依赖：

```bash
pnpm install
```

## LangSmith 可观测性

Helios 会在 `LANGSMITH_TRACING=true` 且配置了 `LANGSMITH_API_KEY` 时自动发送追踪数据；未配置、关闭或 LangSmith 不可用时，Agent 正常继续执行。

```bash
cp .env.example .env
# 在 .env 中填写 LANGSMITH_API_KEY
```

将这些变量提供给运行 CLI、Electron 主进程或 Web Host 的进程。每次 Agent run 会生成一个根 trace，模型流式调用和工具调用则显示为它的 `llm` 与 `tool` 子 run。追踪输入会自动裁剪，并脱敏 `Authorization`、Cookie、token、密码和 API key 等字段；不要把真实密钥写入仓库、日志或聊天记录。若密钥曾在聊天或日志中出现，请在 LangSmith 控制台轮换它。

Electron（本地目录使用原生目录选择器）：

```bash
HELIOS_CODE_MODE=1 pnpm --filter @helios/electron dev
```

如果 Electron 报 `failed to install correctly`，说明本机 `node_modules` 缺少 Electron 二进制；重新运行允许安装脚本的 `pnpm install`，并用 `pnpm --filter @helios/electron exec electron --version` 确认安装。

Web（Host 只允许监听 loopback）：

```bash
HELIOS_CODE_MODE=1 \
HELIOS_WORKSPACE_ROOTS="$PWD" \
pnpm --filter @helios/web dev
```

Web 的“本地目录”是 Web Host 所在机器能访问且位于 `HELIOS_WORKSPACE_ROOTS` allowlist 内的目录，不是浏览器所在电脑的任意目录。未配置 allowlist 时仍可使用 Git Clone。

CLI：

```bash
pnpm --filter @helios/cli start                         # Code direct（启动目录所在仓库）
pnpm --filter @helios/cli start -- --worktree           # Code worktree（隔离分支）
pnpm --filter @helios/cli start -- --chat               # 托管 Chat workspace
pnpm --filter @helios/cli start -- --code <path>        # 指定其他目录
pnpm --filter @helios/cli start -- --clone git@github.com:org/repo.git
pnpm --filter @helios/cli start -- --workspace <workspaceId>
pnpm --filter @helios/cli start -- --resume <sessionId>
```

Git Clone 不持久化凭据。HTTPS 使用系统 credential helper，SSH 使用 Host/主进程的 `ssh-agent` 与 `known_hosts`；URL 中禁止携带 HTTPS userinfo/password。

## 本地数据

`HELIOS_DATA_ROOT` 默认为 `~/.helios`。同一时间只能有一个 Host 使用同一 data root。

```text
<dataRoot>/
  workspaces/<workspaceId>.json
  managed-workspaces/<workspaceId>/root/
  repositories/<repositoryId>/source/
  worktrees/<workspaceId>/<materializationId>/<rootId>/
  workspace-memory/<workspaceId>/
  workspace-state/<workspaceId>/<materializationId>/mutations.jsonl
  sessions/<sessionId>/
    session.json
    kernel-meta.json
    turns.jsonl
    compactions.jsonl
    edits.jsonl
```

文件属于 Workspace；消息、turn、编辑记录与审计状态按 `sessionId` 隔离。当前 Write/Edit 会写入逐文件 EditRecord；direct Workspace 会在每次 Agent run 前后记录 fingerprint，检测到 Helios 之外的修改时把会话标记为审计不完整。Bash 由 Runtime 的 `allowShellTool` 控制：Electron/Web 仍禁用，因为仅设置 cwd 不能限制任意 shell 命令越过 Workspace 边界；CLI 运行在用户自己的终端上，默认开启，代价是它创建的会话一律记为审计不完整（`Bash enabled: shell writes are not attributed`）。完成 Sandbox confinement 与外部进程审计后再对三端统一开放。

## 开发验证

```bash
pnpm typecheck
pnpm test
git diff --check
```

详细设计见 [Code 模式与 Workspace 平台设计](docs/superpowers/specs/2026-08-12-code-mode-workspace-platform-design.md)，后续多仓、云存储、Cloud Sandbox 与跨 Sandbox 同步见 [后续演进](docs/code-mode-workspace-platform-follow-ups.md)。
