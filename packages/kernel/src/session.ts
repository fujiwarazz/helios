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
  /** turn 快照时刻的对话历史长度，回溯时据此截断内存历史 */
  historyLenBefore: number;
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

export class Session {
  readonly id: string;
  private readonly history: Message[] = [];
  private runIndex = 0;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly maxTurns: number;
  /** 已完成 turn 的持久化记录，供 rollback 定位快照与重写 turns.jsonl */
  private readonly turnLog: TurnRecord[] = [];
  /** 历史压缩后累积的摘要文本，随后续每个 run 注入 system（与 memory 召回同路径） */
  private compactedSummary = "";
  /** 当前 run 的中断控制器，其 signal 贯通到工具（Bash/WebFetch），支持 cancel。 */
  private currentAbort: AbortController | null = null;
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

  /** 中断当前 run：触发 signal，让正在执行的工具（Bash/WebFetch）尽快停止。 */
  cancel(): void {
    this.currentAbort?.abort();
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  /** 发送一条用户消息，驱动一个完整 run（agent_start → 多 turn → agent_end）。 */
  async sendMessage(text: string): Promise<Message[]> {
    const { ports, hooks, logger } = this.opts;
    const runId = uid("run");
    const runIndex = this.runIndex++;
    const before = this.history.length;
    if (!this.title) this.title = text.slice(0, 60);

    const abort = new AbortController();
    this.currentAbort = abort;

    this.emit({ type: "agent_start", runId });

    // run 开始前：对已闭合的历史按策略压缩（截断 + 摘要注入 system）
    await this.maybeCompact();

    // 记忆召回 + 压缩摘要注入 system
    const recalled = await ports.memory.recall(text);
    const parts = [this.opts.system];
    if (this.compactedSummary) {
      parts.push(`<compacted_history>\n${this.compactedSummary}\n</compacted_history>`);
    }
    if (recalled) parts.push(`<memory>\n${recalled}\n</memory>`);
    const system = parts.join("\n\n");

    const userMsg: Message = { id: uid("msg"), role: "user", content: text };
    this.history.push(userMsg);
    // 广播用户消息事件：让订阅端(UI)在 run 进行中即可显示用户气泡，
    // 无需等 run 结束 getHistory。用户文本不流式，一次性 start+delta+end。
    this.emit({ type: "message_start", messageId: userMsg.id, role: "user", turnId: "" });
    this.emit({ type: "message_update", messageId: userMsg.id, delta: { type: "text-delta", text } });
    this.emit({ type: "message_end", messageId: userMsg.id, role: "user" });

    const turnIds: string[] = [];
    let turnIndex = 0;
    let pendingTurnLeadMessages: Message[] = [userMsg];
    let runError: string | undefined; // Bug 3：LLM 流错误信息，用于 agent_end 优雅标注

    while (turnIndex < this.maxTurns) {
      if (abort.signal.aborted) break; // 已中断：不再开新 turn
      const turnId = `${this.id}-${runIndex}-${turnIndex}`;
      turnIds.push(turnId);
      // turn 前快照，供回溯。同时记录此刻历史长度，回溯时据此截断。
      const historyLenBefore = this.history.length;
      const checkpointRef = await ports.checkpoint.snapshot(turnId);
      this.emit({ type: "turn_start", turnId });

      let streamed: Awaited<ReturnType<Session["streamAssistant"]>>;
      try {
        streamed = await this.streamAssistant(turnId, system);
      } catch (err) {
        // 中断导致的流异常（AbortError）视为正常停止，不向上抛
        if (abort.signal.aborted) break;
        throw err;
      }
      const { assistantMsg, toolUseBlocks, streamError, parseErrorIds } = streamed;
      assistantMsg.turnId = turnId;

      // Bug 7：只有非空 assistant 消息才入历史/持久化，避免 content:[] 触发下游 API 报错。
      // thinking 块不算有效正文——只思考不回答/不调工具视为空轮，不入历史。
      // 语义（N3）：thinking-only 轮 = 丢弃该 assistant 消息 + 本 run 正常结束，不重试
      //（区别于 valos 的判空重试；helios 暂不引入重试机制，保持最小实现）。
      const turnMessages: Message[] = [...pendingTurnLeadMessages];
      pendingTurnLeadMessages = [];
      const assistantHasContent =
        Array.isArray(assistantMsg.content) && assistantMsg.content.some((b) => b.type !== "thinking");
      if (assistantHasContent) {
        this.history.push(assistantMsg);
        turnMessages.push(assistantMsg);
      }

      // Bug 3：LLM 流中途报错 → 优雅结束本 run（保证 agent_end 一定 emit、历史一致），不 throw。
      if (streamError) {
        await this.persistTurn({ turnId, runIndex, turnIndex, checkpointRef, historyLenBefore, messages: turnMessages });
        this.emit({ type: "turn_end", turnId, toolResults: [] });
        runError = streamError;
        break;
      }

      if (toolUseBlocks.length > 0) {
        const { toolResultMsg, records } = await this.executeTools(turnId, toolUseBlocks, parseErrorIds);
        this.history.push(toolResultMsg);
        turnMessages.push(toolResultMsg);
        await this.persistTurn({ turnId, runIndex, turnIndex, checkpointRef, historyLenBefore, messages: turnMessages });
        this.emit({ type: "turn_end", turnId, toolResults: records });
        turnIndex++;
        continue; // 下一个 turn，把工具结果喂回 LLM
      }

      // 无工具调用：走 Stop hook 判断是否强制继续
      const stopDecision = await hooks.runStop({ turnCount: turnIndex + 1 });
      if (stopDecision.block && stopDecision.message) {
        const injected: Message = { id: uid("msg"), role: "user", content: stopDecision.message, turnId };
        this.history.push(injected);
        turnMessages.push(injected);
        pendingTurnLeadMessages = [injected];
        await this.persistTurn({ turnId, runIndex, turnIndex, checkpointRef, historyLenBefore, messages: turnMessages });
        this.emit({ type: "turn_end", turnId, toolResults: [] });
        turnIndex++;
        continue;
      }

      await this.persistTurn({ turnId, runIndex, turnIndex, checkpointRef, historyLenBefore, messages: turnMessages });
      this.emit({ type: "turn_end", turnId, toolResults: [] });
      break;
    }

    // Bug 5：因达到 turn 上限（而非 break 自然结束）而退出循环 → 记录并在 agent_end 标注，避免静默截断。
    const reachedMaxTurns = turnIndex >= this.maxTurns;
    if (reachedMaxTurns) {
      logger.warn(`run ${runId} 达到 turn 上限 ${this.maxTurns}，提前结束`);
    }

    const newMessages = this.history.slice(before);
    if (this.currentAbort === abort) this.currentAbort = null; // 清理本 run 的中断控制器
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
    let thinkingAccum = "";
    let thinkingSignature: string | undefined;
    const toolCalls = new Map<string, { name: string; args: string }>();
    const order: string[] = [];
    let stopReason: StopReason = "end_turn";
    let streamError: string | undefined;

    const gen = provider.streamMessage(this.history, this.opts.tools.list(), {
      ...llmOptions,
      system,
      signal: this.currentAbort?.signal,
    });

    for await (const ev of gen) {
      this.emit({ type: "message_update", messageId, delta: ev });
      switch (ev.type) {
        case "text-delta":
          textAccum += ev.text;
          break;
        case "thinking-delta":
          thinkingAccum += ev.text;
          break;
        case "thinking-signature":
          thinkingSignature = ev.signature;
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
    // thinking 块置于最前（Anthropic 回传要求 thinking 先于 text/tool_use）。
    // 限制（N1）：本轮所有 thinking-delta 合并为单个块、signature 取最后一个。
    // Anthropic interleaved thinking（beta，多 thinking 块各自 signature）暂不支持。
    if (thinkingAccum)
      content.push({ type: "thinking", thinking: thinkingAccum, signature: thinkingSignature });
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
      signal: this.currentAbort?.signal,
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
   * run 开始前的历史压缩：此刻历史全部 turn 已闭合（每个 tool_use 都有配对 tool_result），
   * 故可安全按 coveredMessageIds 截断。摘要注入 system 而非塞回 history，
   * 规避角色交替/首条必须 user 等约束。CompactStrategyPort 未加载时 shouldCompact 恒 false。
   */
  private async maybeCompact(): Promise<void> {
    if (this.history.length === 0) return;
    const { ports } = this.opts;
    const state: ConversationState = {
      messages: this.history,
      approxTokens: approxTokens(this.history),
    };
    if (!ports.compact.shouldCompact(state)) return;

    this.emit({ type: "compact_start", messageCount: this.history.length });
    const summary = await ports.compact.compact([...this.history]);
    const covered = new Set(summary.coveredMessageIds);
    const remaining = covered.size > 0 ? this.history.filter((m) => !covered.has(m.id)) : [];
    this.history.length = 0;
    this.history.push(...remaining);
    // 累积摘要（多次压缩时后一次覆盖前一次，已覆盖内容包含在新摘要里）
    this.compactedSummary = summary.text;
    this.emit({
      type: "compact_end",
      summaryLength: summary.text.length,
      remaining: remaining.length,
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
   * 从磁盘 resume：读回 turns.jsonl 全量回放重建 history + turnLog，读 meta.json 恢复
   * title/createdAt，并把 runIndex 续到最大已用 run 之后（新 run index 自然递增不冲突）。
   * 关键：historyLenBefore 按回放时的累计长度**重算**（而非信任落盘值），
   * 使 resume 后的 rollback 索引与重建后的 history 严格一致（规避历史压缩造成的偏移）。
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

    this.history.length = 0;
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
      // 按当前回放进度重算 historyLenBefore
      rec.historyLenBefore = this.history.length;
      this.history.push(...(rec.messages ?? []));
      this.turnLog.push(rec);
      if (rec.runIndex > maxRunIndex) maxRunIndex = rec.runIndex;
    }
    this.runIndex = maxRunIndex + 1;
    this.opts.logger.info(
      `会话 ${this.id} 已 resume：turns=${this.turnLog.length} 历史消息=${this.history.length} 下一 run=${this.runIndex}`,
    );
    return this.turnLog.length > 0;
  }

  /**
   * 回溯到指定 turn 之前的状态：还原文件快照 + 截断对话历史 + 截断 turns 日志。
   * 语义与 CheckpointPort 快照时点对齐（turn 开始、assistant 响应之前）。
   * 无 CheckpointPort（noop）时文件不还原，仅截断历史——与降级约定一致。
   */
  async rollback(turnId: string): Promise<void> {
    const idx = this.turnLog.findIndex((r) => r.turnId === turnId);
    if (idx < 0) throw new Error(`未找到 turn：${turnId}`);
    const target = this.turnLog[idx];

    await this.opts.ports.checkpoint.restore(target.checkpointRef);

    // 截断内存历史到该 turn 快照时刻
    this.history.length = target.historyLenBefore;
    // 丢弃该 turn 及其后的所有 turn 记录，并重写日志
    this.turnLog.length = idx;
    try {
      await this.writeTurnLog();
      await this.writeMeta();
    } catch (err) {
      this.opts.logger.warn(`turns 日志重写失败：${err instanceof Error ? err.message : String(err)}`);
    }
    this.emit({ type: "rollback", turnId, historyLength: this.history.length });
    this.opts.logger.debug(`已回溯到 turn ${turnId} 之前，历史长度 ${this.history.length}`);
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
