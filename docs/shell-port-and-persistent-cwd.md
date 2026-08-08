# ShellPort 演进方案：从无状态 Bash 到持久 cwd 的 Shell 抽象

> 基于对 helios 现有实现（`builtin/tools.ts` / `fs-node/pathGuard.ts` / `ports/types.ts` / `kernel/session.ts`）的通读，
> 以及对 valos `ShellService`（`vectorx-code/.../shellService.ts` + `bashTool.ts`）机制的对照。
> 目标：把当前无状态的 Bash 执行升级为一个可插拔的 `ShellPort`，支持跨命令持久 cwd / session env / cwd 越界护栏。

---

## 一、动机：当前 Bash 是无状态的

`builtin/tools.ts` 的 Bash 工具：

```ts
const res = await execa(command, { shell: true, cwd: ctx.workDir, timeout, signal: ctx.signal });
```

每条命令都从 `ctx.workDir` 起步，导致：

- **`cd` 不持久**：`cd src && ls` 分两条命令时，第二条又回到 workDir——与用户/LLM 的直觉不符。
- **无 session 级 env**：没有"给本 session 后续所有命令注入环境变量"的通道（valos 用它注入 token/路径）。
- **无 cwd 越界护栏**：命令内 `cd /tmp` 之后即便持久了，也没有"跑出工作区就拉回"的兜底。

对照 valos：`ShellService` 是**非常驻 bash + cwdFile 持久 cwd + snapshot 持久 env + BashTool 越界拉回 primaryDir**。helios 缺的正是这套"shell 执行如何被管理"的抽象。

**关键澄清**：这不是替换 `PathGuard`。两者正交——`PathGuard` 管**文件工具**（Read/Write/Edit/Glob/Grep）的路径越界，留在 fs-node 不动；`ShellPort` 管 **shell 执行**（持久 cwd / env / 护栏）。valos BashTool 的"cwd 越界拉回"本质是 PathGuard 的 shell 版，二者可共享同一份边界定义。

---

## 二、设计：新增 `ShellPort`

### 2.1 Port 接口（`packages/ports/src/shell.ts`）

```ts
export const SHELL_PORT_API_VERSION = 1;

export interface ShellExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * 一个 ShellSession 代表"某个 session 的持久 shell 上下文"：
 * 跨 exec 保留 cwd 与 session env，非常驻进程（每条命令 spawn 新子进程）。
 */
export interface ShellSession {
  exec(command: string, opts?: ShellExecOptions): Promise<ShellExecResult>;
  pwd(): string;                       // 当前持久 cwd（内存镜像）
  setCwd(absOrRel: string): void;      // 目录不存在应 throw；越界拉回由调用方/护栏决定
  appendEnv(vars: Record<string, string>): void; // session 级 env（下次 exec 生效）
  dispose(): void;                     // 清理 cwdFile / snapshot 等临时资源
}

/** 工厂：按 session 造 ShellSession（cwd/env 是 per-session 状态，不能是单例） */
export interface ShellPort {
  forSession(sessionId: string, workDir: string): ShellSession;
}
```

`apiVersion = 1`（纯整数 major，兼容校验 `===`，与其余 Port 一致）。

### 2.2 默认实现（`packages/shell-node`，与 fs-node 平级）

搬 valos 那套机制（非 `@xhs/*`，纯 Node）：

- 构造 `ShellSession` 时：`cwdFile = tmpdir()/helios-<sessionId>-cwd`，初值写 `workDir`。
- `exec`：`spawn(shell, ['-c', "source <snapshot> && " + command + " && pwd -P >| <cwdFile>"], { cwd: this.shellCwd, signal })`，结束读 cwdFile 回写 `shellCwd`。
- `appendEnv`：写进 snapshot 文件（`export KEY='<shell-quoted>'`），下次 exec `source` 生效。
- `dispose`：unlink cwdFile / snapshot。
- **复用 `WorkDirGuard`**：`setCwd` 与 exec 后校验用同一个 `assertAllowed`，越界即拉回 workDir（边界定义单一源头，避免与 PathGuard 漂移）。

保留可插拔性：`ShellPort` 缺省时 kernel `noop.ts` 给一个"无持久、直 execa"的兜底实现（等价现状），保证不装 shell-node 也能跑。

### 2.3 kernel 接线

- `PortRegistry` **不加** `shell`（因为它是 per-session 工厂，不适合放进按 session 共享的运行时 registry）。改为：kernel 在装配期拿到 `ShellPort` 工厂，`Session` 构造时调 `shellPort.forSession(id, workDir)` 得到 `ShellSession`。
- `Session` 持有该 `ShellSession`（跟它已持有的 per-run AbortController、per-session workDir 放一起），`dispose()` 时一并释放。
- `ToolContext` 新增 `shell: ShellSession`（`types.ts:79`）。
- Bash 工具改为：`const r = await ctx.shell.exec(command, { timeoutMs, signal: ctx.signal });`——工具变薄，持久 cwd/env/护栏全在 ShellSession 内。

> 选型理由：per-session 状态由 Session 持有（方案 b），比"exec 到处传 sessionId"（方案 a）更贴合 helios 现状——Session 本就是 per-session 状态的宿主。

---

## 三、任务拆分（建议一个分支收口）

1. **ports**：新增 `shell.ts`（`ShellPort` / `ShellSession` / api 常量），在 `PluginModule`/装配路径注册 ShellPort 的加载（单实例 token，可缺省）。
2. **kernel**：`noop.ts` 加直 execa 兜底 ShellSession；`Session` 构造/dispose 接线 ShellSession；`ToolContext` 加 `shell`；Bash 工具改用 `ctx.shell.exec`。
3. **shell-node**：新包，valos 机制的 Node 实现（cwdFile + snapshot + WorkDirGuard 护栏）。
4. **测试**：
   - `cd src && pwd` 跨两条 exec，第二条仍在 src（持久 cwd）。
   - `appendEnv({FOO:'bar'})` 后 `echo $FOO` 得 bar。
   - 命令内 `cd /tmp` 后越界 → 下条命令 cwd 被拉回 workDir + stderr 提示。
   - `signal` abort 能中断执行中的命令（复用 cwd-isolation 的 cancel 链路）。
   - 可插拔性：noop 兜底 与 shell-node 在"单条命令执行"上行为一致（除持久 cwd）。

---

## 四、边界与非目标（诚实标注）

- **本方案不引入多根 `WorkspaceDirs`**。helios 维持单一 `workDir`，护栏拉回 workDir 即可。多仓（primaryDir + additionalDirs）是**独立的后续演进**，需先把 `workDir → WorkspaceDirs` 泛化，不在本方案内。
- **不改 PathGuard 归属**：文件工具仍走 fs-node 的 PathGuard；ShellPort 只是复用其 `WorkDirGuard`。
- **非常驻 bash 是有意选择**（对齐 valos）：换取 session 间隔离，代价是 shell 函数/`set` 选项不跨命令持久（只有 cwd 与 env 持久）。若将来需要常驻 shell，是另一次权衡，不在此列。
- **session env 注入来源**：本方案只提供 `appendEnv` 通道；"谁来注入、注入什么"（valos 里是 SessionStart hook）属于 Hook 系统的职责，需要时另接。
