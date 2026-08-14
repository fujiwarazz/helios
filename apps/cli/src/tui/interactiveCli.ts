import type { AgentEvent } from "@helios/kernel";
import type { AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { SessionViewModel, type SessionViewState } from "./sessionViewModel";

export interface InteractiveSession {
  getDisplayHistory(): Message[];
  on(listener: (event: AgentEvent) => void): () => void;
  sendMessage(text: string): Promise<Message[]>;
  cancel(): void;
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
  private unsubscribe?: () => void;
  private submitting = false;
  private resolveExit?: () => void;
  private readonly exited = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(private readonly options: { session: InteractiveSession; view: InteractiveView }) {}

  async start(): Promise<void> {
    this.model.hydrate(this.options.session.getDisplayHistory());
    this.options.view.onSubmit((text) => void this.submit(text));
    this.options.view.onCancel(() => this.options.session.cancel());
    this.options.view.onExit(() => void this.stop());
    this.unsubscribe = this.options.session.on((event) => {
      this.model.apply(event);
      this.options.view.update(this.model.snapshot());
    });
    this.options.view.start(this.model.snapshot());
  }

  askQuestion(request: AskQuestionRequest): Promise<AskQuestionResponse> {
    return this.options.view.askQuestion(request);
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

  private async submit(text: string): Promise<void> {
    if (!text.trim() || this.submitting || this.model.snapshot().busy) return;
    this.submitting = true;
    try {
      await this.options.session.sendMessage(text);
    } catch (error) {
      this.model.apply({
        type: "agent_end",
        runId: "local-error",
        turnIds: [],
        newMessages: [],
        error: error instanceof Error ? error.message : String(error),
      });
      this.options.view.update(this.model.snapshot());
    } finally {
      this.submitting = false;
    }
  }
}
