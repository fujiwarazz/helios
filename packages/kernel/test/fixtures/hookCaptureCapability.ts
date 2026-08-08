import type {
  CapabilityProvider,
  KernelContext,
  HookBinding,
  UserPromptSubmitPayload,
  UserPromptSubmitDecision,
  SessionStartPayload,
  SessionStartDecision,
} from "@helios/ports";
import { CAPABILITY_PROVIDER_API_VERSION } from "@helios/ports";

/** 供测试断言 SessionStart/UserPromptSubmit/SessionEnd 触发次数与 payload。每个 test 用后需清空。 */
export const calls: Array<{ event: string; payload: unknown }> = [];

/** 供测试临时覆写各事件的返回决策；不设置则 handler 只记录不改写。 */
export const behavior: {
  userPromptSubmit?: (p: UserPromptSubmitPayload) => UserPromptSubmitDecision | void;
  sessionStart?: (p: SessionStartPayload) => SessionStartDecision | void;
} = {};

const provider: CapabilityProvider = {
  name: "hookcapture",
  activate() {},
  getHookHandlers(): HookBinding[] {
    return [
      {
        event: "UserPromptSubmit",
        handler: (p) => {
          calls.push({ event: "UserPromptSubmit", payload: p });
          return behavior.userPromptSubmit?.(p);
        },
      },
      {
        event: "SessionStart",
        handler: (p) => {
          calls.push({ event: "SessionStart", payload: p });
          return behavior.sessionStart?.(p);
        },
      },
      {
        event: "SessionEnd",
        handler: (p) => {
          calls.push({ event: "SessionEnd", payload: p });
        },
      },
    ];
  },
};

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;
export function create(_ctx: KernelContext): CapabilityProvider {
  return provider;
}
export default { apiVersion, create };
