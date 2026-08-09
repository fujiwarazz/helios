import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Message,
  PortRegistry,
  Logger,
  LLMOptions,
  AskQuestionRequest,
  AskQuestionResponse,
  ConversationState,
} from "@helios/ports";
import { ToolRegistry } from "./toolRegistry";
import { HookRunner } from "./hookRunner";
import { uid } from "./ids";
import type { AgentEvent, AgentEventListener } from "./events";
import { snapCompactionCut, reconstructPath, type CompactionRecord } from "./messageTree";
import { runTurnLoop } from "./agentLoop/runTurnLoop";
import type { TurnRecord } from "./agentLoop/types";

/** 压缩记录的磁盘形态（含 summary 节点内容，跨 resume 恢复压缩视图）。 */
interface PersistedCompaction {
  firstPostId: string | null;
  summaryId: string;
  firstKeptId: string | null;
  summaryContent: string;
  summaryParentId: string | null;
}

export interface SessionOptions {
  id: string;
  workDir: string;
  ports: PortRegistry;
  tools: ToolRegistry;
  hooks: HookRunner;
  logger: Logger;
  llmOptions: LLMOptions;
  system: string;
  askQuestion(req: AskQuestionRequest): Promise<AskQuestionResponse>;
  /** 单次 run 内最大 turn 数，防失控 */
  maxTurns?: number;
}

/** 会话元数据，落 `<workDir>/.helios/sessions/<id>/meta.json`，供列表展示与 resume。 */
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastRunIndex: number;
  lastTurnIndex: number;
}

/** 分支信息：叶子节点 id + 从根到该叶子的深度。 */
export interface BranchInfo {
  leafId: string;
  depth: number;
}

export class Session {
  readonly id: string;
  /**
   * 消息树：节点只增不删。`headId` 指向当前对话末端，LLM 只看 `pathToHead()`。
   * 回溯/切分支只移动 HEAD，从不删节点 —— 旧分支永远可以切回去。
   */
  private readonly nodes = new Map<string, Message>();
  private headId: string | null = null;
  /**
   * 压缩记录（创建顺序）：压缩不改物理树，只记录「某 HEAD 处用 summary 取代其上游被覆盖区间」。
   * `pathToHead` 按记录重建有效路径；作用域由 `firstPostId`（压缩后本分支追加的首个节点）是否在
   * 当前 HEAD 祖先链上决定，因此兄弟分支（从更早节点分叉）不受影响。详见 messageTree.ts。
   */
  private readonly compactions: CompactionRecord[] = [];
  /** summary 节点 id 集合：listBranches 据此排除 summary（否则会成幽灵分支叶子）。 */
  private readonly summaryIds = new Set<string>();
  private runIndex = 0;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly maxTurns: number;
  /** 已完成 turn 的持久化记录，供 rollback 定位快照与重写 turns.jsonl */
  private readonly turnLog: TurnRecord[] = [];
  /**
   * 冻结的 system 前缀（base system + memory 召回），每会话只算一次。
   * 缓存纪律一：不每 run recall，避免 system 前缀漂移导致 prompt cache 永不命中。
   */
  private systemPrefix: string | null = null;
  /** 当前 run 的中断控制器，其 signal 贯通到工具（Bash/WebFetch），支持 cancel。 */
  private currentAbort: AbortController | null = null;
  private createdAt = Date.now();
  private title = "";
  /** SessionStart 是否已懒触发（仅首次 sendMessage() 触发一次，与 systemPrefix 冻结时机一致）。 */
  private sessionStarted = false;
  /** restore() 是否命中历史记录；供 SessionStart payload.resumed 使用。 */
  private wasResumed = false;
  /** SessionStart handler 返回的 additionalContext，随 systemPrefix 一起冻结注入。 */
  private sessionStartContext: string | undefined;

  constructor(private readonly opts: SessionOptions) {
    this.id = opts.id;
    this.maxTurns = opts.maxTurns ?? 25;
  }

  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  /** 中断当前 run：触发 signal，让正在执行的工具（Bash/WebFetch）尽快停止。 */
  cancel(): void {
    this.currentAbort?.abort();
  }

  /**
   * 标记本次运行时生命周期结束（如宿主侧连接关闭），触发 SessionEnd 通知型 hook。
   * 会话数据仍留在磁盘可 resume，本方法不删除/清理任何状态，纯粹是生命周期通知点。
   */
  async dispose(): Promise<void> {
    await this.opts.hooks.runSessionEnd({ sessionId: this.id, workDir: this.opts.workDir });
  }

  // -------------------------------------------------------------------------
  // 消息树核心
  // -------------------------------------------------------------------------

  /** 从 HEAD 沿 parentId 上溯到根的物理链（HEAD 在前）。物理父恒为物理节点，链中不含 summary。 */
  private ancestorChain(from: string | null): Message[] {
    const chain: Message[] = [];
    let cur = from;
    while (cur) {
      const n = this.nodes.get(cur);
      if (!n) break;
      chain.push(n);
      cur = n.parentId ?? null;
    }
    return chain;
  }

  /** 发给 LLM 的有效路径（时间正序）：按压缩记录在物理链上重建，summary 替换被覆盖区间。 */
  private pathToHead(): Message[] {
    const chain = this.ancestorChain(this.headId);
    return reconstructPath(chain, this.compactions, (id) => this.nodes.get(id));
  }

  /** 唯一顺序写入口：把 parentId 指向当前 HEAD，落库并前移 HEAD。 */
  private appendNode(msg: Message): void {
    msg.parentId = this.headId;
    this.nodes.set(msg.id, msg);
    this.headId = msg.id;
  }

  /** 移动 HEAD（回溯/切分支/压缩共用）。允许 null（回到空历史）。 */
  private moveHead(nodeId: string | null): void {
    if (nodeId !== null && !this.nodes.has(nodeId)) {
      throw new Error(`node 不存在: ${nodeId}`);
    }
    this.headId = nodeId;
    this.emit({ type: "head_changed", headId: nodeId });
  }

  getHistory(): Message[] {
    return this.pathToHead();
  }

  /** 回到某个历史节点继续对话：只移 HEAD，不删任何节点（旧子树保留，随时可切回）。 */
  fork(nodeId: string): void {
    if (!this.nodes.has(nodeId)) throw new Error(`node 不存在: ${nodeId}`);
    this.moveHead(nodeId);
  }

  /** 切换到某条分支的叶子（语义等同 fork 到该叶子）。 */
  switchBranch(leafId: string): void {
    this.fork(leafId);
  }

  /** 枚举所有分支叶子（无子节点的节点）及其深度，供分支切换 UI。 */
  listBranches(): BranchInfo[] {
    const hasChild = new Set<string>();
    for (const n of this.nodes.values()) {
      if (n.parentId) hasChild.add(n.parentId);
    }
    const branches: BranchInfo[] = [];
    for (const n of this.nodes.values()) {
      if (hasChild.has(n.id)) continue; // 非叶子跳过
      if (this.summaryIds.has(n.id)) continue; // summary 节点不是真实分支
      let depth = 0;
      let cur: string | null = n.id;
      while (cur) {
        depth++;
        cur = this.nodes.get(cur)?.parentId ?? null;
      }
      branches.push({ leafId: n.id, depth });
    }
    return branches;
  }

  // -------------------------------------------------------------------------
  // run 主循环
  // -------------------------------------------------------------------------

  /** 发送一条用户消息，驱动一个完整 run（agent_start → 多 turn → agent_end）。 */
  async sendMessage(text: string): Promise<Message[]> {
    const { ports, hooks, logger } = this.opts;

    // UserPromptSubmit：提交后、进入 LLM 前。可 block（不进入循环）/ 改写文本 / 追加上下文。
    const submitDecision = await hooks.runUserPromptSubmit({ sessionId: this.id, text });
    if (submitDecision.block) {
      const rejectRunId = uid("run");
      this.emit({ type: "agent_start", runId: rejectRunId });
      const rejected: Message = {
        id: uid("msg"),
        role: "system",
        content: submitDecision.reason ?? "用户输入被 Hook 拒绝",
      };
      this.appendNode(rejected);
      this.emit({ type: "agent_end", runId: rejectRunId, turnIds: [], newMessages: [rejected], error: submitDecision.reason });
      return [rejected];
    }
    text = submitDecision.text ?? text;

    // SessionStart：懒触发，仅首次 sendMessage() 调用一次（对齐 valos session.start() 内触发时机）。
    if (!this.sessionStarted) {
      this.sessionStarted = true;
      const startDecision = await hooks.runSessionStart({
        sessionId: this.id,
        workDir: this.opts.workDir,
        source: this.wasResumed ? "resume" : "startup",
      });
      this.sessionStartContext = startDecision.additionalContext;
    }

    const runId = uid("run");
    const runIndex = this.runIndex++;
    if (!this.title) this.title = text.slice(0, 60);

    const abort = new AbortController();
    this.currentAbort = abort;

    this.emit({ type: "agent_start", runId });

    // run 开始前：对当前路径按策略压缩（生成 summary 节点 + 压缩记录；不改物理树、不移 HEAD）。
    const pendingCompaction = await this.maybeCompact();

    // 缓存纪律一：system 前缀（base + memory 召回 + SessionStart 注入）每会话只算一次并冻结，之后每 run 复用。
    if (this.systemPrefix === null) {
      const recalled = await ports.memory.recall(text);
      const parts = [this.opts.system];
      if (recalled) parts.push(`<memory>\n${recalled}\n</memory>`);
      if (this.sessionStartContext) parts.push(`<hook-context>\n${this.sessionStartContext}\n</hook-context>`);
      this.systemPrefix = parts.join("\n\n");
    }
    const system = this.systemPrefix;

    // 本 run 新增消息的起点：压缩后有效路径长度（compaction-safe，等价旧线性 history.length 切片）。
    const before = this.pathToHead().length;

    const userContent = submitDecision.additionalContext
      ? `${text}\n\n<hook-context>\n${submitDecision.additionalContext}\n</hook-context>`
      : text;
    const userMsg: Message = { id: uid("msg"), role: "user", content: userContent };
    this.appendNode(userMsg);
    // 广播用户消息事件：让订阅端(UI)在 run 进行中即可显示用户气泡，无需等 run 结束 getHistory。
    // 用户文本不流式，一次性 start+delta+end。
    this.emit({ type: "message_start", messageId: userMsg.id, role: "user", turnId: "" });
    this.emit({ type: "message_update", messageId: userMsg.id, delta: { type: "text-delta", text } });
    this.emit({ type: "message_end", messageId: userMsg.id, role: "user" });

    // 回填压缩记录的作用域锚点 = 压缩后本分支追加的首个节点（唯一属于本分支，避免误伤兄弟分支）。
    if (pendingCompaction) {
      pendingCompaction.firstPostId = userMsg.id;
      try {
        await this.writeCompactions();
      } catch (err) {
        this.opts.logger.warn(`压缩记录持久化失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const { turnIds, runError, reachedMaxTurns } = await runTurnLoop({
      deps: {
        provider: ports.llm.get(this.opts.llmOptions.provider),
        toolRegistry: this.opts.tools,
        hooks,
        sessionId: this.id,
        workDir: this.opts.workDir,
        logger,
        askQuestion: this.opts.askQuestion,
        signal: abort.signal,
        events: { emit: (e) => this.emit(e) },
        // Cost-aware Runtime：均有 noop 兜底，缺失即等价关闭该能力。
        modelRouter: ports.modelRouter,
        costMeter: ports.costMeter,
        toolCache: ports.toolCache,
        versionProvider: ports.versionProvider,
        llmRegistry: ports.llm,
      },
      tree: {
        appendNode: (msg) => this.appendNode(msg),
        currentHeadId: () => this.headId,
        pathToHead: () => this.pathToHead(),
        snapshotCheckpoint: (turnId) => ports.checkpoint.snapshot(turnId),
        persistTurn: (record) => this.persistTurn(record),
      },
      turnIdPrefix: `${this.id}-${runIndex}`,
      runId,
      runIndex,
      maxTurns: this.maxTurns,
      system,
      llmOptions: this.opts.llmOptions,
      pendingLeadMessages: [userMsg],
    });

    // Bug 5：因达到 turn 上限（而非自然结束）退出 → 记录并在 agent_end 标注，避免静默截断。
    if (reachedMaxTurns) {
      logger.warn(`run ${runId} 达到 turn 上限 ${this.maxTurns}，提前结束`);
    }

    const newMessages = this.pathToHead().slice(before);
    // CostMeter 收尾：记录任务结果并产出成本报告（noop 时为全零报告）。
    const outcomeStatus: "success" | "failure" | "cancelled" = abort.signal.aborted
      ? "cancelled"
      : runError
        ? "failure"
        : "success";
    ports.costMeter.setOutcome(runId, { status: outcomeStatus });
    const costReport = ports.costMeter.report(runId);
    if (this.currentAbort === abort) this.currentAbort = null; // 清理本 run 的中断控制器
    this.emit({
      type: "agent_end",
      runId,
      turnIds,
      newMessages,
      error: runError,
      reachedMaxTurns: reachedMaxTurns || undefined,
      costReport,
    });
    logger.debug(`run ${runId} 完成，共 ${turnIds.length} 个 turn`);
    return newMessages;
  }

  /**
   * run 开始前的历史压缩（压缩记录化）：把被压缩区间浓缩为一个 summary 节点，并记一条 CompactionRecord，
   * 由 pathToHead 按记录重建有效路径。**不 mutate 任何既有节点、不移 HEAD** —— 兄弟分支天然不受影响，
   * 旧节点一个不删仍可回溯。summary 节点只装摘要文本，不含 system/tools（那是独立稳定前缀，复制进节点
   * 会砸 cache 且 token 翻倍）。CompactStrategyPort 未加载时 shouldCompact 恒 false。
   */
  private async maybeCompact(): Promise<CompactionRecord | null> {
    const path = this.pathToHead();
    if (path.length === 0) return null;
    const { ports } = this.opts;
    const state: ConversationState = {
      messages: path,
      approxTokens: approxTokens(path),
    };
    if (!ports.compact.shouldCompact(state)) return null;

    this.emit({ type: "compact_start", messageCount: path.length });
    const summary = await ports.compact.compact([...path]);
    const covered = new Set(summary.coveredMessageIds);

    // 安全切点（含 Q1 吸附：首个保留节点绝不为 toolResult，杜绝孤儿 tool_result → Anthropic 400）。
    const lastCoveredIdx = snapCompactionCut(path, covered);
    if (lastCoveredIdx < 0) {
      // 无可安全压缩（未覆盖任何节点，或吸附后退空）：空过。
      this.emit({ type: "compact_end", summaryLength: summary.text.length, remaining: path.length });
      return null;
    }

    const summaryNode: Message = {
      id: uid("msg"),
      role: "user",
      content: `<compacted_history>\n${summary.text}\n</compacted_history>`,
      parentId: path[lastCoveredIdx].id, // 仅存血缘/归档；pathToHead 不走此指针
    };
    this.nodes.set(summaryNode.id, summaryNode);
    this.summaryIds.add(summaryNode.id);

    // 压缩记录化：不 mutate 任何既有节点、不移 HEAD（兄弟分支天然不受影响，Q3 修复核心）。
    // firstPostId 待 sendMessage 追加 userMsg 后回填（作用域锚点必须唯一属于本分支）。
    const tail = path.slice(lastCoveredIdx + 1);
    const record: CompactionRecord = {
      firstPostId: null,
      summaryId: summaryNode.id,
      firstKeptId: tail[0]?.id ?? null,
    };
    this.compactions.push(record);

    // summary(1) + 保留 tail 长度；firstPostId 尚未回填，故不能用 pathToHead 现算。
    const remaining = 1 + tail.length;
    this.emit({ type: "compact_end", summaryLength: summary.text.length, remaining });
    return record;
  }

  private async persistTurn(record: TurnRecord): Promise<void> {
    this.turnLog.push(record);
    try {
      await this.writeTurnLog();
      await this.writeMeta();
    } catch (err) {
      this.opts.logger.warn(`turn 持久化失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private turnsDir(): string {
    return join(this.opts.workDir, ".helios", "sessions", this.id);
  }

  private async writeTurnLog(): Promise<void> {
    const dir = this.turnsDir();
    await mkdir(dir, { recursive: true });
    const body = this.turnLog.map((r) => JSON.stringify(r)).join("\n");
    await writeFile(join(dir, "turns.jsonl"), body ? body + "\n" : "", "utf8");
  }

  private async writeMeta(): Promise<void> {
    const dir = this.turnsDir();
    await mkdir(dir, { recursive: true });
    const last = this.turnLog[this.turnLog.length - 1];
    const meta: SessionMeta = {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      lastRunIndex: last?.runIndex ?? -1,
      lastTurnIndex: last?.turnIndex ?? -1,
    };
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  }

  /** 全量重写压缩记录（含 summary 节点内容），供跨 resume 恢复压缩视图。 */
  private async writeCompactions(): Promise<void> {
    const dir = this.turnsDir();
    await mkdir(dir, { recursive: true });
    const body = this.compactions
      .map((c) => {
        const node = this.nodes.get(c.summaryId);
        const rec: PersistedCompaction = {
          firstPostId: c.firstPostId,
          summaryId: c.summaryId,
          firstKeptId: c.firstKeptId,
          summaryContent: typeof node?.content === "string" ? node.content : "",
          summaryParentId: node?.parentId ?? null,
        };
        return JSON.stringify(rec);
      })
      .join("\n");
    await writeFile(join(dir, "compactions.jsonl"), body ? body + "\n" : "", "utf8");
  }

  /**
   * 从磁盘 resume：读回 turns.jsonl 全量回放重建消息树 + turnLog，读 meta.json 恢复
   * title/createdAt，并把 runIndex 续到最大已用 run 之后（新 run index 自然递增不冲突）。
   * 关键：anchorNodeId 按回放时的 HEAD **重算**（指向该 turn 全部消息之前的节点），
   * 使 resume 后的 rollback 锚点与重建后的树严格一致。
   * 注：分支/压缩边界为内存态，当前不持久化（旧分支跨 resume 不保留，与旧实现行为一致）。
   * 返回是否加载到任何 turn。
   */
  async restore(): Promise<boolean> {
    const dir = this.turnsDir();
    // meta（可选）
    try {
      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as SessionMeta;
      if (typeof meta.createdAt === "number") this.createdAt = meta.createdAt;
      if (typeof meta.title === "string") this.title = meta.title;
    } catch {
      // 无 meta 或损坏：忽略，用默认值
    }
    // turns.jsonl（权威）
    let raw = "";
    try {
      raw = await readFile(join(dir, "turns.jsonl"), "utf8");
    } catch {
      return false;
    }
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return false;

    this.nodes.clear();
    this.headId = null;
    this.compactions.length = 0;
    this.summaryIds.clear();
    this.turnLog.length = 0;
    let maxRunIndex = -1;
    for (const line of lines) {
      let rec: TurnRecord;
      try {
        rec = JSON.parse(line) as TurnRecord;
      } catch {
        this.opts.logger.warn(`跳过损坏的 turn 记录：${line.slice(0, 80)}`);
        continue;
      }
      // 锚点 = 追加本 turn 消息之前的 HEAD（按回放进度重算）。
      rec.anchorNodeId = this.headId;
      for (const m of rec.messages ?? []) {
        this.appendNode(m); // 线性重建：parentId 按回放顺序重写
      }
      this.turnLog.push(rec);
      if (rec.runIndex > maxRunIndex) maxRunIndex = rec.runIndex;
    }
    this.runIndex = maxRunIndex + 1;

    // 压缩记录（可选文件）：重建 summary 节点 + 记录，恢复压缩视图。老会话无此文件 → 跳过（向后兼容）。
    try {
      const rawC = await readFile(join(dir, "compactions.jsonl"), "utf8");
      for (const line of rawC.split("\n").filter((l) => l.trim())) {
        let pc: PersistedCompaction;
        try {
          pc = JSON.parse(line) as PersistedCompaction;
        } catch {
          this.opts.logger.warn(`跳过损坏的压缩记录：${line.slice(0, 80)}`);
          continue;
        }
        // 重建 summary 节点（保留原 id/parentId，不经 appendNode）。
        this.nodes.set(pc.summaryId, {
          id: pc.summaryId,
          role: "user",
          content: pc.summaryContent,
          parentId: pc.summaryParentId,
        });
        this.compactions.push({
          firstPostId: pc.firstPostId,
          summaryId: pc.summaryId,
          firstKeptId: pc.firstKeptId,
        });
        this.summaryIds.add(pc.summaryId);
      }
    } catch {
      // 无压缩记录文件：跳过
    }

    this.opts.logger.info(
      `会话 ${this.id} 已 resume：turns=${this.turnLog.length} 历史消息=${this.nodes.size} 压缩记录=${this.compactions.length} 下一 run=${this.runIndex}`,
    );
    this.wasResumed = this.turnLog.length > 0;
    return this.wasResumed;
  }

  /**
   * 回溯到指定 turn 之前的状态：还原文件快照 + 把 HEAD 移到该 turn 的锚点节点（减法，不删任何节点）。
   * 语义与 CheckpointPort 快照时点对齐（turn 开始、assistant 响应之前）。旧分支全部保留可回切。
   * 无 CheckpointPort（noop）时文件不还原，仅移 HEAD——与降级约定一致。
   */
  async rollback(turnId: string): Promise<void> {
    const idx = this.turnLog.findIndex((r) => r.turnId === turnId);
    if (idx < 0) throw new Error(`未找到 turn：${turnId}`);
    const target = this.turnLog[idx];

    await this.opts.ports.checkpoint.restore(target.checkpointRef);

    // 把 HEAD 移到锚点（该 turn assistant 之前的节点）；不删节点、不删 turnLog 后续记录之外的树。
    this.moveHead(target.anchorNodeId);
    // 丢弃该 turn 及其后的所有 turn 记录，并重写日志（新对话将从锚点长出新分支）。
    this.turnLog.length = idx;
    // prune 掉不再适用于新 HEAD 的压缩记录（firstPostId 不在新 HEAD 祖先链上）。
    const chainIds = new Set(this.ancestorChain(this.headId).map((n) => n.id));
    const keptCompactions = this.compactions.filter(
      (c) => c.firstPostId !== null && chainIds.has(c.firstPostId),
    );
    if (keptCompactions.length !== this.compactions.length) {
      this.compactions.length = 0;
      this.compactions.push(...keptCompactions);
      this.summaryIds.clear();
      for (const c of this.compactions) this.summaryIds.add(c.summaryId);
    }
    try {
      await this.writeTurnLog();
      await this.writeMeta();
      await this.writeCompactions();
    } catch (err) {
      this.opts.logger.warn(`turns 日志重写失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const historyLength = this.pathToHead().length;
    this.emit({ type: "rollback", turnId, historyLength });
    this.opts.logger.debug(`已回溯到 turn ${turnId} 之前，历史长度 ${historyLength}`);
  }
}

/** 近似 token 估算：内容字符数 / 4（供 CompactStrategyPort.shouldCompact 判断）。 */
function approxTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}
