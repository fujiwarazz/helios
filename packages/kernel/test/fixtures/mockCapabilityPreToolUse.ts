import type { CapabilityProvider, Tool, KernelContext, HookBinding, PreToolUseDecision } from "@helios/ports";
import { CAPABILITY_PROVIDER_API_VERSION } from "@helios/ports";

/** 供测试临时覆写 PreToolUse 决策（deny / 改写 input）；每个 test 用后需重置为 undefined。 */
export const behavior: {
  preToolUse?: (input: unknown) => PreToolUseDecision | void;
} = {};

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
  getHookHandlers(): HookBinding[] {
    return [
      {
        event: "PreToolUse",
        handler: (p) => behavior.preToolUse?.(p.input),
      },
    ];
  },
};

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): CapabilityProvider {
  return provider;
}
export default { apiVersion, create };
