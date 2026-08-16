import type { AgentEvent } from "@helios/kernel";
import type { AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { SessionViewModel, type SessionViewState } from "./sessionViewModel";
import {
  parseSlashCommand,
  runSlashCommand,
  type BranchChoice,
  type ModelDescription,
  type ParsedCommand,
  type SlashCommandHost,
} from "./slashCommands";

/** The slice of Kernel `Session` the interactive terminal depends on. */
export interface InteractiveSession {
  readonly id: string;
  getDisplayHistory(): Message[];
  on(listener: (event: AgentEvent) => void): () => void;
  sendMessage(text: string): Promise<Message[]>;
  cancel(): void;
  listBranches(): readonly { leafId: string; depth: number }[];
  switchBranch(leafId: string): void;
}

/**
 * Capabilities owned by the CLI runtime layer rather than the terminal: workspace leases and
 * `BoundSession` lifecycle live there, so session replacement is an async host operation.
 */
export interface InteractiveHost {
  describeModel(): ModelDescription | undefined;
  resumeSession(sessionId: string): Promise<InteractiveSession>;
}

export interface InteractiveView {
  start(state: SessionViewState): void;
  update(state: SessionViewState): void;
  stop(): Promise<void>;
  onSubmit(handler: (text: string) => void): void;
  onCancel(handler: () => void): void;
  onExit(handler: () => void): void;
  askQuestion(request: AskQuestionRequest): Promise<AskQuestionResponse>;
}

export class InteractiveCli {
  private readonly model = new SessionViewModel();
  private session: InteractiveSession;
  private unsubscribe?: () => void;
  private submitting = false;
  /** True between releasing the old runtime and binding a replacement; sends are refused. */
  private detached = false;
  private resolveExit?: () => void;
  private readonly exited = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(
    private readonly options: {
      session: InteractiveSession;
      view: InteractiveView;
      host?: InteractiveHost;
    },
  ) {
    this.session = options.session;
  }

  async start(): Promise<void> {
    this.model.hydrate(this.session.getDisplayHistory());
    this.options.view.onSubmit((text) => void this.submit(text));
    this.options.view.onCancel(() => this.session.cancel());
    this.options.view.onExit(() => void this.stop());
    this.subscribe();
    this.options.view.start(this.model.snapshot());
  }

  askQuestion(request: AskQuestionRequest): Promise<AskQuestionResponse> {
    return this.options.view.askQuestion(request);
  }

  /** Local transcript line for host-side reports (Kernel warnings, runtime notices). */
  notice(text: string): void {
    this.model.notice(text);
    this.render();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.options.view.stop();
    this.resolveExit?.();
    this.resolveExit = undefined;
  }

  waitForExit(): Promise<void> {
    return this.exited;
  }

  private subscribe(): void {
    const bound = this.session;
    this.unsubscribe = bound.on((event) => {
      // Ignore late events from a session that was already replaced.
      if (bound !== this.session) return;
      if (event.type === "head_changed") this.rehydrate();
      else this.model.apply(event);
      this.render();
    });
  }

  /** The transcript is always a projection of the bound session's display history. */
  private rehydrate(): void {
    this.model.hydrate(this.session.getDisplayHistory());
  }

  private render(): void {
    this.options.view.update(this.model.snapshot());
  }

  private async submit(text: string): Promise<void> {
    if (!text.trim() || this.submitting) return;
    const command = parseSlashCommand(text);
    if (command) {
      await this.runCommand(command);
      this.render();
      return;
    }
    if (this.detached) {
      this.model.setStatus("会话已断开，请重启：helios --resume <session-id>");
      this.render();
      return;
    }
    if (this.model.snapshot().busy) {
      // Existing busy rule: a run in flight owns the session; the prompt is not queued.
      this.model.setStatus("Agent 正在运行，先 ctrl+c 中断再发送");
      this.render();
      return;
    }
    this.submitting = true;
    try {
      await this.session.sendMessage(text);
    } catch (error) {
      this.model.apply({
        type: "agent_end",
        runId: "local-error",
        turnIds: [],
        newMessages: [],
        error: error instanceof Error ? error.message : String(error),
      });
      this.render();
    } finally {
      this.submitting = false;
    }
  }

  private async runCommand(command: ParsedCommand): Promise<void> {
    await runSlashCommand(command, this.commandHost());
  }

  private commandHost(): SlashCommandHost {
    return {
      isBusy: () => this.model.snapshot().busy,
      notice: (text) => this.model.notice(text),
      status: (text) => this.model.setStatus(text),
      clearTranscript: () => this.model.reset(),
      describeModel: () => this.options.host?.describeModel(),
      listBranches: () => this.branchChoices(),
      switchBranch: (leafId) => this.session.switchBranch(leafId),
      chooseBranch: (choices) => this.chooseBranch(choices),
      resumeSession: (sessionId) => this.replaceSession(sessionId),
    };
  }

  private branchChoices(): BranchChoice[] {
    const history = this.session.getDisplayHistory();
    const headId = history[history.length - 1]?.id;
    return this.session.listBranches().map((branch) => ({
      leafId: branch.leafId,
      depth: branch.depth,
      active: branch.leafId === headId,
    }));
  }

  private async chooseBranch(choices: readonly BranchChoice[]): Promise<string | undefined> {
    const labels = new Map(choices.map((choice) => [branchLabel(choice), choice.leafId]));
    const answer = await this.options.view.askQuestion({
      question: "切换到哪条分支？",
      options: [...labels.keys()].map((label) => ({ label })),
    });
    const selected = answer.answers[0];
    return selected === undefined ? undefined : labels.get(selected);
  }

  /**
   * Releases the current runtime through the host and binds the replacement. The old
   * subscription is dropped first so a disposed session can never emit into this view; if
   * replacement fails the terminal stays alive in the detached state.
   */
  private async replaceSession(sessionId: string): Promise<string> {
    const host = this.options.host;
    if (!host) throw new Error("当前运行模式不支持 /resume");
    if (sessionId === this.session.id) throw new Error("该会话已经是当前会话");
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.detached = true;
    const next = await host.resumeSession(sessionId);
    this.session = next;
    this.detached = false;
    this.subscribe();
    this.rehydrate();
    return next.id;
  }
}

function branchLabel(choice: BranchChoice): string {
  const marker = choice.active ? " *当前" : "";
  return `${choice.leafId.slice(-8)} (depth ${choice.depth})${marker}`;
}
