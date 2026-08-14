import { describe, it, expect } from "vitest";
import type { Message, Ref } from "@helios/ports";
import { replaySessionLog, type SessionLogEntry } from "../src/persistence/sessionLog";

const ref: Ref = { kind: "fs", value: "t" };

function node(id: string, parentId: string | null): SessionLogEntry {
  return {
    schemaVersion: 1,
    kind: "node",
    message: { id, role: "user", content: id, parentId } satisfies Message,
  };
}
function head(headId: string | null, cause: "fork" | "rollback"): SessionLogEntry {
  return { schemaVersion: 1, kind: "head", headId, cause };
}
function turn(turnId: string, runIndex: number, anchorNodeId: string | null, messageIds: string[]): SessionLogEntry {
  return {
    schemaVersion: 1,
    kind: "turn",
    turnId,
    runIndex,
    turnIndex: 0,
    checkpointRef: ref,
    anchorNodeId,
    messageIds,
  };
}

describe("replaySessionLog —— node 隐式推进 HEAD", () => {
  it("每条 node 把 HEAD 前移到自身，parentId 原样保留不被重写", () => {
    const r = replaySessionLog([node("u1", null), node("a1", "u1")]);
    expect(r.headId).toBe("a1");
    expect(r.nodes.get("a1")?.parentId).toBe("u1");
    expect(r.nodes.get("u1")?.parentId).toBeNull();
  });

  it("分支结构（同一 parent 两个子节点）完整保留，最后一条 node 决定 HEAD", () => {
    // u1 → a1；再 fork 回 u1 → b1（b1 与 a1 是兄弟）
    const r = replaySessionLog([node("u1", null), node("a1", "u1"), head("u1", "fork"), node("b1", "u1")]);
    expect(r.headId).toBe("b1");
    expect(r.nodes.get("a1")?.parentId).toBe("u1");
    expect(r.nodes.get("b1")?.parentId).toBe("u1");
    expect(r.nodes.size).toBe(3);
  });
});

describe("replaySessionLog —— head 条目显式覆盖", () => {
  it("rollback 的 head 条目把 HEAD 移回锚点，节点一个不删", () => {
    const r = replaySessionLog([node("u1", null), node("a1", "u1"), node("u2", "a1"), head("u1", "rollback")]);
    expect(r.headId).toBe("u1");
    expect(r.nodes.size).toBe(3); // 被回溯的 a1/u2 仍在磁盘、仍可切回
  });

  it("head 指向 null 表示回到空历史", () => {
    const r = replaySessionLog([node("u1", null), head(null, "rollback")]);
    expect(r.headId).toBeNull();
  });

  it("head 指向不存在的节点时报告异常并保持原 HEAD", () => {
    const anomalies: string[] = [];
    const r = replaySessionLog([node("u1", null), head("ghost", "fork")], {
      onAnomaly: (m) => anomalies.push(m),
    });
    expect(r.headId).toBe("u1");
    expect(anomalies).toHaveLength(1);
  });
});

describe("replaySessionLog —— turn 靠 messageIds 重组", () => {
  it("turn 条目按 messageIds 从 nodes 取回消息，runIndex 取最大值", () => {
    const r = replaySessionLog([
      node("u1", null),
      node("a1", "u1"),
      turn("t0", 0, null, ["u1", "a1"]),
      node("u2", "a1"),
      node("a2", "u2"),
      turn("t1", 1, "a1", ["u2", "a2"]),
    ]);
    expect(r.turnLog).toHaveLength(2);
    expect(r.turnLog[0].messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    // 锚点落盘即权威，不再按回放进度重算
    expect(r.turnLog[1].anchorNodeId).toBe("a1");
    expect(r.maxRunIndex).toBe(1);
  });

  it("turn 引用不存在的节点时跳过该消息并报告（崩在 node 与 turn 之间的情形）", () => {
    const anomalies: string[] = [];
    const r = replaySessionLog([node("u1", null), turn("t0", 0, null, ["u1", "missing"])], {
      onAnomaly: (m) => anomalies.push(m),
    });
    expect(r.turnLog[0].messages.map((m) => m.id)).toEqual(["u1"]);
    expect(anomalies).toHaveLength(1);
  });

  it("无 turn 时 maxRunIndex 为 -1", () => {
    expect(replaySessionLog([]).maxRunIndex).toBe(-1);
  });
});

describe("replaySessionLog —— 重复 node id 幂等", () => {
  it("同 id 的 node 出现两次不产生额外节点，HEAD 照常前移", () => {
    const r = replaySessionLog([node("u1", null), node("u1", null), node("a1", "u1")]);
    expect(r.nodes.size).toBe(2);
    expect(r.headId).toBe("a1");
  });
});
