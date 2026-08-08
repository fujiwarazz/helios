import { describe, it, expect } from "vitest";
import type { Message } from "@helios/ports";
import { snapCompactionCut, reconstructPath, type CompactionRecord } from "../src/messageTree";

// 构造一条含 tool 对的路径：u1, a1(tool_use), tr1(toolResult), a2, u2
function toolPath(): Message[] {
  return [
    { id: "u1", role: "user", content: "U1", parentId: null },
    { id: "a1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }], parentId: "u1" },
    { id: "tr1", role: "toolResult", content: [{ type: "tool_result", toolUseId: "t1", output: "ok" }], parentId: "a1" },
    { id: "a2", role: "assistant", content: "A2", parentId: "tr1" },
    { id: "u2", role: "user", content: "U2", parentId: "a2" },
  ];
}

describe("snapCompactionCut —— Q1 不劈裂 tool 对", () => {
  it("覆盖到含 tool_use 的 assistant、其 toolResult 未覆盖时，切点向前吸附，首个保留节点不是 toolResult", () => {
    const path = toolPath();
    // 策略只覆盖 {u1, a1}（把 a1 的 tool_use 圈进，却漏了 tr1）→ 会造成孤儿 tool_result
    const covered = new Set(["u1", "a1"]);
    const idx = snapCompactionCut(path, covered);
    // 未吸附时 idx 会指向 a1(=1)，导致 tail[0]=tr1(toolResult)。吸附后必须 < 1。
    expect(idx).toBeLessThan(1);
    const firstKept = path[idx + 1];
    expect(firstKept?.role).not.toBe("toolResult");
  });

  it("覆盖到完整 tool 对（含 toolResult）时不需要吸附", () => {
    const path = toolPath();
    const covered = new Set(["u1", "a1", "tr1"]); // 完整覆盖 tool 对
    const idx = snapCompactionCut(path, covered);
    expect(idx).toBe(2); // tr1
    expect(path[idx + 1]?.role).toBe("assistant"); // a2，非 toolResult
  });

  it("未覆盖任何节点返回 -1", () => {
    expect(snapCompactionCut(toolPath(), new Set())).toBe(-1);
  });
});

describe("reconstructPath —— 按压缩记录重建有效路径", () => {
  const chainHeadFirst = (): Message[] => [
    { id: "aMain", role: "assistant", content: "AMAIN", parentId: "uMain" },
    { id: "uMain", role: "user", content: "UMAIN", parentId: "a1" },
    { id: "a1", role: "assistant", content: "A1", parentId: "u1" },
    { id: "u1", role: "user", content: "U1", parentId: null },
  ];
  const summary: Message = { id: "sum", role: "user", content: "<compacted_history>\nS\n</compacted_history>", parentId: "u1" };
  const getNode = (id: string) => (id === "sum" ? summary : undefined);

  it("firstPostId 在链上 → summary 取代被覆盖区间，firstKeptId 起保留", () => {
    // 全覆盖 u1（firstKeptId=null），保留从 firstPostId=uMain 起
    const rec: CompactionRecord = { firstPostId: "uMain", summaryId: "sum", firstKeptId: null };
    const path = reconstructPath(chainHeadFirst(), [rec], getNode);
    expect(path.map((m) => m.id)).toEqual(["sum", "uMain", "aMain"]);
    // a1、u1 被覆盖，移出
    expect(path.some((m) => m.id === "a1")).toBe(false);
  });

  it("部分覆盖：firstKeptId=a1 时保留 a1 及其下", () => {
    const rec: CompactionRecord = { firstPostId: "uMain", summaryId: "sum", firstKeptId: "a1" };
    const path = reconstructPath(chainHeadFirst(), [rec], getNode);
    expect(path.map((m) => m.id)).toEqual(["sum", "a1", "uMain", "aMain"]);
  });

  it("firstPostId 不在链上（如兄弟分支）→ 记录不生效，返回完整链", () => {
    const rec: CompactionRecord = { firstPostId: "uOther", summaryId: "sum", firstKeptId: null };
    const path = reconstructPath(chainHeadFirst(), [rec], getNode);
    expect(path.map((m) => m.id)).toEqual(["u1", "a1", "uMain", "aMain"]);
  });

  it("firstPostId 为 null（未回填）→ 记录不生效", () => {
    const rec: CompactionRecord = { firstPostId: null, summaryId: "sum", firstKeptId: null };
    const path = reconstructPath(chainHeadFirst(), [rec], getNode);
    expect(path.map((m) => m.id)).toEqual(["u1", "a1", "uMain", "aMain"]);
  });
});
