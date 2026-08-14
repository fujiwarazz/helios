import { mkdir, writeFile, readFile, rename, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Message,
  PortRegistry,
  Logger,
  LLMOptions,
  AskQuestionRequest,
  AskQuestionResponse,
  ConversationState,
  Runtime,
} from "@helios/ports";
import { ToolRegistry } from "./toolRegistry";
import { HookRunner } from "./hookRunner";
import { uid } from "./ids";
import type { AgentEvent, AgentEventListener } from "./events";
import { snapCompactionCut, buildLlmPath } from "./messageTree";
import { runTurnLoop } from "./agentLoop/runTurnLoop";
import type { TurnRecord } from "./agentLoop/types";
import type { LlmRetryOptions } from "./agentLoop/retryBackoff";
import type { ArtifactAction, FileEditObservation } from "./kernel";
import { CostAwareRuntime } from "./agentLoop/costAwareRuntime";
import type { Tracer } from "@helios/observability-langsmith";
import {
  parseJsonLines,
  assertSchemaVersion1,
  isPlainObject,
  UnsupportedSchemaVersionError,
} from "./persistence/schema";
import {
  replaySessionLog,
  SESSION_LOG_FILE,
  type SessionLogEntry,
} from "./persistence/sessionLog";

async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${uid("tmp")}`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface SessionOptions {
  id: string;
  workDir: string;
  sessionDir: string;
  ports: PortRegistry;
  tools: ToolRegistry;
  hooks: HookRunner;
  logger: Logger;
  llmOptions: LLMOptions;
  system: string;
  askQuestion(req: AskQuestionRequest): Promise<AskQuestionResponse>;
  /** 单次 run 内最大 turn 数，防失控 */
  maxTurns?: number;
  /** LLM 调用重试策略覆盖；缺省用 DEFAULT_LLM_RETRY（issue #10）。 */
  llmRetry?: LlmRetryOptions;
  /** 重试等待的注入点，测试可传瞬时 resolve 避免真实等待。 */
  sleep?: (ms: number) => Promise<void>;
  /** 上下文预算可观测性阈值；不传则不检查。见 `agentLoop/contextBudget.ts`。 */
  contextBudgetWarnTokens?: number;
  beforeFirstRun?: (text: string) => Promise<void>;
  onRunStateChange?: (state: "running" | "idle" | "interrupted") => Promise<void>;
  recordEdit?: (edit: FileEditObservation) => Promise<ArtifactAction | void>;
  markAuditGap?: (gap: { toolUseId?: string; reason: string; createdAt: number }) => Promise<void>;
  acquireMutationLease?: (runId: string) => Promise<() => Promise<void>>;
  rollbackPolicy?: "full" | "conversation-only";
  tracer: Tracer;
}

/** 会话元数据，落 `<sessionDir>/kernel-meta.json`，供兼容列表与 resume。 */
export interface KernelSessionMeta {
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastRunIndex: number;
  lastTurnIndex: number;
}

/** @deprecated 使用 KernelSessionMeta；保留别名兼容既有消费方。 */
export type SessionMeta = KernelSessionMeta;

/** 分支信息：叶子 id + 深度 + 是否当前分支 + 预览文本（取分叉点之后的第一条消息，见 listBranches）。 */
export interface BranchInfo {
  leafId: string;
  depth: number;
  isCurrent: boolean;
  preview: string;
}

export class Session {
  readonly id: string;
  /**
   * 消息树：节点只增不删，磁盘上（log.jsonl）同样只追加。`headId` 指向当前对话末端，
   * LLM 只看 `pathToHead()`。回溯/切分支只移动 HEAD，从不删节点 —— 旧分支永远可以切回去，
   * 且这一承诺跨 resume 依然成立（parentId 原样落盘，回放时不再线性化）。
   */
  private readonly nodes = new Map<string, Message>();
  private headId: string | null = null;
  private runIndex = 0;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly maxTurns: number;
  /** 已完成 turn 的记录（只增，rollback 不再截断），供 rollback 定位快照与锚点。 */
  private readonly turnLog: TurnRecord[] = [];
  /** 已写入 log.jsonl 的节点 id：同一条消息可能被相邻两个 turn 的 messages 都带到，去重避免写重复行。 */
  private readonly writtenNodeIds = new Set<string>();
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
  /**
   * Harness 组装的 Runtime 数组：构造时把已装配的 Cost-aware Port 粘合成 loop 认识的统一形状，
   * 一次组装、跨本会话全部 run 复用。Session 之后不再直接调用 modelRouter/costMeter/toolCache/
   * versionProvider 任何一个 Port 方法——调用永远发生在 loop（runTurnLoop/executeTools）内部
   * 的固定分发点，Session 只负责"组装出这个数组"。
   */
  private readonly runtimes: Runtime[];
  private firstRunPrepared = false;
  private runState: "running" | "idle" | "interrupted" | undefined;

  constructor(private readonly opts: SessionOptions) {
    this.id = opts.id;
    this.maxTurns = opts.maxTurns ?? 25;
    this.runtimes = [new CostAwareRuntime(opts.ports)];
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
    if (this.currentAbort) {
      this.currentAbort.abort();
      await this.setRunState("interrupted");
    }
    await this.opts.hooks.runSessionEnd({ sessionId: this.id, workDir: this.opts.workDir });
  }

  // -------------------------------------------------------------------------
  // 消息树核心
  // -------------------------------------------------------------------------

  /** 从 HEAD 沿 parentId 上溯到根的物理链（HEAD 在前）。压缩节点是真实节点，故会出现在链中。 */
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

  /** 发给 LLM 的有效路径（时间正序）：链上有压缩节点时由它取代被覆盖区间。 */
  private pathToHead(): Message[] {
    return buildLlmPath(this.ancestorChain(this.headId));
  }

  /** 唯一顺序写入口：把 parentId 指向当前 HEAD，落库并前移 HEAD。 */
  private appendNode(msg: Message): void {
    msg.parentId = this.headId;
    this.nodes.set(msg.id, msg);
    this.headId = msg.id;
  }

  /** 移动 HEAD（回溯/切分支共用）。允许 null（回到空历史）。 */
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

  /**
   * 给人看的当前分支历史。压缩只替换 LLM 的上下文路径，绝不能删除或替换 UI 可见消息；
   * 这里沿物理 parent 链还原并滤掉仅供模型使用的 summary 节点。
   */
  getDisplayHistory(): Message[] {
    return this.ancestorChain(this.headId)
      .filter((n) => !n.compaction)
      .reverse();
  }

  /**
   * 回到某个历史节点继续对话：只移 HEAD，不删任何节点（旧子树保留，随时可切回）。
   * HEAD 的"跳走"要落盘，否则 resume 后会回到日志末端而非用户选定的分支。
   */
  async fork(nodeId: string): Promise<void> {
    if (!this.nodes.has(nodeId)) throw new Error(`node 不存在: ${nodeId}`);
    this.moveHead(nodeId);
    await this.appendLog({ schemaVersion: 1, kind: "head", headId: nodeId, cause: "fork" });
  }

  /** 切换到某条分支的叶子（语义等同 fork 到该叶子）。 */
  async switchBranch(leafId: string): Promise<void> {
    await this.fork(leafId);
  }

  /**
   * 枚举所有分支叶子（无子节点的节点）及其深度，供分支切换 UI。
   * 压缩节点无需特殊排除：它是链上真实节点，且只在 maybeCompact 与紧随的 userMsg 追加之间
   * 短暂成为叶子（都在 sendMessage 内部，无外部可观察窗口）。
   */
  listBranches(): BranchInfo[] {
    const childCount = new Map<string, number>();
    for (const n of this.nodes.values()) {
      if (n.parentId) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);
    }
    const branches: BranchInfo[] = [];
    for (const n of this.nodes.values()) {
      if (childCount.has(n.id)) continue; // 非叶子跳过
      let depth = 0;
      // 分叉消息 = 从叶子上溯途中，最后一个"父节点有多个子"的节点，即本分支独有的第一条消息。
      // 用它做预览而不是叶子：叶子是 assistant 回复，多条分支常常长得一样（同一问题的不同重试），
      // 分叉点之后的第一条消息才是用户真正用来区分分支的内容。
      let divergence: Message | undefined;
      let cur: string | null = n.id;
      while (cur) {
        const node = this.nodes.get(cur);
        if (!node) break;
        depth++;
        if (node.parentId && (childCount.get(node.parentId) ?? 0) > 1) divergence = node;
        cur = node.parentId ?? null;
      }
      branches.push({
        leafId: n.id,
        depth,
        isCurrent: n.id === this.headId,
        preview: previewOf(divergence ?? n),
      });
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
      await this.appendLog({ schemaVersion: 1, kind: "node", message: rejected });
      this.writtenNodeIds.add(rejected.id);
      this.emit({ type: "agent_end", runId: rejectRunId, turnIds: [], newMessages: [rejected], error: submitDecision.reason });
      return [rejected];
    }
    text = submitDecision.text ?? text;

    if (!this.firstRunPrepared) {
      await this.opts.beforeFirstRun?.(text);
      this.firstRunPrepared = true;
    }
    const runId = uid("run");
    let releaseMutationLease: (() => Promise<void>) | undefined;
    await this.setRunState("running");
    let runCompleted = false;
    try {
    releaseMutationLease = await this.opts.acquireMutationLease?.(runId);

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

    const runIndex = this.runIndex++;
    if (!this.title) this.title = text.slice(0, 60);

    const abort = new AbortController();
    this.currentAbort = abort;

    this.emit({ type: "agent_start", runId });

    // run 开始前：对当前路径按策略压缩（把 summary 作为真实节点追加到 HEAD 之下）。
    await this.maybeCompact();

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

    const { turnIds, runError, reachedMaxTurns, costReport } = await runTurnLoop({
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
        // Cost-aware Runtime：Session 构造时组装好的数组，loop 内固定分发点逐一调用。
        runtimes: this.runtimes,
        llmRegistry: ports.llm,
        llmRetry: this.opts.llmRetry,
        sleep: this.opts.sleep,
        contextBudgetWarnTokens: this.opts.contextBudgetWarnTokens,
        fileSystem: ports.fileSystem,
        recordEdit: this.opts.recordEdit,
        markAuditGap: this.opts.markAuditGap,
        tracer: this.opts.tracer,
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
    // costReport 已由 runTurnLoop 内部对 runtimes 分发 onRunEnd 产出；Session 不再直接调用任何 Port。
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
    runCompleted = true;
    return newMessages;
    } finally {
      this.currentAbort = null;
      await this.setRunState(runCompleted ? "idle" : "interrupted");
      await releaseMutationLease?.();
    }
  }

  /**
   * run 开始前的历史压缩：把被压缩区间浓缩为一个 summary 节点，**作为真实节点追加到当前 HEAD 之下**。
   *
   * 挂到 HEAD（而非"最后一个被覆盖节点"）是必须的：部分覆盖时保留 tail 是被覆盖节点的后代，
   * 若把 summary 挂到被覆盖节点，tail 就变成 summary 的兄弟子树而脱离祖先链，整段丢失。
   * 挂到 HEAD 后 tail 自然留在 summary 的祖先链上，由 `firstKeptId` 标出保留边界。
   *
   * 因为 summary 在树上有确定位置，作用域是结构性的：兄弟分支（从更早节点分叉）祖先链上没有它，
   * 天然不受影响 —— 无需旁路记录、无需延迟回填的作用域锚点。旧节点一个不删仍可回溯。
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

    // 安全切点（含 Q1 吸附：首个保留节点绝不为 toolResult，杜绝孤儿 tool_result → Anthropic 400）。
    const lastCoveredIdx = snapCompactionCut(path, covered);
    if (lastCoveredIdx < 0) {
      // 无可安全压缩（未覆盖任何节点，或吸附后退空）：空过。
      this.emit({ type: "compact_end", summaryLength: summary.text.length, remaining: path.length });
      return;
    }

    const tail = path.slice(lastCoveredIdx + 1);
    const summaryNode: Message = {
      id: uid("msg"),
      role: "user",
      content: `<compacted_history>\n${summary.text}\n</compacted_history>`,
      compaction: { firstKeptId: tail[0]?.id ?? null },
    };
    this.appendNode(summaryNode); // parentId = 当前 HEAD，HEAD 前移到 summary
    // summary 不属于任何 turn 的 messages，必须自己落盘，否则 resume 后压缩视图丢失。
    await this.appendLog({ schemaVersion: 1, kind: "node", message: summaryNode });
    this.writtenNodeIds.add(summaryNode.id);

    this.emit({
      type: "compact_end",
      summaryLength: summary.text.length,
      remaining: this.pathToHead().length,
    });
  }

  /**
   * 持久化一个已完成的 turn：先补写本 turn 尚未落盘的节点，再写 turn 元数据。
   * 顺序不可颠倒 —— 崩在中间最坏是"该 turn 回放时不可见"，严格优于"turn 引用了不存在的节点"。
   */
  private async persistTurn(record: TurnRecord): Promise<void> {
    this.turnLog.push(record);
    try {
      for (const msg of record.messages) {
        if (this.writtenNodeIds.has(msg.id)) continue;
        await this.appendLog({ schemaVersion: 1, kind: "node", message: msg });
        this.writtenNodeIds.add(msg.id);
      }
      await this.appendLog({
        schemaVersion: 1,
        kind: "turn",
        turnId: record.turnId,
        runIndex: record.runIndex,
        turnIndex: record.turnIndex,
        checkpointRef: record.checkpointRef,
        anchorNodeId: record.anchorNodeId,
        messageIds: record.messages.map((m) => m.id),
      });
      await this.writeMeta();
    } catch (err) {
      this.turnLog.pop();
      throw err;
    }
  }

  private sessionDir(): string {
    return this.opts.sessionDir;
  }

  /** 追加一条日志。只 append、永不重写 —— 会话再长每次写入都是 O(1)。 */
  private async appendLog(entry: SessionLogEntry): Promise<void> {
    const dir = this.sessionDir();
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, SESSION_LOG_FILE), `${JSON.stringify(entry)}\n`, "utf8");
  }

  /**
   * 会话元数据：体积 O(1)，用原子覆盖写。仅作 listSessions 的廉价展示缓存 ——
   * restore() 永不信任它，runIndex 等一律靠回放 log.jsonl 重算。
   */
  private async writeMeta(): Promise<void> {
    const dir = this.sessionDir();
    await mkdir(dir, { recursive: true });
    const last = this.turnLog[this.turnLog.length - 1];
    const meta: KernelSessionMeta = {
      schemaVersion: 1,
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      lastRunIndex: last?.runIndex ?? -1,
      lastTurnIndex: last?.turnIndex ?? -1,
    };
    await writeFileAtomic(join(dir, "kernel-meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }

  /**
   * 从磁盘 resume：回放 log.jsonl 重建消息树（**含全部分支与压缩节点**）+ turnLog + HEAD，
   * 读 kernel-meta.json 恢复 title/createdAt，并把 runIndex 续到最大已用 run 之后。
   *
   * 与旧实现的关键差别：parentId 原样落盘，回放时不再用当前 HEAD 覆盖 —— 树结构（分支）
   * 真正跨 resume 存活；anchorNodeId 也改为落盘即权威，不再重算。
   * 无 log.jsonl（含旧格式会话）→ 返回 false，当作空会话，不抛错。
   */
  async restore(): Promise<boolean> {
    const dir = this.sessionDir();
    // meta（可选，仅用于恢复 title/createdAt；不作为树状态的依据）
    try {
      const meta = await this.readMeta(dir);
      if (typeof meta.createdAt === "number") this.createdAt = meta.createdAt;
      if (typeof meta.title === "string") this.title = meta.title;
    } catch (error) {
      if (error instanceof UnsupportedSchemaVersionError) throw error;
      // 无 meta 或损坏：忽略，用默认值
    }
    // log.jsonl（唯一权威）
    let raw = "";
    try {
      raw = await readFile(join(dir, SESSION_LOG_FILE), "utf8");
    } catch {
      return false;
    }
    const entries = parseJsonLines<SessionLogEntry>(raw, {
      kind: "session log",
      onCorrupt: (line) => this.opts.logger.warn(`跳过损坏的日志行：${line.slice(0, 80)}`),
    });
    if (entries.length === 0) return false;

    const replayed = replaySessionLog(entries, {
      onAnomaly: (message) => this.opts.logger.warn(`回放异常：${message}`),
    });

    this.nodes.clear();
    for (const [id, msg] of replayed.nodes) this.nodes.set(id, msg);
    this.headId = replayed.headId;
    this.turnLog.length = 0;
    this.turnLog.push(...replayed.turnLog);
    this.runIndex = replayed.maxRunIndex + 1;
    // 磁盘上已有的节点不需要再写一遍
    this.writtenNodeIds.clear();
    for (const id of replayed.nodes.keys()) this.writtenNodeIds.add(id);

    this.opts.logger.info(
      `会话 ${this.id} 已 resume：turns=${this.turnLog.length} 历史消息=${this.nodes.size} 分支=${this.listBranches().length} 下一 run=${this.runIndex}`,
    );
    this.wasResumed = this.turnLog.length > 0;
    return this.wasResumed;
  }

  private async readMeta(dir: string): Promise<KernelSessionMeta> {
    const value: unknown = JSON.parse(await readFile(join(dir, "kernel-meta.json"), "utf8"));
    if (!isPlainObject(value)) throw new Error("invalid kernel session metadata");
    assertSchemaVersion1("kernel session", value);
    return { ...value, schemaVersion: 1 } as unknown as KernelSessionMeta;
  }

  private async setRunState(state: "running" | "idle" | "interrupted"): Promise<void> {
    if (this.runState === state) return;
    await this.opts.onRunStateChange?.(state);
    this.runState = state;
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

    if ((this.opts.rollbackPolicy ?? "full") === "full") {
      await this.opts.ports.checkpoint.restore(target.checkpointRef);
    }

    // 把 HEAD 移到锚点（该 turn assistant 之前的节点）。不删节点、不截断 turnLog、不重写日志 ——
    // 被回溯掉的分支在磁盘上完整保留，仍可 listBranches 枚举并切回。压缩节点的相关性是结构性的：
    // 它若不在新 HEAD 的祖先链上就自动失效，无需 prune 任何旁路记录。
    this.moveHead(target.anchorNodeId);
    await this.appendLog({
      schemaVersion: 1,
      kind: "head",
      headId: target.anchorNodeId,
      cause: "rollback",
    });
    const historyLength = this.pathToHead().length;
    this.emit({ type: "rollback", turnId, historyLength });
    this.opts.logger.debug(`已回溯到 turn ${turnId} 之前，历史长度 ${historyLength}`);
  }
}

/** 分支叶子的展示预览：取消息文本前若干字，供分支切换 UI 区分各分支。 */
function previewOf(msg: Message): string {
  const raw =
    typeof msg.content === "string"
      ? msg.content
      : msg.content
          .map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? `[${b.name}]` : ""))
          .filter(Boolean)
          .join(" ");
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/** 近似 token 估算：内容字符数 / 4（供 CompactStrategyPort.shouldCompact 判断）。 */
function approxTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}
