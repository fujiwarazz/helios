import type { CapabilityProvider, Tool, KernelContext } from "@helios/ports";
import { CAPABILITY_PROVIDER_API_VERSION } from "@helios/ports";

const echoTool: Tool = {
  name: "echo",
  description: "回显输入文本",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async execute(input) {
    const { text } = input as { text: string };
    return { output: `echo:${text}` };
  },
};

const provider: CapabilityProvider = {
  name: "mock",
  activate() {},
  getTools(): Tool[] {
    return [echoTool];
  },
};

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): CapabilityProvider {
  return provider;
}
export default { apiVersion, create };
