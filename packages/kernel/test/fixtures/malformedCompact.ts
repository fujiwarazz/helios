import type { KernelContext } from "@helios/ports";
import { COMPACT_STRATEGY_PORT_API_VERSION } from "@helios/ports";

// 缺少 compact() 方法，shape 校验应失败并跳过该插件。
export const apiVersion = COMPACT_STRATEGY_PORT_API_VERSION;
export function create(_ctx: KernelContext): unknown {
  return { shouldCompact: () => false };
}
export default { apiVersion, create };
