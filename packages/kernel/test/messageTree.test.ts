import { describe, it, expect } from "vitest";
import type { Message } from "@helios/ports";
import { snapCompactionCut, buildLlmPath } from "../src/messageTree";

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

describe("buildLlmPath —— 按链上压缩节点重建有效路径", () => {
  /**
   * 物理链（head-first）：aMain ← uMain ← sum ← a1 ← u1
   * 即：u1 → a1 上跑过一轮；压缩时 HEAD=a1，summary 挂在 a1 之下；之后追加 uMain → aMain。
   * 保留 tail 是 summary 的**祖先**（a1 及其之下），这是 summary.parentId = 压缩时 HEAD
   * 带来的性质 —— 若把 summary 挂到「最后一个被覆盖节点」，tail 会变成 summary 的兄弟
   * 子树而脱离祖先链，整段丢失。
   */
  const chainWith = (firstKeptId: string | null): Message[] => [
    { id: "aMain", role: "assistant", content: "AMAIN", parentId: "uMain" },
    { id: "uMain", role: "user", content: "UMAIN", parentId: "sum" },
    {
      id: "sum",
      role: "user",
      content: "<compacted_history>\nS\n</compacted_history>",
      parentId: "a1",
      compaction: { firstKeptId },
    },
    { id: "a1", role: "assistant", content: "A1", parentId: "u1" },
    { id: "u1", role: "user", content: "U1", parentId: null },
  ];

  it("全覆盖（firstKeptId=null）→ 只留 summary + 压缩后新增", () => {
    const path = buildLlmPath(chainWith(null));
    expect(path.map((m) => m.id)).toEqual(["sum", "uMain", "aMain"]);
    expect(path.some((m) => m.id === "a1" || m.id === "u1")).toBe(false);
  });

  it("部分覆盖（firstKeptId=a1）→ 保留 a1，更早的 u1 被 summary 取代", () => {
    const path = buildLlmPath(chainWith("a1"));
    expect(path.map((m) => m.id)).toEqual(["sum", "a1", "uMain", "aMain"]);
  });

  it("链上无压缩节点（如兄弟分支）→ 返回完整链的时间正序", () => {
    const chain: Message[] = [
      { id: "sib", role: "assistant", content: "SIB", parentId: "a1" },
      { id: "a1", role: "assistant", content: "A1", parentId: "u1" },
      { id: "u1", role: "user", content: "U1", parentId: null },
    ];
    expect(buildLlmPath(chain).map((m) => m.id)).toEqual(["u1", "a1", "sib"]);
  });

  it("压缩节点恰为 HEAD（压缩后尚未追加消息）→ 路径以 summary 起头", () => {
    const chain = chainWith("a1").slice(2); // 去掉 uMain/aMain，sum 成为 HEAD
    expect(buildLlmPath(chain).map((m) => m.id)).toEqual(["sum", "a1"]);
  });

  it("嵌套压缩：只取最靠近 HEAD 的压缩节点（旧 summary 文本已并入新 summary）", () => {
    const chain: Message[] = [
      { id: "u3", role: "user", content: "U3", parentId: "sum2" },
      { id: "sum2", role: "user", content: "S2", parentId: "u2", compaction: { firstKeptId: "u2" } },
      { id: "u2", role: "user", content: "U2", parentId: "sum1" },
      { id: "sum1", role: "user", content: "S1", parentId: "u1", compaction: { firstKeptId: null } },
      { id: "u1", role: "user", content: "U1", parentId: null },
    ];
    expect(buildLlmPath(chain).map((m) => m.id)).toEqual(["sum2", "u2", "u3"]);
  });

  it("空链返回空数组", () => {
    expect(buildLlmPath([])).toEqual([]);
  });
});
