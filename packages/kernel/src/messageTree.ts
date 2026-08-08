import type { Message } from "@helios/ports";

/**
 * 一条分支的压缩记录。核心思想：压缩**不改物理树**（不 mutate 既有节点 parentId、不移 HEAD），
 * 只记录「在某个 HEAD 处，用 summary 节点取代其上游被覆盖区间」，由 `reconstructPath` 按此重建
 * 发给 LLM 的有效路径。这样兄弟分支（从更早节点分叉、其祖先链上没有 `firstPostId`）天然不受影响。
 */
export interface CompactionRecord {
  /**
   * 作用域锚点 = 压缩后本分支追加的**首个节点 id**（通常是紧随压缩的 userMsg）。
   * 仅当它在当前 HEAD 的祖先链上时本记录才生效。
   * 关键：必须用「压缩后新增、唯一属于本分支」的节点，**不能用压缩时的 HEAD**——后者可能是
   * 被多分支共享的 fork 点，会导致压缩误伤兄弟分支（Q3）。压缩时先置 null，追加首节点后回填。
   */
  firstPostId: string | null;
  /** summary 节点 id。 */
  summaryId: string;
  /** 部分覆盖时保留 tail 的首节点 id（其及其之下保留）；全覆盖为 null（保留从 firstPostId 起）。 */
  firstKeptId: string | null;
}

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
 * 按压缩记录重建有效路径（LLM 只看这条）。
 *
 * @param chainHeadFirst 从 HEAD 沿 parentId 上溯到根的物理链（HEAD 在前，根在后）。
 *   物理节点的 parent 永远是物理节点，summary 从不作为物理父，故此链不含 summary 节点。
 * @param records 压缩记录（创建顺序）。
 * @param getNode 取节点内容用（重建 summary 节点）。
 *
 * 规则：取「创建顺序最靠后、且 `firstPostId` 在链上」的记录（深者胜；嵌套压缩时最新 summary
 * 文本上已并入旧 summary，故只取最新一条即可）。无匹配（含 firstPostId 尚未回填=null）→ 时间正序整条链。
 */
export function reconstructPath(
  chainHeadFirst: Message[],
  records: CompactionRecord[],
  getNode: (id: string) => Message | undefined,
): Message[] {
  const chainIds = new Set(chainHeadFirst.map((n) => n.id));
  let rec: CompactionRecord | undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    const fp = records[i].firstPostId;
    if (fp !== null && chainIds.has(fp)) {
      rec = records[i];
      break;
    }
  }
  if (!rec) return [...chainHeadFirst].reverse();

  const summary = getNode(rec.summaryId);
  // 保留边界：部分覆盖=firstKeptId（含其下）；全覆盖=firstPostId 起（压缩后新增，firstPostId 严格之上=被覆盖）。
  const boundaryId = rec.firstKeptId ?? rec.firstPostId;
  const bIdx = chainHeadFirst.findIndex((n) => n.id === boundaryId);
  // 保留 boundary（含）及其之下（更新的节点）；boundary 严格之上的节点即被覆盖区间，由 summary 取代。
  const keptHeadFirst =
    bIdx < 0
      ? [...chainHeadFirst] // 理论不可达：firstPostId 在链上则 boundary 也应在链上
      : chainHeadFirst.slice(0, bIdx + 1);
  const kept = keptHeadFirst.reverse();
  return summary ? [summary, ...kept] : kept;
}
