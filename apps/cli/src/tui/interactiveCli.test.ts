import type { AgentEvent } from "@helios/kernel";
import type { AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { describe, expect, it } from "vitest";
import type { SessionViewState } from "./sessionViewModel";
import { InteractiveCli, type InteractiveSession, type InteractiveView } from "./interactiveCli";

class FakeSession implements InteractiveSession {
  readonly sent: string[] = [];
  cancelled = 0;
  private listener?: (event: AgentEvent) => void;

  getDisplayHistory(): Message[] {
    return [{ id: "saved", role: "user", content: "saved message" }];
  }

  on(listener: (event: AgentEvent) => void): () => void {
    this.listener = listener;
    return () => (this.listener = undefined);
  }

  async sendMessage(text: string): Promise<Message[]> {
    this.sent.push(text);
    return [];
  }

  cancel(): void {
    this.cancelled += 1;
  }

  emit(event: AgentEvent): void {
    this.listener?.(event);
  }
}

class FakeView implements InteractiveView {
  state: SessionViewState | undefined;
  private submit?: (text: string) => void;
  private cancel?: () => void;
  private exit?: () => void;

  start(state: SessionViewState): void {
    this.state = state;
  }

  update(state: SessionViewState): void {
    this.state = state;
  }

  async stop(): Promise<void> {}

  onSubmit(handler: (text: string) => void): void {
    this.submit = handler;
  }

  onCancel(handler: () => void): void {
    this.cancel = handler;
  }

  onExit(handler: () => void): void {
    this.exit = handler;
  }

  askQuestion(_request: AskQuestionRequest): Promise<AskQuestionResponse> {
    return Promise.resolve({ answers: ["Allow"] });
  }

  submitText(text: string): void {
    this.submit?.(text);
  }

  pressCtrlC(): void {
    this.cancel?.();
  }
}

describe("InteractiveCli", () => {
  it("hydrates history, submits input, consumes events, and cancels", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new InteractiveCli({ session, view });

    await controller.start();
    expect(view.state?.messages).toContainEqual(expect.objectContaining({ text: "saved message" }));

    view.submitText("new prompt");
    await Promise.resolve();
    expect(session.sent).toEqual(["new prompt"]);

    session.emit({ type: "agent_start", runId: "run-1" });
    session.emit({ type: "tool_execution_start", toolUseId: "tool-1", name: "plugin__custom", input: {} });
    expect(view.state?.tools).toContainEqual(expect.objectContaining({ name: "plugin__custom", status: "running" }));

    view.pressCtrlC();
    expect(session.cancelled).toBe(1);
  });
});
