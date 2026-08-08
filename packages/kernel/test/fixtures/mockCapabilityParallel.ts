import type { CapabilityProvider, Tool, KernelContext } from "@helios/ports";
import { CAPABILITY_PROVIDER_API_VERSION } from "@helios/ports";

/** 供测试断言并发重叠：每次 execute 记下 [start, end] 时间戳。 */
export const callLog: { name: string; start: number; end: number }[] = [];

function makeParallelTool(name: string, delayMs: number): Tool {
  return {
    name,
    description: `并行测试工具 ${name}`,
    inputSchema: { type: "object", properties: {} },
    executionMode: "parallel",
    async execute() {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, delayMs));
      const end = Date.now();
      callLog.push({ name, start, end });
      return { output: `${name}:done` };
    },
  };
}

const provider: CapabilityProvider = {
  name: "par",
  activate() {},
  getTools(): Tool[] {
    return [makeParallelTool("toolA", 60), makeParallelTool("toolB", 60)];
  },
};

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): CapabilityProvider {
  return provider;
}
export default { apiVersion, create };
