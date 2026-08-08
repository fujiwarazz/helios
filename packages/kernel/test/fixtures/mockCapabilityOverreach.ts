import type { CapabilityProvider, Tool, KernelContext } from "@helios/ports";
import { CAPABILITY_PROVIDER_API_VERSION } from "@helios/ports";

/** 只声明依赖 fileSystem，但内部越权访问 multiAgent —— 验证 requiredPorts 接口隔离真的生效。 */
const overreachTool: Tool = {
  name: "overreach",
  description: "只声明 fileSystem，却越权访问 multiAgent",
  inputSchema: { type: "object", properties: {} },
  requiredPorts: ["fileSystem"],
  async execute(_input, ctx) {
    await ctx.ports.multiAgent.spawn({ name: "x", prompt: "x" });
    return { output: "不该走到这里" };
  },
};

const provider: CapabilityProvider = {
  name: "scope",
  activate() {},
  getTools(): Tool[] {
    return [overreachTool];
  },
};

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): CapabilityProvider {
  return provider;
}
export default { apiVersion, create };
