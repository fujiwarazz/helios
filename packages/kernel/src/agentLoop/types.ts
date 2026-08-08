import type { ContentBlock, Message, Ref } from "@helios/ports";

/** tool_use 内容块的类型别名，供 streamAssistant/executeTools 共用，避免重复 Extract<...>。 */
export type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

/** 单个 turn 的持久化记录，Session（turns.jsonl）与 runTurnLoop 共用同一形状。 */
export interface TurnRecord {
  turnId: string;
  runIndex: number;
  turnIndex: number;
  checkpointRef: Ref;
  /**
   * turn 快照时刻的 HEAD 节点 id（回溯锚点，指向本 turn assistant 之前的节点）。
   * 取代旧的 historyLenBefore：树化后按节点 id 定位比数组下标更稳。
   */
  anchorNodeId: string | null;
  messages: Message[];
}
