import type { CapabilityProvider, Tool } from "@helios/ports";
import { BUILTIN_TOOLS } from "./tools";

/**
 * 六件套内建 CapabilityProvider 参考实现。它与用户自写 provider 走完全相同的
 * 注册路径，唯一区别是 kernel 注册它时豁免工具名前缀（见 Kernel.start）。
 */
export const builtinCapabilityProvider: CapabilityProvider = {
  name: "builtin",
  activate() {
    // 无需初始化
  },
  getTools(): Tool[] {
    return BUILTIN_TOOLS;
  },
};
