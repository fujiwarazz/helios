import type { CapabilityProvider, Tool, KernelContext } from "@helios/ports";
import { CAPABILITY_PROVIDER_API_VERSION } from "@helios/ports";

// 一个只依赖 MultiAgentPort 抽象的工具，不关心背后是文件邮箱还是内存直调。
const delegateTool: Tool = {
  name: "delegate",
  description: "派生一个 teammate 并发送任务",
  inputSchema: { type: "object", properties: { task: { type: "string" } } },
  async execute(input, ctx) {
    const { task } = input as { task?: string };
    const handle = await ctx.ports.multiAgent.spawn({ name: "worker", prompt: task ?? "" });
    await ctx.ports.multiAgent.send(handle, {
      from: "leader",
      to: handle.name,
      type: "assign",
      payload: { task },
      ts: Date.now(),
    });
    return { output: `delegated to ${handle.name}` };
  },
};

const provider: CapabilityProvider = {
  name: "delegator",
  activate() {},
  getTools(): Tool[] {
    return [delegateTool];
  },
};

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): CapabilityProvider {
  return provider;
}
export default { apiVersion, create };
