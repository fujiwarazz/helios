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

    const turnIds: string[] = [];
    let turnIndex = 0;
    let pendingTurnLeadMessages: Message[] = [userMsg];

    while (turnIndex < this.maxTurns) {
      const turnId = `${this.id}-${runIndex}-${turnIndex}`;
      turnIds.push(turnId);
      // turn 前快照，供回溯。同时记录此刻历史长度，回溯时据此截断。
      const historyLenBefore = this.history.length;
      const checkpointRef = await ports.checkpoint.snapshot(turnId);
      this.emit({ type: "turn_start", turnId });

      const { assistantMsg, stopReason, toolUseBlocks } = await this.streamAssistant(
        turnId,
        system,
      );
      assistantMsg.turnId = turnId;
      this.history.push(assistantMsg);

      const turnMessages: Message[] = [...pendingTurnLeadMessages, assistantMsg];
      pendingTurnLeadMessages = [];

      if (toolUseBlocks.length > 0) {
        const { toolResultMsg, records } = await this.executeTools(turnId, toolUseBlocks);
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
      void stopReason;
      break;
    }

    const newMessages = this.history.slice(before);
    this.emit({ type: "agent_end", runId, turnIds, newMessages });
    logger.debug(`run ${runId} 完成，共 ${turnIds.length} 个 turn`);
    return newMessages;
  }

  private async streamAssistant(
    turnId: string,
    system: string,
  ): Promise<{ assistantMsg: Message; stopReason: StopReason; toolUseBlocks: Extract<ContentBlock, { type: "tool_use" }>[] }> {
    const { ports, logger, llmOptions } = this.opts;
    const provider = ports.llm.get(llmOptions.provider);
    const messageId = uid("msg");
    this.emit({ type: "message_start", messageId, role: "assistant", turnId });

    let textAccum = "";
    const toolCalls = new Map<string, { name: string; args: string }>();
    const order: string[] = [];
    let stopReason: StopReason = "end_turn";

    const gen = provider.streamMessage(this.history, this.opts.tools.list(), {
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
          logger.error(`LLM 流错误：${ev.error}`);
          throw new Error(`LLM 流错误：${ev.error}`);
      }
    }

    const content: ContentBlock[] = [];
    if (textAccum) content.push({ type: "text", text: textAccum });
    const toolUseBlocks: Extract<ContentBlock, { type: "tool_use" }>[] = [];
    for (const id of order) {
      const tc = toolCalls.get(id)!;
      const input = parseJsonSafe(tc.args);
      const block: Extract<ContentBlock, { type: "tool_use" }> = {
        type: "tool_use",
        id,
        name: tc.name,
        input,
      };
      content.push(block);
      toolUseBlocks.push(block);
    }
    if (toolUseBlocks.length > 0) stopReason = "tool_use";

    const assistantMsg: Message = { id: messageId, role: "assistant", content };
    this.emit({ type: "message_end", messageId, role: "assistant", stopReason });
    return { assistantMsg, stopReason, toolUseBlocks };
  }

  private async executeTools(
    turnId: string,
    toolUseBlocks: Extract<ContentBlock, { type: "tool_use" }>[],
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

      if (this.listeners.size > 0) {
        this.emit({ type: "tool_execution_end", toolUseId: block.id, output, isError });
      }
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

function parseJsonSafe(s: string): unknown {
  if (!s || !s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
