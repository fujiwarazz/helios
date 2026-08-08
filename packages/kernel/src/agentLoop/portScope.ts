import type { PortName, PortRegistry } from "@helios/ports";

/**
 * 按工具声明的 `requiredPorts` 裁剪 `PortRegistry`：未声明的 Port 类型上仍是完整形状，
 * 但运行时访问会抛错——防止工具拿到自己没申报要用的能力（接口隔离，CR 意见）。
 * `requiredPorts` 缺省（undefined）= 不裁剪，原样放行全量 ports（兼容未声明该字段的
 * CapabilityProvider 自带工具，这类工具目前都不读 `ctx.ports`，不受影响）。
 */
export function scopePorts(ports: PortRegistry, requiredPorts: readonly PortName[] | undefined): PortRegistry {
  if (!requiredPorts) return ports;
  const allowed = new Set<PortName>(requiredPorts);
  return new Proxy(ports, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in target && !allowed.has(prop as PortName)) {
        throw new Error(
          `工具未声明依赖 Port「${prop}」，禁止访问（requiredPorts 未包含该项）。`,
        );
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as PortRegistry;
}
