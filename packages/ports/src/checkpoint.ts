import type { Ref } from "./types";

export const CHECKPOINT_PORT_API_VERSION = 1;

/**
 * Turn 级文件快照。降级：不加载 → 回溯只截断对话历史，不还原文件。
 */
export interface CheckpointPort {
  snapshot(turnId: string): Promise<Ref>;
  restore(ref: Ref): Promise<void>;
}
