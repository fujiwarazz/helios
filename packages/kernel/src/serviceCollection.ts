// IoC 容器：Symbol token + Map。存取机制保留自原设计，仅补两条纪律：
// 1) token 类型参数必须是独立 Port 接口（见 tokens.ts）；
// 2) 实例来源统一由 PluginLoader 从 manifest 动态装配。

export interface ServiceToken<T> {
  readonly symbol: symbol;
  readonly name: string;
  /** 仅用于携带类型，不在运行时使用 */
  readonly __type?: T;
}

export function createServiceToken<T>(name: string): ServiceToken<T> {
  return { symbol: Symbol(name), name };
}

export class ServiceCollection {
  private readonly map = new Map<symbol, unknown>();

  set<T>(token: ServiceToken<T>, instance: T): this {
    this.map.set(token.symbol, instance);
    return this;
  }

  has<T>(token: ServiceToken<T>): boolean {
    return this.map.has(token.symbol);
  }

  /** 找不到时返回 undefined；由调用方（Kernel 装配层）决定 no-op 兜底或中止。 */
  tryGet<T>(token: ServiceToken<T>): T | undefined {
    return this.map.get(token.symbol) as T | undefined;
  }

  get<T>(token: ServiceToken<T>): T {
    const v = this.map.get(token.symbol);
    if (v === undefined) {
      throw new Error(`Service not registered for token: ${token.name}`);
    }
    return v as T;
  }
}
