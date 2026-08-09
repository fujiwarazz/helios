import type { CapabilityProvider, Tool, KernelContext } from "@helios/ports";
import { CAPABILITY_PROVIDER_API_VERSION } from "@helios/ports";

// 可缓存工具：每次真正执行时自增计数器，返回当前计数。session scope + 无 version。
// 用于验证 ToolResultCache：同一 session、同参 → 第二个 run 命中缓存、不再执行（计数不变）。
let counter = 0;

const tool: Tool = {
  name: "cache_probe",
  description: "increments a counter; cacheable at session scope",
  inputSchema: { type: "object", properties: {} },
  cacheable: true,
  cacheScope: "session",
  async execute() {
    counter += 1;
    return { output: `count=${counter}` };
  },
};

const provider: CapabilityProvider = {
  name: "probe",
  activate() {},
  getTools() {
    return [tool];
  },
};

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): CapabilityProvider {
  return provider;
}
export default { apiVersion, create };
