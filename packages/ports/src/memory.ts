import type { MemoryEntry } from "./types";

export const MEMORY_PORT_API_VERSION = 1;

/**
 * 语义化记忆接口（非文件读写）。降级：不加载 → recall 返回空串，
 * system prompt 不注入记忆，对话照常。
 */
export interface MemoryPort {
  recall(query: string): Promise<string>;
  remember(entry: MemoryEntry): Promise<void>;
}
