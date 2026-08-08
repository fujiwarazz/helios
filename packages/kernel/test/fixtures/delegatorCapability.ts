import type { CapabilityProvider, Tool, KernelContext, MultiAgentPort } from "@helios/ports";
import { CAPABILITY_PROVIDER_API_VERSION } from "@helios/ports";

// 一个只依赖 MultiAgentPort 抽象的工具，不关心背后是文件邮箱还是内存直调。
// multiAgent 在 create(ctx) 时闭包进来，execute() 不再摸 ctx（ToolContext 不再带 ports）。
function createDelegateTool(multiAgent: MultiAgentPort): Tool {
  return {
    name: "delegate",
    description: "派生一个 teammate 并发送任务",
    inputSchema: { type: "object", properties: { task: { type: "string" } } },
    async execute(input) {
      const { task } = input as { task?: string };
      const handle = await multiAgent.spawn({ name: "worker", prompt: task ?? "" });
      await multiAgent.send(handle, {
        from: "leader",
        to: handle.name,
        type: "assign",
        payload: { task },
        ts: Date.now(),
      });
      return { output: `delegated to ${handle.name}` };
    },
  };
}

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;
export function create(ctx: KernelContext): CapabilityProvider {
  return {
    name: "delegator",
    activate() {},
    getTools(): Tool[] {
      return [createDelegateTool(ctx.ports.multiAgent)];
    },
  };
}
export default { apiVersion, create };

