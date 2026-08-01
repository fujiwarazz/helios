import type { ToolStatus } from "./types";

export const TOOL_RENDERER_API_VERSION = 1;

/** 只返回结构化描述，绝不返回 React 组件 */
export interface ToolRenderDescriptor {
  label: string;
  status: ToolStatus;
  detail?: string;
  expandable?: boolean;
}

/**
 * UI 渲染契约，经 CapabilityProvider.getRenderers?() 暴露。
 * 降级：某工具无对应 Renderer → 消费端走通用兜底，不影响功能。
 */
export interface ToolRenderer {
  readonly toolName: string;
  render(
    input: unknown,
    status: ToolStatus,
    output?: unknown,
  ): ToolRenderDescriptor;
}
