import type { LLMProvider, LLMRegistry, PortRegistry } from "@helios/ports";
import { ServiceCollection } from "./serviceCollection";
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
import {
  NoopMemory,
  NoopMultiAgent,
  NoopCompact,
  NoopCheckpoint,
  NoopModelRouter,
  NoopCostMeter,
  NoopToolResultCache,
  NoopVersionProvider,
} from "./noop";

/** 多实例 LLMProvider 注册表 */
export class LiveLLMRegistry implements LLMRegistry {
  private readonly providers: LLMProvider[] = [];

  add(provider: LLMProvider): void {
    this.providers.push(provider);
  }

  get(provider?: string): LLMProvider {
    if (this.providers.length === 0) {
      throw new Error("没有已注册的 LLMProvider");
    }
    if (!provider) return this.providers[0]!;
    const found = this.providers.find((p) => p.id === provider);
    if (!found) throw new Error(`未找到 LLMProvider: ${provider}`);
    return found;
  }

  list(): string[] {
    return this.providers.map((p) => p.id);
  }

  get size(): number {
    return this.providers.length;
  }
}

/**
 * 构造 live PortRegistry：getter 实时读取 ServiceCollection，未注册则回落 no-op。
 * 因此按 manifest 声明顺序串行加载时，后加载的插件能拿到前面已注册的 Port。
 * FileSystemPort 是必须实现的 Port，未注册直接抛错（不 no-op）。
 */
export function createLivePortRegistry(
  services: ServiceCollection,
  llm: LiveLLMRegistry,
): PortRegistry {
  return {
    get fileSystem() {
      const fs = services.tryGet(IFileSystemPort);
      if (!fs) throw new Error("FileSystemPort 未加载（必须实现的 Port）");
      return fs;
    },
    get memory() {
      return services.tryGet(IMemoryPort) ?? NoopMemory;
    },
    get multiAgent() {
      return services.tryGet(IMultiAgentPort) ?? NoopMultiAgent;
    },
    get compact() {
      return services.tryGet(ICompactPort) ?? NoopCompact;
    },
    get checkpoint() {
      return services.tryGet(ICheckpointPort) ?? NoopCheckpoint;
    },
    get modelRouter() {
      return services.tryGet(IModelRouterPort) ?? NoopModelRouter;
    },
    get costMeter() {
      return services.tryGet(ICostMeterPort) ?? NoopCostMeter;
    },
    get toolCache() {
      return services.tryGet(IToolResultCachePort) ?? NoopToolResultCache;
    },
    get versionProvider() {
      return services.tryGet(IVersionProviderPort) ?? NoopVersionProvider;
    },
    llm,
  };
}
