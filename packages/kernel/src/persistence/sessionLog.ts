// ============================================================================
// packages/kernel/src/persistence/sessionLog.ts
// 会话的 append-only 磁盘日志格式 + 纯回放函数。
//
// 旧格式的问题：turns.jsonl 每 turn 全量重写（O(n²)），且回放时 appendNode 会用
// 当前 HEAD 覆盖磁盘上的 parentId —— 树被线性化，分支跨 resume 全丢；rollback 还会
// 截断文件物理删除消息。新格式一行一个事实、只追加，parentId 原样落盘。
// ============================================================================

import type { Message, Ref } from "@helios/ports";
import type { TurnRecord } from "../agentLoop/types";

/** 一条消息节点。parentId 原样落盘，回放时不再重写。 */
export interface NodeLogEntry {
  schemaVersion: 1;
  kind: "node";
  message: Message;
}

/**
 * 非追加型的 HEAD 移动。普通追加（appendNode）不写此条目 —— 回放时每条 node
 * 隐式把 HEAD 前移到自身，只有 fork/rollback 这类"跳走"才需要显式记录。
 */
export interface HeadLogEntry {
  schemaVersion: 1;
  kind: "head";
  headId: string | null;
  cause: "fork" | "rollback";
}

/**
 * 一个已完成 turn 的元数据。只存 messageIds 引用对应的 node 条目，不重复消息体
 * （旧格式把同一批 Message 同时放在 nodes 和 TurnRecord.messages 里）。
 */
export interface TurnLogEntry {
  schemaVersion: 1;
  kind: "turn";
  turnId: string;
  runIndex: number;
  turnIndex: number;
  checkpointRef: Ref;
  anchorNodeId: string | null;
  messageIds: string[];
}

export type SessionLogEntry = NodeLogEntry | HeadLogEntry | TurnLogEntry;

export const SESSION_LOG_FILE = "log.jsonl";

export interface ReplayResult {
  /** 全部节点（含所有分支、含 summary 节点），id → Message。 */
  nodes: Map<string, Message>;
  /** 回放结束时的 HEAD。 */
  headId: string | null;
  /** 所有分支上跑过的所有 turn（只增，rollback 不再截断）。 */
  turnLog: TurnRecord[];
  /** 已用过的最大 runIndex；无 turn 时为 -1（调用方 runIndex = max + 1）。 */
  maxRunIndex: number;
}

export interface ReplayOptions {
  /** 语义上有问题（而非语法坏行）的条目回调，如 turn 引用了不存在的 node。 */
  onAnomaly?(message: string): void;
}

/**
 * 回放日志重建树状态。纯函数，不碰文件系统 —— 便于对「node 隐式推进 HEAD vs head
 * 条目显式覆盖」「turn 靠 messageIds 重组」「重复 node id 幂等」这些易错点做单测。
 */
export function replaySessionLog(
  entries: readonly SessionLogEntry[],
  options: ReplayOptions = {},
): ReplayResult {
  const onAnomaly = options.onAnomaly ?? ((): void => undefined);
  const nodes = new Map<string, Message>();
  const turnLog: TurnRecord[] = [];
  let headId: string | null = null;
  let maxRunIndex = -1;

  for (const entry of entries) {
    switch (entry.kind) {
      case "node": {
        const msg = entry.message;
        // 重复 id 是无害幂等（同一条消息可能被两个 turn 的 messages 都带到，写侧已去重，
        // 但历史日志或并发写仍可能出现）：覆盖为同一内容，HEAD 照常前移。
        nodes.set(msg.id, msg);
        headId = msg.id;
        break;
      }
      case "head": {
        if (entry.headId !== null && !nodes.has(entry.headId)) {
          onAnomaly(`head 条目指向不存在的节点 ${entry.headId}，跳过`);
          break;
        }
        headId = entry.headId;
        break;
      }
      case "turn": {
        const messages: Message[] = [];
        for (const id of entry.messageIds) {
          const msg = nodes.get(id);
          if (!msg) {
            onAnomaly(`turn ${entry.turnId} 引用了不存在的节点 ${id}，跳过该消息`);
            continue;
          }
          messages.push(msg);
        }
        turnLog.push({
          schemaVersion: 1,
          turnId: entry.turnId,
          runIndex: entry.runIndex,
          turnIndex: entry.turnIndex,
          checkpointRef: entry.checkpointRef,
          // 落盘即权威：parentId 现在可信，turn 创建时记的锚点就是真相，不再重算。
          anchorNodeId: entry.anchorNodeId,
          messages,
        });
        if (entry.runIndex > maxRunIndex) maxRunIndex = entry.runIndex;
        break;
      }
    }
  }

  return { nodes, headId, turnLog, maxRunIndex };
}
