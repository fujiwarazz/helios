import type { CapabilityProvider, Tool, KernelContext, ToolRenderer } from "@helios/ports";
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

// 工具最终注册名带 provider 前缀（见 ToolRegistry.add），ToolRenderer.toolName 必须与之一致
// 才能被 kernel.getRenderer(name) 命中——这是给 @helios/host bindSession 测试用的固定装置。
const echoRenderer: ToolRenderer = {
  toolName: "mock__echo",
  render(_input, status, output) {
    return { label: `Echo(${status})`, status, detail: typeof output === "string" ? output : undefined };
  },
};

const provider: CapabilityProvider = {
  name: "mock",
  activate() {},
  getTools(): Tool[] {
    return [echoTool];
  },
  getRenderers(): ToolRenderer[] {
    return [echoRenderer];
  },
};

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): CapabilityProvider {
  return provider;
}
export default { apiVersion, create };
