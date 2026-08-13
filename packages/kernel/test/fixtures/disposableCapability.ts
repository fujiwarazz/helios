import { CAPABILITY_PROVIDER_API_VERSION, type KernelContext } from "@helios/ports";

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;
export const disposed: string[] = [];

export function reset(): void {
  disposed.length = 0;
}

export function create(ctx: KernelContext) {
  const id = String(ctx.options?.id ?? "unknown");
  return {
    name: `disposable-${id}`,
    async activate() {},
    async dispose() {
      disposed.push(id);
    },
  };
}

export default { apiVersion, create };
