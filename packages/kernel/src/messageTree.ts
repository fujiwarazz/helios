import type { Message } from "@helios/ports";

/**
 * 计算压缩安全切点：返回路径上「最后一个被覆盖节点」的下标，并做 Q1 无损吸附。
 *
 * Q1（tool 对不可劈裂）：若切点右侧的首个保留节点是 `toolResult`，说明其配对的 `tool_use`
 * 落在覆盖侧，保留后会成为「无对应 tool_use 的孤儿 tool_result」→ Anthropic Messages API 400。
 * 故把切点向前 pull-back，直到首个保留节点不是 `toolResult`。被拉回的 tool 对留在 tail、
 * 其内容同时进 summary 文本 —— 至多一轮重复，**绝不丢数据**。
 *
 * 返回 -1 表示无可安全压缩（未覆盖任何节点，或吸附后退空）。
 */
export function snapCompactionCut(path: Message[], covered: Set<string>): number {
  let lastCoveredIdx = -1;
  for (let i = 0; i < path.length; i++) {
    if (covered.has(path[i].id)) lastCoveredIdx = i;
  }
  while (lastCoveredIdx >= 0 && path[lastCoveredIdx + 1]?.role === "toolResult") {
    lastCoveredIdx--;
  }
  return lastCoveredIdx;
}

/**
 * 按祖先链上的压缩节点重建发给 LLM 的有效路径（时间正序）。
 *
 * 压缩节点是树上的**真实节点**（parent = 压缩时的 HEAD），因此它在链上的位置天然决定
 * 作用域 —— 从更早节点分叉的兄弟分支祖先链上没有它，压缩不会误伤，无需任何旁路记录
 * 或作用域锚点。
 *
 * @param chainHeadFirst 从 HEAD 沿 parentId 上溯到根的物理链（HEAD 在前，根在后）。
 *
 * 规则：取最靠近 HEAD 的压缩节点（嵌套压缩时最新 summary 文本已并入旧 summary，只需一条）。
 * 该节点之后追加的节点（更靠 HEAD）原样保留；该节点的祖先里，`firstKeptId` 及其之下
 * （更新的）作为保留 tail，更早的被 summary 取代。
 * 输出顺序：summary（代表最老的被压缩区间）→ 保留 tail → 压缩后新增。
 */
export function buildLlmPath(chainHeadFirst: Message[]): Message[] {
  const boundary = chainHeadFirst.findIndex((n) => n.compaction);
  if (boundary < 0) return [...chainHeadFirst].reverse();

  const summary = chainHeadFirst[boundary];
  const newer = chainHeadFirst.slice(0, boundary); // 压缩后追加的（head-first）
  const older = chainHeadFirst.slice(boundary + 1); // summary 的祖先（head-first）

  const firstKeptId = summary.compaction?.firstKeptId ?? null;
  const keptIdx = firstKeptId === null ? -1 : older.findIndex((n) => n.id === firstKeptId);
  // keptIdx < 0：全覆盖（firstKeptId=null），或 firstKeptId 已不在链上（理论不可达，
  // 因为保留 tail 恒为 summary 的祖先）—— 两种情况都退化为「只留 summary」，不丢新增部分。
  const keptTail = keptIdx < 0 ? [] : older.slice(0, keptIdx + 1);

  return [summary, ...[...keptTail].reverse(), ...[...newer].reverse()];
}
