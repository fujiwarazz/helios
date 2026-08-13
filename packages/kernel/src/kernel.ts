import type {
  Logger,
  KernelContext,
  LLMOptions,
  ToolRenderer,
  AskQuestionRequest,
  AskQuestionResponse,
} from "@helios/ports";
import { ServiceCollection } from "./serviceCollection";
import { IFileSystemPort } from "./tokens";
import { LiveLLMRegistry, createLivePortRegistry } from "./portRegistry";
import { ToolRegistry } from "./toolRegistry";
import { HookRunner } from "./hookRunner";
import { loadHookConfig, toHookBindings } from "./hookConfigLoader";
import { loadPlugins, type Manifest, type PackageResolver } from "./pluginLoader";
import { builtinCapabilityProvider } from "./builtin/provider";
import { Session, type SessionMeta } from "./session";
import { uid } from "./ids";
import type { LlmRetryOptions } from "./agentLoop/retryBackoff";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLangSmithTracer, type Tracer } from "@helios/observability-langsmith";

/** 只读的 port/工具聚合信息，供 UI 的 Ports 页展示。 */
export interface PortInfo {
  provider: string;
  tools: string[];
  enabled: boolean;
}

const DEFAULT_SYSTEM =
  "你是 helios，一个可插拔的 AI 编程助手。使用可用的工具完成用户任务，保持简洁。";

export interface KernelOptions {
  workDir: string;
  /** Session 持久化目录；缺省保持 `<workDir>/.helios/sessions` 兼容行为。 */
  sessionDataRoot?: string;
  manifest: Manifest;
  logger?: Logger;
  system?: string;
  llmOptions?: LLMOptions;
  /** 宿主提供的裸包解析器，锚定到宿主自身依赖（如 `(s) => import.meta.resolve(s)`）。 */
  resolvePackage?: PackageResolver;
  /** 覆盖 hook 命令默认超时（毫秒），主要用于测试/宿主定制，不改变配置加载来源。 */
  hookCommandTimeoutMs?: number;
  /** Disable unsafe built-in tools for constrained hosts (for example Workspace sessions). */
  disabledBuiltinTools?: string[];
  /** Optional observability adapter. Defaults to the LangSmith environment configuration. */
  tracer?: Tracer;
}

export interface CreateSessionOptions {
  /** 平台层预生成的稳定 Session ID；普通嵌入方不传时仍由 Kernel 生成。 */
  id?: string;
  askQuestion(req: AskQuestionRequest): Promise<AskQuestionResponse>;
  maxTurns?: number;
  /** LLM 调用重试策略覆盖；缺省用 DEFAULT_LLM_RETRY（issue #10）。 */
  llmRetry?: LlmRetryOptions;
  /** 重试等待的注入点，测试可传瞬时 resolve 避免真实等待。 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 上下文预算可观测性阈值（估算 token 数）：run 中途 message path 估算值超过该阈值时记录一次
   * warning（不触发压缩，纯观察）。不传则不检查，默认关闭。估算值不含 system/tools，见
   * `agentLoop/contextBudget.ts`。
   */
  contextBudgetWarnTokens?: number;
  /** 首次 run 在写入用户消息和执行工具前调用；用于原子提交平台 SessionRecord。 */
  beforeFirstRun?: (text: string) => Promise<void>;
  /** 平台持久化 run 生命周期；一次多-turn run 只产生一对 running/终态。 */
  onRunStateChange?: (state: "running" | "idle" | "interrupted") => Promise<void>;
  recordEdit?: (edit: FileEditObservation) => Promise<ArtifactAction | void>;
  markAuditGap?: (gap: { toolUseId?: string; reason: string; createdAt: number }) => Promise<void>;
  acquireMutationLease?: (runId: string) => Promise<() => Promise<void>>;
  rollbackPolicy?: "full" | "conversation-only";
}

export class Kernel {
  private readonly logger: Logger;
  private readonly services = new ServiceCollection();
  private readonly llm = new LiveLLMRegistry();
  private readonly tools = new ToolRegistry();
  private readonly hooks: HookRunner;
  private readonly renderers = new Map<string, ToolRenderer>();
  private readonly ports = createLivePortRegistry(this.services, this.llm);
  private readonly pluginDisposables: Array<{ dispose(): void | Promise<void> }> = [];
  private readonly tracer: Tracer;
  private started = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly opts: KernelOptions) {
    this.logger = opts.logger ?? consoleLogger();
    this.tracer = opts.tracer ?? createLangSmithTracer();
    // HookRunner 依赖 this.logger 记录 handler 异常，字段初始化器早于构造函数体（this.logger 此时
    // 尚未赋值），故延后到这里构造，而不是像其它字段那样用类字段初始化器。
    this.hooks = new HookRunner(this.logger);
  }

  /** 装配：加载 manifest 插件 → 校验必须实现的 Port → 激活能力提供者。 */
  async start(): Promise<void> {
    if (this.started) return;
    const ctx: KernelContext = {
      workDir: this.opts.workDir,
      logger: this.logger,
      ports: this.ports,
    };

    const { capabilities, disposables } = await loadPlugins(
      this.opts.manifest,
      this.services,
      ctx,
      this.logger,
      this.opts.resolvePackage,
    );
    this.pluginDisposables.push(...disposables);

    // 必须实现的 Port 校验
    if (this.llm.size === 0) {
      throw new Error("启动中止：manifest 未配置任何 LLMProvider。");
    }
    if (!this.services.has(IFileSystemPort)) {
      throw new Error("启动中止：manifest 未配置 FileSystemPort（六件套依赖的基座）。");
    }

    // 六件套内建 provider —— 命名豁免前缀，其余一切与用户 provider 相同
    await this.activateProvider(builtinCapabilityProvider, ctx, true);
    for (const cap of capabilities) {
      await this.activateProvider(cap, ctx, false);
    }

    // 配置化 hook：读 ~/.helios/hooks.json + <workDir>/.helios/hooks.json，与 CapabilityProvider
    // 注册的 hook 并列（HookRunner.register 可多次调用），循环触发点不感知来源。
    const hookEntries = await loadHookConfig(this.opts.workDir, this.logger);
    this.hooks.register(
      toHookBindings(hookEntries, {
        workDir: this.opts.workDir,
        logger: this.logger,
        timeoutMs: this.opts.hookCommandTimeoutMs,
      }),
    );

    this.started = true;
    this.logger.info(
      `helios kernel 启动完成：LLM=[${this.llm.list().join(",")}] 工具数=${this.tools.list().length}`,
    );
  }

  private async activateProvider(
    cap: import("@helios/ports").CapabilityProvider,
    ctx: KernelContext,
    exemptPrefix: boolean,
  ): Promise<void> {
    await cap.activate(ctx);
    const tools = cap.getTools?.() ?? [];
    const enabledTools = exemptPrefix
      ? tools.filter((tool) => !this.opts.disabledBuiltinTools?.includes(tool.name))
      : tools;
    this.tools.add(cap.name, enabledTools, exemptPrefix);
    this.hooks.register(cap.getHookHandlers?.() ?? []);
    for (const r of cap.getRenderers?.() ?? []) {
      this.renderers.set(r.toolName, r);
    }
  }

  createSession(opts: CreateSessionOptions): Session {
    return this.newSession(opts.id ?? uid("sess"), opts);
  }

  /**
   * 按 id 从磁盘 resume 一个历史会话：重建 history/turnLog、续接 runIndex。
   * 找不到落盘记录时返回一个全新空会话（沿用该 id），不报错。
   */
  async resumeSession(id: string, opts: CreateSessionOptions): Promise<Session> {
    const session = this.newSession(id, opts);
    await session.restore();
    return session;
  }

  private newSession(id: string, opts: CreateSessionOptions): Session {
    if (!this.started) throw new Error("Kernel 未 start()");
    return new Session({
      id,
      workDir: this.opts.workDir,
      sessionDir: join(
        this.opts.sessionDataRoot ?? join(this.opts.workDir, ".helios", "sessions"),
        id,
      ),
      ports: this.ports,
      tools: this.tools,
      hooks: this.hooks,
      logger: this.logger,
      llmOptions: this.opts.llmOptions ?? {},
      system: this.opts.system ?? DEFAULT_SYSTEM,
      askQuestion: opts.askQuestion,
      maxTurns: opts.maxTurns,
      llmRetry: opts.llmRetry,
      sleep: opts.sleep,
      contextBudgetWarnTokens: opts.contextBudgetWarnTokens,
      beforeFirstRun: opts.beforeFirstRun,
      onRunStateChange: opts.onRunStateChange,
      recordEdit: opts.recordEdit,
      markAuditGap: opts.markAuditGap,
      acquireMutationLease: opts.acquireMutationLease,
      rollbackPolicy: opts.rollbackPolicy,
      tracer: this.tracer,
    });
  }

  getRenderer(toolName: string): ToolRenderer | undefined {
    return this.renderers.get(toolName);
  }

  listTools(): string[] {
    return this.tools.list().map((t) => t.name);
  }

  /**
   * 列出磁盘上的历史会话（读每个 `.helios/sessions/<id>/meta.json`）。
   * 按 updatedAt 倒序；目录缺失或单条损坏时安全跳过。只读，不 resume。
   */
  async listSessions(): Promise<SessionMeta[]> {
    const dir = this.opts.sessionDataRoot ?? join(this.opts.workDir, ".helios", "sessions");
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return []; // 尚无任何会话
    }
    const metas: SessionMeta[] = [];
    for (const id of entries) {
      try {
        const raw = await readKernelMeta(dir, id);
        const meta = JSON.parse(raw) as SessionMeta;
        if (meta && typeof meta.id === "string") metas.push(meta);
      } catch {
        // 无 meta.json / 损坏 / 非目录：跳过
      }
    }
    metas.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return metas;
  }

  /**
   * 只读列出已装配的 port（按 provider 命名空间聚合工具）。
   * 命名空间来自工具全名 `<provider>__<tool>`；无前缀的六件套归到 "builtin"。
   */
  listPorts(): PortInfo[] {
    const byProvider = new Map<string, string[]>();
    for (const name of this.listTools()) {
      const sep = name.indexOf("__");
      const provider = sep > 0 ? name.slice(0, sep) : "builtin";
      const list = byProvider.get(provider) ?? [];
      list.push(name);
      byProvider.set(provider, list);
    }
    return [...byProvider.entries()].map(([provider, tools]) => ({
      provider,
      tools,
      enabled: true,
    }));
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.disposePlugins();
    return this.disposePromise;
  }

  private async disposePlugins(): Promise<void> {
    for (const disposable of [...this.pluginDisposables].reverse()) {
      try {
        await disposable.dispose();
      } catch (error) {
        this.logger.error(
          `插件资源释放失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.pluginDisposables.length = 0;
    this.started = false;
  }
}

export interface FileEditObservation {
  toolUseId: string;
  path: string;
  operation: "create" | "update" | "delete";
  before?: string;
  after?: string;
}

export interface ArtifactAction {
  workspaceId: string;
  rootId: string;
  relativePath: string;
  before?: string;
  after?: string;
}

async function readKernelMeta(root: string, id: string): Promise<string> {
  try {
    return await readFile(join(root, id, "kernel-meta.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return await readFile(join(root, id, "meta.json"), "utf8");
  }
}

function consoleLogger(): Logger {
  return {
    debug: (...a) => console.debug("[helios]", ...a),
    info: (...a) => console.info("[helios]", ...a),
    warn: (...a) => console.warn("[helios]", ...a),
    error: (...a) => console.error("[helios]", ...a),
  };
}
