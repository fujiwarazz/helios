import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FILESYSTEM_PORT_API_VERSION,
  MEMORY_PORT_API_VERSION,
  MULTI_AGENT_PORT_API_VERSION,
  COMPACT_STRATEGY_PORT_API_VERSION,
  CHECKPOINT_PORT_API_VERSION,
  LLM_PROVIDER_API_VERSION,
  CAPABILITY_PROVIDER_API_VERSION,
  MODEL_ROUTER_PORT_API_VERSION,
  COST_METER_PORT_API_VERSION,
  TOOL_RESULT_CACHE_PORT_API_VERSION,
  VERSION_PROVIDER_PORT_API_VERSION,
} from "@helios/ports";
import type {
  KernelContext,
  Logger,
  PluginModule,
  CapabilityProvider,
  LLMProvider,
} from "@helios/ports";
import { ServiceCollection, type ServiceToken } from "./serviceCollection";
import {
  IFileSystemPort,
  IMemoryPort,
  IMultiAgentPort,
  ICompactPort,
  ICheckpointPort,
  IModelRouterPort,
  ICostMeterPort,
  IToolResultCachePort,
  IVersionProviderPort,
} from "./tokens";
import { LiveLLMRegistry } from "./portRegistry";

export type PortName =
  | "FileSystemPort"
  | "MemoryPort"
  | "MultiAgentPort"
  | "CompactStrategyPort"
  | "CheckpointPort"
  | "LLMProvider"
  | "CapabilityProvider"
  | "ModelRouterPort"
  | "CostMeterPort"
  | "ToolResultCachePort"
  | "VersionProviderPort";

export interface PluginEntry {
  port: PortName;
  package: string;
  options?: Record<string, unknown>;
}

export interface Manifest {
  plugins: PluginEntry[];
}

interface PortMeta {
  apiVersion: number;
  requiredMethods: string[];
  kind: "single" | "multi";
  token?: ServiceToken<unknown>;
}

const PORT_META: Record<PortName, PortMeta> = {
  FileSystemPort: {
    apiVersion: FILESYSTEM_PORT_API_VERSION,
    requiredMethods: ["readFile", "writeFile", "glob", "exists"],
    kind: "single",
    token: IFileSystemPort as ServiceToken<unknown>,
  },
  MemoryPort: {
    apiVersion: MEMORY_PORT_API_VERSION,
    requiredMethods: ["recall", "remember"],
    kind: "single",
    token: IMemoryPort as ServiceToken<unknown>,
  },
  MultiAgentPort: {
    apiVersion: MULTI_AGENT_PORT_API_VERSION,
    requiredMethods: ["spawn", "send", "onMessage"],
    kind: "single",
    token: IMultiAgentPort as ServiceToken<unknown>,
  },
  CompactStrategyPort: {
    apiVersion: COMPACT_STRATEGY_PORT_API_VERSION,
    requiredMethods: ["shouldCompact", "compact"],
    kind: "single",
    token: ICompactPort as ServiceToken<unknown>,
  },
  CheckpointPort: {
    apiVersion: CHECKPOINT_PORT_API_VERSION,
    requiredMethods: ["snapshot", "restore"],
    kind: "single",
    token: ICheckpointPort as ServiceToken<unknown>,
  },
  LLMProvider: {
    apiVersion: LLM_PROVIDER_API_VERSION,
    requiredMethods: ["streamMessage"],
    kind: "multi",
  },
  CapabilityProvider: {
    apiVersion: CAPABILITY_PROVIDER_API_VERSION,
    requiredMethods: ["activate"],
    kind: "multi",
  },
  ModelRouterPort: {
    apiVersion: MODEL_ROUTER_PORT_API_VERSION,
    requiredMethods: ["route"],
    kind: "single",
    token: IModelRouterPort as ServiceToken<unknown>,
  },
  CostMeterPort: {
    apiVersion: COST_METER_PORT_API_VERSION,
    requiredMethods: ["onLLMCall", "onToolCall", "setOutcome", "report", "getUsage"],
    kind: "single",
    token: ICostMeterPort as ServiceToken<unknown>,
  },
  ToolResultCachePort: {
    apiVersion: TOOL_RESULT_CACHE_PORT_API_VERSION,
    requiredMethods: ["get", "set"],
    kind: "single",
    token: IToolResultCachePort as ServiceToken<unknown>,
  },
  VersionProviderPort: {
    apiVersion: VERSION_PROVIDER_PORT_API_VERSION,
    requiredMethods: ["get"],
    kind: "single",
    token: IVersionProviderPort as ServiceToken<unknown>,
  },
};

export interface LoadResult {
  capabilities: CapabilityProvider[];
  llm: LiveLLMRegistry;
  disposables: Array<{ dispose(): void | Promise<void> }>;
}

/**
 * 按 manifest 声明顺序串行加载。后加载的插件在 create(ctx) 时通过 ctx.ports
 * 拿到前面已注册的 Port。基础 Port（尤其 FileSystemPort）应写在 manifest 前面。
 */
/** 宿主 app 提供的裸包解析器（如 `(spec) => import.meta.resolve(spec)`），锚定到 app 自己的依赖。 */
export type PackageResolver = (spec: string) => string;

export async function loadPlugins(
  manifest: Manifest,
  services: ServiceCollection,
  ctx: KernelContext,
  logger: Logger,
  resolvePackage?: PackageResolver,
): Promise<LoadResult> {
  const capabilities: CapabilityProvider[] = [];
  const disposables: Array<{ dispose(): void | Promise<void> }> = [];
  const llm = ctx.ports.llm as LiveLLMRegistry;

  for (const entry of manifest.plugins) {
    const meta = PORT_META[entry.port];
    if (!meta) {
      logger.error(`未知 Port 类型：${entry.port}（package=${entry.package}），跳过`);
      continue;
    }
    try {
      const mod = await importPlugin(entry.package, ctx.workDir, resolvePackage);
      assertApiVersionCompatible(entry.port, mod.apiVersion, meta.apiVersion);

      const perEntryCtx: KernelContext = { ...ctx, options: entry.options };
      const impl = await mod.create(perEntryCtx);
      validateShape(entry.port, impl, meta.requiredMethods);
      if (isDisposable(impl)) disposables.push(impl);

      if (meta.kind === "single") {
        if (services.has(meta.token!)) {
          throw new Error(
            `单实例 Port '${entry.port}' 已有实现，禁止重复声明（package=${entry.package}）`,
          );
        }
        services.set(meta.token!, impl);
      } else if (entry.port === "LLMProvider") {
        llm.add(impl as LLMProvider);
      } else {
        capabilities.push(impl as CapabilityProvider);
      }
      logger.info(`已加载插件 ${entry.package} → ${entry.port}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 单个插件失败：记录清晰错误并跳过；必须实现的 Port 缺失在装配收尾统一中止。
      logger.error(`加载插件失败 ${entry.package} → ${entry.port}：${msg}`);
    }
  }

  return { capabilities, llm, disposables };
}

function isDisposable(value: unknown): value is { dispose(): void | Promise<void> } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { dispose?: unknown }).dispose === "function"
  );
}

async function importPlugin(
  pkg: string,
  workDir: string,
  resolvePackage?: PackageResolver,
): Promise<PluginModule> {
  let spec: string;
  if (pkg.startsWith(".") || isAbsolute(pkg)) {
    spec = pathToFileURL(resolve(workDir, pkg)).href;
  } else {
    // 裸包名：优先用宿主提供的解析器（锚定到 app 依赖），否则回落默认 node 解析。
    spec = resolvePackage ? resolvePackage(pkg) : pkg;
  }
  const mod = (await import(spec)) as Record<string, unknown>;
  const candidate = (mod.default ?? mod) as Partial<PluginModule>;
  if (typeof candidate.apiVersion !== "number" || typeof candidate.create !== "function") {
    throw new Error(`插件 ${pkg} 未导出合法的 { apiVersion, create } 形状`);
  }
  return candidate as PluginModule;
}

function assertApiVersionCompatible(
  port: PortName,
  provided: number,
  required: number,
): void {
  // apiVersion 是纯整数即 major version；只有相等才兼容。
  if (provided !== required) {
    throw new Error(
      `port ${port} 需要 apiVersion ${required}，插件提供 ${provided}（major 不符，拒绝加载）`,
    );
  }
}

function validateShape(port: PortName, impl: unknown, requiredMethods: string[]): void {
  if (impl === null || typeof impl !== "object") {
    throw new Error(`port ${port} 的实现不是对象`);
  }
  const obj = impl as Record<string, unknown>;
  for (const m of requiredMethods) {
    if (typeof obj[m] !== "function") {
      throw new Error(`port ${port} 的实现缺少方法：${m}()`);
    }
  }
}
