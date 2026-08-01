import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Message,
  ContentBlock,
  PortRegistry,
  Logger,
  LLMOptions,
  StopReason,
  AskQuestionRequest,
  AskQuestionResponse,
  ToolContext,
  Ref,
  ConversationState,
} from "@helios/ports";
import { ToolRegistry } from "./toolRegistry";
import { HookRunner } from "./hookRunner";
import { uid } from "./ids";
import type { AgentEvent, AgentEventListener, ToolResultRecord } from "./events";

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

interface TurnRecord {
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
   * 压缩边界节点集合：pathToHead 走到带边界标记的 summary 节点即停止上溯，
   * 从而把被压缩的旧节点排除出「发给 LLM 的路径」，但它们仍留在树里可回溯。
   */
  private readonly compactionBoundaries = new Set<string>();
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
  private createdAt = Date.now();
  private title = "";

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

  // -------------------------------------------------------------------------
  // 消息树核心
  // -------------------------------------------------------------------------

  /** 从 HEAD 沿 parentId 上溯到根（或压缩边界），反转为时间正序 —— LLM 只看这条。 */
  private pathToHead(): Message[] {
    const path: Message[] = [];
    let cur = this.headId;
    while (cur) {
      const n = this.nodes.get(cur);
      if (!n) break;
      path.push(n);
      if (this.compactionBoundaries.has(n.id)) break; // 到压缩边界即止，不再上溯被压缩节点
      cur = n.parentId ?? null;
    }
    return path.reverse();
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
    const runId = uid("run");
    const runIndex = this.runIndex++;
    if (!this.title) this.title = text.slice(0, 60);

    this.emit({ type: "agent_start", runId });

    // run 开始前：对当前路径按策略压缩（生成 summary 节点、移 HEAD；旧节点保留为旧分支）
    await this.maybeCompact();

    // 缓存纪律一：system 前缀（base + memory 召回）每会话只算一次并冻结，之后每 run 复用。
    if (this.systemPrefix === null) {
      const recalled = await ports.memory.recall(text);
      const parts = [this.opts.system];
      if (recalled) parts.push(`<memory>\n${recalled}\n</memory>`);
      this.systemPrefix = parts.join("\n\n");
    }
    const system = this.systemPrefix;

    // run 起点 HEAD，用于收集本 run 新增的路径节点
    const runStartHeadId = this.headId;

    const userMsg: Message = { id: uid("msg"), role: "user", content: text };
    this.appendNode(userMsg);

    const turnIds: string[] = [];
    let turnIndex = 0;
    let pendingTurnLeadMessages: Message[] = [userMsg];
    let runError: string | undefined; // Bug 3：LLM 流错误信息，用于 agent_end 优雅标注

    while (turnIndex < this.maxTurns) {
      const turnId = `${this.id}-${runIndex}-${turnIndex}`;
      turnIds.push(turnId);
      // turn 前锚点 = 此刻 HEAD（本 turn assistant 之前的节点），供回溯定位。
      const anchorNodeId = this.headId;
      const checkpointRef = await ports.checkpoint.snapshot(turnId);
      this.emit({ type: "turn_start", turnId });

      const { assistantMsg, toolUseBlocks, streamError, parseErrorIds } = await this.streamAssistant(
        turnId,
        system,
      );
      assistantMsg.turnId = turnId;

      // Bug 7：只有非空 assistant 消息才入树/持久化，避免 content:[] 触发下游 API 报错。
      const turnMessages: Message[] = [...pendingTurnLeadMessages];
      pendingTurnLeadMessages = [];
      const assistantHasContent = Array.isArray(assistantMsg.content) && assistantMsg.content.length > 0;
      if (assistantHasContent) {
        this.appendNode(assistantMsg);
        turnMessages.push(assistantMsg);
      }

      // Bug 3：LLM 流中途报错 → 优雅结束本 run（保证 agent_end 一定 emit、路径一致），不 throw。
      if (streamError) {
        await this.persistTurn({ turnId, runIndex, turnIndex, checkpointRef, anchorNodeId, messages: turnMessages });
        this.emit({ type: "turn_end", turnId, toolResults: [] });
        runError = streamError;
        break;
      }

      if (toolUseBlocks.length > 0) {
        const { toolResultMsg, records } = await this.executeTools(turnId, toolUseBlocks, parseErrorIds);
        this.appendNode(toolResultMsg);
        turnMessages.push(toolResultMsg);
        await this.persistTurn({ turnId, runIndex, turnIndex, checkpointRef, anchorNodeId, messages: turnMessages });
        this.emit({ type: "turn_end", turnId, toolResults: records });
        turnIndex++;
        continue; // 下一个 turn，把工具结果喂回 LLM
      }

      // 无工具调用：走 Stop hook 判断是否强制继续
      const stopDecision = await hooks.runStop({ turnCount: turnIndex + 1 });
      if (stopDecision.block && stopDecision.message) {
        const injected: Message = { id: uid("msg"), role: "user", content: stopDecision.message, turnId };
        this.appendNode(injected);
        turnMessages.push(injected);
        pendingTurnLeadMessages = [injected];
        await this.persistTurn({ turnId, runIndex, turnIndex, checkpointRef, anchorNodeId, messages: turnMessages });
        this.emit({ type: "turn_end", turnId, toolResults: [] });
        turnIndex++;
        continue;
      }

      await this.persistTurn({ turnId, runIndex, turnIndex, checkpointRef, anchorNodeId, messages: turnMessages });
      this.emit({ type: "turn_end", turnId, toolResults: [] });
      break;
    }

    // Bug 5：因达到 turn 上限（而非 break 自然结束）而退出循环 → 记录并在 agent_end 标注，避免静默截断。
    const reachedMaxTurns = turnIndex >= this.maxTurns;
    if (reachedMaxTurns) {
      logger.warn(`run ${runId} 达到 turn 上限 ${this.maxTurns}，提前结束`);
    }

    const newMessages = this.pathAfter(runStartHeadId);
    this.emit({
      type: "agent_end",
      runId,
      turnIds,
      newMessages,
      error: runError,
      reachedMaxTurns: reachedMaxTurns || undefined,
    });
    logger.debug(`run ${runId} 完成，共 ${turnIds.length} 个 turn`);
    return newMessages;
  }

  /** 当前路径上、位于 anchorId 之后的节点（anchorId=null 表示整条路径）。 */
  private pathAfter(anchorId: string | null): Message[] {
    const full = this.pathToHead();
    if (anchorId === null) return full;
    const idx = full.findIndex((m) => m.id === anchorId);
    return idx < 0 ? full : full.slice(idx + 1);
  }

  private async streamAssistant(
    turnId: string,
    system: string,
  ): Promise<{
    assistantMsg: Message;
    stopReason: StopReason;
    toolUseBlocks: Extract<ContentBlock, { type: "tool_use" }>[];
    /** LLM 流中途报错时的信息（Bug 3）；正常时 undefined。 */
    streamError?: string;
    /** 参数 JSON 解析失败的 tool_use id 集合（Bug 4），executeTools 据此回传错误。 */
    parseErrorIds: Set<string>;
  }> {
    const { ports, logger, llmOptions } = this.opts;
    const provider = ports.llm.get(llmOptions.provider);
    const messageId = uid("msg");
    this.emit({ type: "message_start", messageId, role: "assistant", turnId });

    let textAccum = "";
    const toolCalls = new Map<string, { name: string; args: string }>();
    const order: string[] = [];
    let stopReason: StopReason = "end_turn";
    let streamError: string | undefined;

    // 缓存前提：只发 pathToHead() 这条内容稳定、前缀不漂移的路径。
    const gen = provider.streamMessage(this.pathToHead(), this.opts.tools.list(), {
      ...llmOptions,
      system,
    });

    for await (const ev of gen) {
      this.emit({ type: "message_update", messageId, delta: ev });
      switch (ev.type) {
        case "text-delta":
          textAccum += ev.text;
          break;
        case "tool-call-start":
          toolCalls.set(ev.id, { name: ev.name, args: "" });
          order.push(ev.id);
          break;
        case "tool-call-delta": {
          const tc = toolCalls.get(ev.id);
          if (tc) tc.args += ev.argsDelta;
          break;
        }
        case "tool-call-end":
          break;
        case "message-stop":
          stopReason = ev.stopReason;
          break;
        case "error":
          // Bug 3：不再 throw 穿透整个 run，记录错误并中断流，交由 sendMessage 优雅收尾。
          logger.error(`LLM 流错误：${ev.error}`);
          streamError = ev.error;
          break;
      }
      if (streamError) break;
    }

    const content: ContentBlock[] = [];
    if (textAccum) content.push({ type: "text", text: textAccum });

    // 流错误时丢弃可能被截断的残缺 tool_use（执行会误伤），仅保留已累计文本。
    const toolUseBlocks: Extract<ContentBlock, { type: "tool_use" }>[] = [];
    const parseErrorIds = new Set<string>();
    if (!streamError) {
      for (const id of order) {
        const tc = toolCalls.get(id)!;
        const parsed = parseJsonSafe(tc.args);
        if (!parsed.ok) parseErrorIds.add(id); // Bug 4：标记解析失败
        const block: Extract<ContentBlock, { type: "tool_use" }> = {
          type: "tool_use",
          id,
          name: tc.name,
          input: parsed.value,
        };
        content.push(block);
        toolUseBlocks.push(block);
      }
    }
    if (toolUseBlocks.length > 0) stopReason = "tool_use";

    const assistantMsg: Message = { id: messageId, role: "assistant", content };
    this.emit({ type: "message_end", messageId, role: "assistant", stopReason });
    return { assistantMsg, stopReason, toolUseBlocks, streamError, parseErrorIds };
  }

  private async executeTools(
    turnId: string,
    toolUseBlocks: Extract<ContentBlock, { type: "tool_use" }>[],
    parseErrorIds: Set<string> = new Set(),
  ): Promise<{ toolResultMsg: Message; records: ToolResultRecord[] }> {
    const { ports, hooks, logger, workDir } = this.opts;
    const toolCtx: ToolContext = {
      workDir,
      logger,
      ports,
      askQuestion: this.opts.askQuestion,
    };
    const resultBlocks: ContentBlock[] = [];
    const records: ToolResultRecord[] = [];

    for (const block of toolUseBlocks) {
      let input = block.input;
      let output: unknown;
      let isError = false;

      // Bug 4：参数 JSON 解析失败的工具不执行，直接回传错误让 LLM 重试。
      if (parseErrorIds.has(block.id)) {
        output = "工具参数 JSON 解析失败，请检查参数格式后重试。";
        isError = true;
        this.emit({ type: "tool_execution_start", toolUseId: block.id, name: block.name, input });
        this.emit({ type: "tool_execution_end", toolUseId: block.id, output, isError });
        resultBlocks.push({ type: "tool_result", toolUseId: block.id, output, isError });
        records.push({ toolUseId: block.id, name: block.name, output, isError });
        continue;
      }

      // PreToolUse
      const pre = await hooks.runPreToolUse({ toolName: block.name, input });
      if (pre.decision === "deny") {
        output = `工具调用被 Hook 拒绝：${pre.reason ?? ""}`.trim();
        isError = true;
      } else {
        if (pre.decision === "ask") {
          const ans = await this.opts.askQuestion({
            question: `是否允许执行工具 ${block.name}？`,
            header: "工具审批",
            options: [
              { label: "允许", description: pre.reason },
              { label: "拒绝" },
            ],
          });
          if (ans.answers[0] !== "允许") {
            output = "工具调用被用户拒绝";
            isError = true;
          }
        }
        if (!isError) {
          if (pre.input !== undefined) input = pre.input;
          const tool = this.opts.tools.get(block.name);
          this.emit({ type: "tool_execution_start", toolUseId: block.id, name: block.name, input });
          if (!tool) {
            output = `未找到工具：${block.name}`;
            isError = true;
          } else {
            try {
              const res = await tool.execute(input, toolCtx);
              output = res.output;
              isError = !!res.isError;
            } catch (err) {
              output = err instanceof Error ? err.message : String(err);
              isError = true;
            }
          }
          // PostToolUse
          const post = await hooks.runPostToolUse({ toolName: block.name, input, output, isError });
          if (post.output !== undefined) output = post.output;
          if (post.block) isError = true;
        }
      }

      // Bug 6：end 与 start 成对无条件 emit（emit 很便宜），避免中途订阅收到不成对事件。
      this.emit({ type: "tool_execution_end", toolUseId: block.id, output, isError });
      resultBlocks.push({ type: "tool_result", toolUseId: block.id, output, isError });
      records.push({ toolUseId: block.id, name: block.name, output, isError });
    }

    const toolResultMsg: Message = {
      id: uid("msg"),
      role: "toolResult",
      content: resultBlocks,
      turnId,
    };
    return { toolResultMsg, records };
  }

  /**
   * run 开始前的历史压缩（树模型）：把被压缩区间浓缩为一个 summary 节点，
   * 挂在被压缩区间「当前路径上最后一个被覆盖节点」之下（选法 A，保留血缘可回溯），
   * 并标记为压缩边界 + 前移 HEAD。旧节点一个不删，作为「未压缩旧分支」随时可 switchBranch 回去。
   * summary 节点只装摘要文本，不含 system/tools（那是独立稳定前缀，复制进节点会砸 cache 且 token 翻倍）。
   * CompactStrategyPort 未加载时 shouldCompact 恒 false。
   */
  private async maybeCompact(): Promise<void> {
    const path = this.pathToHead();
    if (path.length === 0) return;
    const { ports } = this.opts;
    const state: ConversationState = {
      messages: path,
      approxTokens: approxTokens(path),
    };
    if (!ports.compact.shouldCompact(state)) return;

    this.emit({ type: "compact_start", messageCount: path.length });
    const summary = await ports.compact.compact([...path]);
    const covered = new Set(summary.coveredMessageIds);

    // 选法 A：summary.parentId 指向当前路径上最后一个被覆盖的节点（血缘相连，可上溯完整旧历史）。
    let parentForSummary: string | null = this.headId;
    for (const m of path) {
      if (covered.has(m.id)) parentForSummary = m.id;
    }

    const summaryNode: Message = {
      id: uid("msg"),
      role: "user",
      content: `<compacted_history>\n${summary.text}\n</compacted_history>`,
      parentId: parentForSummary,
    };
    this.nodes.set(summaryNode.id, summaryNode);
    this.compactionBoundaries.add(summaryNode.id); // pathToHead 到此即止，排除被压缩节点
    this.moveHead(summaryNode.id);

    this.emit({
      type: "compact_end",
      summaryLength: summary.text.length,
      remaining: this.pathToHead().length,
    });
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
    this.compactionBoundaries.clear();
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
    this.opts.logger.info(
      `会话 ${this.id} 已 resume：turns=${this.turnLog.length} 历史消息=${this.nodes.size} 下一 run=${this.runIndex}`,
    );
    return this.turnLog.length > 0;
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
    try {
      await this.writeTurnLog();
      await this.writeMeta();
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

/**
 * 解析 tool_use 参数 JSON。空参数视为合法（无参工具）；
 * 非法 JSON（流式拼接被截断等）返回 ok:false，由 executeTools 回传错误让 LLM 重试，
 * 而非静默吞成 {} 让工具拿空参数硬跑（Bug 4）。
 */
function parseJsonSafe(s: string): { ok: boolean; value: unknown } {
  if (!s || !s.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false, value: {} };
  }
}
