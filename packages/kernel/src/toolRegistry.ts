import type { Tool } from "@helios/ports";

/**
 * 工具表。冲突解决用显式 namespace：多实例 CapabilityProvider 产出的工具
 * 一律加 `<provider.name>__` 前缀；六件套内建工具是唯一例外（命名豁免）。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /**
   * @param providerName provider 命名空间前缀
   * @param tools 该 provider 产出的工具
   * @param exemptPrefix 是否豁免前缀（仅六件套内建）
   */
  add(providerName: string, tools: Tool[], exemptPrefix = false): void {
    for (const tool of tools) {
      const finalName = exemptPrefix ? tool.name : `${providerName}__${tool.name}`;
      if (this.tools.has(finalName)) {
        throw new Error(
          `工具命名冲突：'${finalName}' 已注册（provider='${providerName}'）`,
        );
      }
      this.tools.set(finalName, { ...tool, name: finalName });
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}
