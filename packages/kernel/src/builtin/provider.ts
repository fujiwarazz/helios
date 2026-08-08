import type { CapabilityProvider, Tool, KernelContext } from "@helios/ports";
import { createBuiltinTools } from "./tools";

/**
 * 六件套内建 CapabilityProvider 参考实现。它与用户自写 provider 走完全相同的
 * 注册路径，唯一区别是 kernel 注册它时豁免工具名前缀（见 Kernel.start）。
 * 与 `capability-fs` 的 `create(ctx) → new FsCapability(ctx.ports.fileSystem)` 同一模式：
 * activate() 时从 KernelContext 拿到具体 Port 实例、闭包造好工具，getTools() 只读取。
 */
class BuiltinCapability implements CapabilityProvider {
  readonly name = "builtin";
  private tools: Tool[] = [];

  activate(ctx: KernelContext): void {
    this.tools = createBuiltinTools(ctx.ports);
  }

  getTools(): Tool[] {
    return this.tools;
  }
}

export const builtinCapabilityProvider: CapabilityProvider = new BuiltinCapability();
