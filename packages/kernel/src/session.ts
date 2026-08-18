import { mkdir, writeFile, readFile, rename, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Message,
  PortRegistry,
  Logger,
  LLMOptions,
  AskQuestionRequest,
  AskQuestionResponse,
  CompactPlan,
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

/**
 * run 进行中尝试移动 HEAD（切分支 / 回溯）时抛出。宿主可据此给出"先停止生成"的提示，
 * 而不是把它当成未知错误。
 */
export class SessionBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBusyError";
  }
}

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
  /**
   * 压缩摘要调用的 provider/model 覆盖；不传则沿用主会话。压缩是"输入巨大、输出结构化、
   * 不需要顶级推理"的任务，适合降级到便宜模型。
   *
   * ⚠️ 仅在 standalone 路线生效：inline 路线复用主会话前缀，换模型等于换缓存空间、必然全量 miss。
   */
  compactionLlmOptions?: Pick<LLMOptions, "provider" | "model">;
  /**
   * 走 inline 压缩（复用主会话前缀）的输入上限（近似 token）。超过则回落 standalone，
   * 因为 inline 把完整路径 + system + tools 全发一遍，装不下会直接 prompt_too_long。
   *
   * 这是个占位上限：真正该用的是模型 contextWindow，但模型元数据/VersionProvider 尚未落地。
   * 刻意不复用 `contextBudgetWarnTokens` —— 那是纯观测阈值，语义不同，借用会让两个概念纠缠。
   */
  compactInlineMaxTokens?: number;
  /**
   * 前缀缓存 TTL（毫秒）。距上次 LLM 调用超过它就认为缓存已冷 → 走 standalone：
   * 缓存冷时 inline 把整段历史按未缓存价重付一遍，反而比 standalone 更贵。
   * 缺省 5min，对齐 Anthropic ephemeral；自动缓存的 provider（DeepSeek 硬盘缓存按小时算）可放大。
   */
  cacheTtlMs?: number;
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
   * 连续压缩失败次数。达 MAX_COMPACT_FAILURES 后停止自动压缩（会话继续跑），
   * 成功一次或显式 `/compact` 归零。用户主动取消导致的失败不计入。
   */
  private compactFailures = 0;
  /** 熔断上限：连续这么多次失败后不再自动发压缩请求，避免每 run 重复付费。 */
  private static readonly MAX_COMPACT_FAILURES = 3;
  /**
   * 上次 LLM 调用的时刻，用于判断前缀缓存大概率是否还热（决定压缩走 inline 还是 standalone）。
   * 在每次 run 收尾与压缩请求后更新：run 刚结束时它就是该 run 最后一次 LLM 调用的时间，
   * 误差在秒级，足够支撑分钟级的 TTL 判断，无需为一个时间戳给 RunLoopDeps 加回调。
   */
  private lastLlmCallAt = 0;
  private static readonly DEFAULT_CACHE_TTL_MS = 5 * 60_000;
  /**
   * Harness 组装的 Runtime 数组：构造时把已装配的 Cost-aware Port 粘合成 loop 认识的统一形状，
   * 一次组装、跨本会话全部 run 复用。Session 之后不再直接调用 modelRouter/costMeter/toolCache/
   * versionProvider 任何一个 Port 方法——调用永远发生在 loop（runTurnLoop/executeTools）内部
   * 的固定分发点，Session 只负责"组装出这个数组"。
   */
  private readonly runtimes: Runtime[];
  private firstRunPrepared = false;
  private runState: "running" | "idle" | "interrupted" | undefined;
  /**
   * 是否有 run 在飞行中。与对外汇报的 `runState` 分开：这个只服务一个不变量 ——
   * run 期间禁止任何移动 HEAD 的操作（详见 assertIdle）。
   */
  private runInFlight = false;

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

  /**
   * run 期间禁止移动 HEAD。
   *
   * 这不是保守起见，而是修一个真实的数据损坏：`sendMessage` 内部有大量 await（hook、压缩、
   * LLM 流、工具执行），并发进来的切分支会改掉 `headId`，于是正在生成的 assistant 消息被
   * `appendNode` 挂到**新分支**上 —— 它却是用旧分支上下文生成的，同一 turn 的 user/assistant
   * 还会分裂到两条树链上。`rollback` 更甚：它在 run 进行中 `checkpoint.restore()` 会把工作区
   * 文件整批换掉，正在跑的工具脚下被抽地毯。
   *
   * 选择"拒绝"而非"排队等 run 结束"：排队会让用户点了之后长时间毫无反应（run 可能几分钟），
   * 且把冲突藏起来；拒绝是显式的，配合 UI 在流式期间禁用按钮，正常路径根本触发不到。
   */
  private assertIdle(operation: string): void {
    if (this.runInFlight) {
      throw new SessionBusyError(
        `${operation} 在生成过程中不可用：请先停止当前回复（run 期间移动 HEAD 会把回复写到错误分支）`,
      );
    }
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
    this.assertIdle("切换分支");
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
    // 同步置位（在任何 await 之前），使并发进来的 fork/switchBranch/rollback 必定看见"运行中"。
    this.runInFlight = true;
    try {
      return await this.runSendMessage(text, ports, hooks, logger);
    } finally {
      this.runInFlight = false;
    }
  }

  private async runSendMessage(
    text: string,
    ports: SessionOptions["ports"],
    hooks: SessionOptions["hooks"],
    logger: Logger,
  ): Promise<Message[]> {
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

    // 缓存纪律一：system 前缀（base + memory 召回 + SessionStart 注入）每会话只算一次并冻结，之后每 run 复用。
    // 必须算在 maybeCompact 之前：压缩若走"复用主会话前缀"路线，需要拿到这份 system。
    if (this.systemPrefix === null) {
      const recalled = await ports.memory.recall(text);
      const parts = [this.opts.system];
      if (recalled) parts.push(`<memory>\n${recalled}\n</memory>`);
      if (this.sessionStartContext) parts.push(`<hook-context>\n${this.sessionStartContext}\n</hook-context>`);
      this.systemPrefix = parts.join("\n\n");
    }
    const system = this.systemPrefix;

    // run 开始前：对当前路径按策略压缩（把 summary 作为真实节点追加到 HEAD 之下）。
    await this.maybeCompact(runId);

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

    // run 收尾即"最后一次 LLM 调用"的近似时刻，供下次压缩判断前缀缓存是否还热。
    this.lastLlmCallAt = Date.now();

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
   *
   * 失败处理的核心原则是**失败时什么都不改写**：不装节点、不落盘、不移 HEAD。压缩失败的
   * 典型原因（限流、网络、无 provider）都是瞬时的，而一个劣质摘要节点一旦进树就是祖先链的
   * 一部分、还会成为下次压缩的输入 —— 用瞬时故障换永久信息损失是净亏。连续失败达上限后
   * 停止自动压缩但**会话继续跑**（上下文继续增长的兜底另见 issue #32）。
   *
   * @param force 显式压缩（如 `/compact`）绕过熔断，否则熔断就是个静默死锁：
   *   用户换了模型 / 网络恢复了，也没有任何办法让它再试。
   */
  private async maybeCompact(runId: string, { force = false } = {}): Promise<void> {
    const path = this.pathToHead();
    if (path.length === 0) return;
    const { ports } = this.opts;
    const state: ConversationState = {
      messages: path,
      approxTokens: approxTokens(path),
    };
    if (!ports.compact.shouldCompact(state)) return;

    if (!force && this.compactFailures >= Session.MAX_COMPACT_FAILURES) {
      // 熔断：不发请求（抽取式摘要几乎不降 token，重试只会每 run 重复付费）。
      this.emit({
        type: "compact_end",
        summaryLength: 0,
        remaining: path.length,
        status: "blocked",
        reason: `已连续 ${this.compactFailures} 次压缩失败，本会话暂停自动压缩`,
      });
      return;
    }
    if (force) this.compactFailures = 0;

    const plan = ports.compact.plan(state);

    this.emit({ type: "compact_start", messageCount: path.length });

    let summaryText: string;
    try {
      summaryText = await this.requestSummary(plan, state, runId);
    } catch (err) {
      // 异常绝不外抛：压缩是优化，失败不该让整轮 run 挂掉（历史上这里穿透出去会让
      // 前端的 isCompacting 永久卡 true）。
      const aborted = this.currentAbort?.signal.aborted ?? false;
      const reason = err instanceof Error ? err.message : String(err);
      if (aborted) {
        // 用户主动取消：对齐 runTurnLoop 的"中断导致的流异常视为正常停止"约定，
        // 不计入熔断 —— 否则几次手动停止就会让熔断在并非连续失败时提前触发。
        this.emit({ type: "compact_end", summaryLength: 0, remaining: path.length, status: "skipped", reason });
      } else {
        this.compactFailures++;
        this.opts.logger.warn(`压缩失败（第 ${this.compactFailures} 次），本次不改写历史：${reason}`);
        this.emit({ type: "compact_end", summaryLength: 0, remaining: path.length, status: "failed", reason });
      }
      return;
    }

    if (summaryText === "") {
      // 产物不可用（parseSummary 判定空/截断/不合格）：与调用失败同等对待，不装劣质节点。
      this.compactFailures++;
      this.emit({
        type: "compact_end",
        summaryLength: 0,
        remaining: path.length,
        status: "failed",
        reason: "摘要产物为空或不可用",
      });
      return;
    }

    const covered = new Set(plan.coveredMessageIds);

    // 安全切点（含 Q1 吸附：首个保留节点绝不为 toolResult，杜绝孤儿 tool_result → Anthropic 400）。
    const lastCoveredIdx = snapCompactionCut(path, covered);
    if (lastCoveredIdx < 0) {
      // 无可安全压缩（未覆盖任何节点，或吸附后退空）：空过。这是正常状态，与 failed 区分开。
      this.emit({
        type: "compact_end",
        summaryLength: summaryText.length,
        remaining: path.length,
        status: "skipped",
      });
      return;
    }

    const tail = path.slice(lastCoveredIdx + 1);
    const summaryNode: Message = {
      id: uid("msg"),
      role: "user",
      content: `<compacted_history>\n${summaryText}\n</compacted_history>`,
      compaction: { firstKeptId: tail[0]?.id ?? null },
    };
    this.appendNode(summaryNode); // parentId = 当前 HEAD，HEAD 前移到 summary
    // summary 不属于任何 turn 的 messages，必须自己落盘，否则 resume 后压缩视图丢失。
    await this.appendLog({ schemaVersion: 1, kind: "node", message: summaryNode });
    this.writtenNodeIds.add(summaryNode.id);
    this.compactFailures = 0;

    this.emit({
      type: "compact_end",
      summaryLength: summaryText.length,
      remaining: this.pathToHead().length,
      status: "ok",
    });
  }

  /**
   * 按计划取摘要文本。调用由 kernel 发而非 Port 自己发：复用主会话前缀需要 system/tools/
   * 断点/模型，这些只有 kernel 有；顺带让计量回到 kernel 既有的分发点，Port 不必再收 runId。
   *
   * 开销上报 CostMeterPort 的 purpose:"compaction"：压缩恰好是把整段对话当输入的大调用，
   * 只在长会话触发，漏记等于成本统计在最该准的时候偏低。
   */
  private async requestSummary(
    plan: CompactPlan,
    state: ConversationState,
    runId: string,
  ): Promise<string> {
    // 预置产物（llm:false / 空对话）：不发任何请求。必须最先判断。
    if (plan.precomputed !== undefined) return plan.precomputed;

    const { ports } = this.opts;
    const inline = this.canCompactInline(plan, state);

    // inline：主会话前缀（system + tools + 完整路径）+ 一条压缩指令。前缀与上一轮请求逐字节一致，
    // 绝大部分输入命中缓存；且不改 tools 数组、不动 tool_choice —— 两者任一变化都会让 messages
    // 缓存失效，等于把这条路线的收益砸光。
    // standalone：独立小 system + 渲染后的对话 + 空 tools，零命中，仅作装不下/缓存已冷时的兜底。
    const providerId = inline
      ? this.opts.llmOptions.provider
      : (this.opts.compactionLlmOptions?.provider ?? this.opts.llmOptions.provider);
    const provider = ports.llm.get(providerId);
    const model = inline
      ? this.opts.llmOptions.model
      : (this.opts.compactionLlmOptions?.model ?? this.opts.llmOptions.model);

    const messages: Message[] = inline
      ? [...state.messages, { id: "compact-request", role: "user", content: plan.inlineInstruction }]
      : [{ id: "compact-request", role: "user", content: plan.standalone.userText }];
    const tools = inline ? this.opts.tools.list() : [];
    const system = inline ? (this.systemPrefix ?? this.opts.system) : plan.standalone.system;

    let out = "";
    for await (const ev of provider.streamMessage(messages, tools, {
      ...this.opts.llmOptions,
      model,
      system,
      maxTokens: plan.maxTokens,
      signal: this.currentAbort?.signal,
    })) {
      if (ev.type === "text-delta") out += ev.text;
      // provider 把预期错误走 Result 通道（StreamEvent.error）而非 throw，这里必须显式识别，
      // 否则会把"限流失败"当成"模型返回了空摘要"。
      else if (ev.type === "error") throw new Error(ev.error);
      else if (ev.type === "message-stop" && ev.usage) {
        ports.costMeter.onLLMCall(runId, {
          provider: provider.id,
          model: model ?? "",
          usage: ev.usage,
          purpose: "compaction",
        });
      }
    }
    this.lastLlmCallAt = Date.now();
    return ports.compact.parseSummary(out, state) ?? "";
  }

  /**
   * 压缩请求能否复用主会话前缀。三个条件缺一不可，任一不满足就回落独立调用：
   *
   * 1. **装得下**：inline 会把完整路径 + system + tools 一起发出去，比 standalone 的截断渲染版更大；
   *    压缩恰恰在"路径已经很大"时触发，装不下就是直接 prompt_too_long。
   * 2. **缓存大概率还热**：冷缓存下 inline 把整段历史按未缓存价重付一遍，比 standalone 更贵。
   * 3. **provider 有前缀缓存**：声明 `caching:"none"` 的实现走 inline 只会白发一份大 prompt。
   */
  private canCompactInline(plan: CompactPlan, state: ConversationState): boolean {
    const provider = this.opts.ports.llm.get(this.opts.llmOptions.provider);
    if (provider.caching === "none") return false;

    // 用 >= 而非 >：到点即视为过期，且让 cacheTtlMs:0 成为"关掉 inline 路线"的明确写法。
    const ttl = this.opts.cacheTtlMs ?? Session.DEFAULT_CACHE_TTL_MS;
    if (Date.now() - this.lastLlmCallAt >= ttl) return false;

    const limit = this.opts.compactInlineMaxTokens;
    if (limit !== undefined) {
      const system = this.systemPrefix ?? this.opts.system;
      const overhead = approxTokens([
        { id: "sys", role: "user", content: system },
        { id: "tools", role: "user", content: JSON.stringify(this.opts.tools.list()) },
      ]);
      if (state.approxTokens + overhead + plan.maxTokens > limit) return false;
    }
    return true;
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
    this.assertIdle("回溯");
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
