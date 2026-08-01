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
import { loadPlugins, type Manifest, type PackageResolver } from "./pluginLoader";
import { builtinCapabilityProvider } from "./builtin/provider";
import { Session } from "./session";
import { uid } from "./ids";

const DEFAULT_SYSTEM =
  "你是 helios，一个可插拔的 AI 编程助手。使用可用的工具完成用户任务，保持简洁。";

export interface KernelOptions {
  workDir: string;
  manifest: Manifest;
  logger?: Logger;
  system?: string;
  llmOptions?: LLMOptions;
  /** 宿主提供的裸包解析器，锚定到宿主自身依赖（如 `(s) => import.meta.resolve(s)`）。 */
  resolvePackage?: PackageResolver;
}

export interface CreateSessionOptions {
  askQuestion(req: AskQuestionRequest): Promise<AskQuestionResponse>;
  maxTurns?: number;
}

export class Kernel {
  private readonly logger: Logger;
  private readonly services = new ServiceCollection();
  private readonly llm = new LiveLLMRegistry();
  private readonly tools = new ToolRegistry();
  private readonly hooks = new HookRunner();
  private readonly renderers = new Map<string, ToolRenderer>();
  private readonly ports = createLivePortRegistry(this.services, this.llm);
  private started = false;

  constructor(private readonly opts: KernelOptions) {
    this.logger = opts.logger ?? consoleLogger();
  }

  /** 装配：加载 manifest 插件 → 校验必须实现的 Port → 激活能力提供者。 */
  async start(): Promise<void> {
    if (this.started) return;
    const ctx: KernelContext = {
      workDir: this.opts.workDir,
      logger: this.logger,
      ports: this.ports,
    };

    const { capabilities } = await loadPlugins(
      this.opts.manifest,
      this.services,
      ctx,
      this.logger,
      this.opts.resolvePackage,
    );

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
    this.tools.add(cap.name, cap.getTools?.() ?? [], exemptPrefix);
    this.hooks.register(cap.getHookHandlers?.() ?? []);
    for (const r of cap.getRenderers?.() ?? []) {
      this.renderers.set(r.toolName, r);
    }
  }

  createSession(opts: CreateSessionOptions): Session {
    return this.newSession(uid("sess"), opts);
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
      ports: this.ports,
      tools: this.tools,
      hooks: this.hooks,
      logger: this.logger,
      llmOptions: this.opts.llmOptions ?? {},
      system: this.opts.system ?? DEFAULT_SYSTEM,
      askQuestion: opts.askQuestion,
      maxTurns: opts.maxTurns,
    });
  }

  getRenderer(toolName: string): ToolRenderer | undefined {
    return this.renderers.get(toolName);
  }

  listTools(): string[] {
    return this.tools.list().map((t) => t.name);
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
