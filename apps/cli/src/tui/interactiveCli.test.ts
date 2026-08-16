import type { AgentEvent } from "@helios/kernel";
import type { AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { describe, expect, it } from "vitest";
import type { SessionViewState } from "./sessionViewModel";
import {
  InteractiveCli,
  type InteractiveHost,
  type InteractiveSession,
  type InteractiveView,
} from "./interactiveCli";

class FakeSession implements InteractiveSession {
  readonly sent: string[] = [];
  cancelled = 0;
  switched: string[] = [];
  branches: { leafId: string; depth: number }[] = [];
  history: Message[];
  private listener?: (event: AgentEvent) => void;

  constructor(
    readonly id = "session-1",
    history: Message[] = [{ id: "saved", role: "user", content: "saved message" }],
  ) {
    this.history = history;
  }

  getDisplayHistory(): Message[] {
    return this.history;
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

  listBranches(): readonly { leafId: string; depth: number }[] {
    return this.branches;
  }

  switchBranch(leafId: string): void {
    this.switched.push(leafId);
  }

  emit(event: AgentEvent): void {
    this.listener?.(event);
  }

  get subscribed(): boolean {
    return this.listener !== undefined;
  }
}

class FakeView implements InteractiveView {
  state: SessionViewState | undefined;
  questions: AskQuestionRequest[] = [];
  answer: string | undefined;
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

  askQuestion(request: AskQuestionRequest): Promise<AskQuestionResponse> {
    this.questions.push(request);
    return Promise.resolve({ answers: this.answer === undefined ? [] : [this.answer] });
  }

  submitText(text: string): void {
    this.submit?.(text);
  }

  pressCtrlC(): void {
    this.cancel?.();
  }
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("InteractiveCli", () => {
  it("hydrates history, submits input, consumes events, and cancels", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new InteractiveCli({ session, view });

    await controller.start();
    expect(view.state?.messages).toContainEqual(expect.objectContaining({ text: "saved message" }));

    view.submitText("new prompt");
    await flush();
    expect(session.sent).toEqual(["new prompt"]);

    session.emit({ type: "agent_start", runId: "run-1" });
    session.emit({ type: "tool_execution_start", toolUseId: "tool-1", name: "plugin__custom", input: {} });
    expect(view.state?.tools).toContainEqual(expect.objectContaining({ name: "plugin__custom", status: "running" }));

    view.pressCtrlC();
    expect(session.cancelled).toBe(1);
  });

  it("rehydrates the transcript from the session when the head moves", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    await new InteractiveCli({ session, view }).start();

    session.emit({ type: "message_start", messageId: "assistant-1", role: "assistant", turnId: "t1" });
    session.emit({ type: "message_update", messageId: "assistant-1", delta: { type: "text-delta", text: "draft" } });
    expect(view.state?.messages.map((message) => message.id)).toEqual(["saved", "assistant-1"]);

    session.history = [{ id: "other-branch", role: "assistant", content: "other branch answer" }];
    session.emit({ type: "head_changed", headId: "other-branch" });
    expect(view.state?.messages).toEqual([
      expect.objectContaining({ id: "other-branch", text: "other branch answer" }),
    ]);
  });

  it("handles slash commands locally instead of sending them to the session", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    await new InteractiveCli({
      session,
      view,
      host: {
        describeModel: () => ({ provider: "@helios/llm-openai", model: "gpt-5.4-mini" }),
        resumeSession: () => Promise.reject(new Error("unused")),
      },
    }).start();

    view.submitText("/help");
    await flush();
    view.submitText("/model");
    await flush();
    view.submitText("/nope");
    await flush();

    expect(session.sent).toEqual([]);
    const notices = view.state?.messages.filter((message) => message.role === "system") ?? [];
    expect(notices.some((notice) => notice.text.includes("/resume <session-id>"))).toBe(true);
    expect(notices.some((notice) => notice.text.includes("gpt-5.4-mini"))).toBe(true);
    expect(view.state?.status).toBe("Unknown command: /nope");

    view.submitText("/clear");
    await flush();
    expect(view.state?.messages).toEqual([]);
    expect(view.state?.status).toBe("Cleared");
  });

  it("/tree lists Kernel branch leaves and switches to the selected one", async () => {
    const session = new FakeSession();
    session.branches = [
      { leafId: "msg_branch_a", depth: 3 },
      { leafId: "saved", depth: 1 },
    ];
    const view = new FakeView();
    await new InteractiveCli({ session, view }).start();

    view.answer = "branch_a (depth 3)";
    view.submitText("/tree");
    await flush();

    expect(view.questions[0]?.options?.map((option) => option.label)).toEqual([
      "branch_a (depth 3)",
      "saved (depth 1) *当前",
    ]);
    expect(session.switched).toEqual(["msg_branch_a"]);
  });

  it("/resume rebinds to the new session and unsubscribes the old one", async () => {
    const session = new FakeSession("session-1");
    const next = new FakeSession("session-2", [
      { id: "resumed", role: "assistant", content: "resumed history" },
    ]);
    const view = new FakeView();
    const host: InteractiveHost = {
      describeModel: () => undefined,
      resumeSession: (id) => (id === next.id ? Promise.resolve(next) : Promise.reject(new Error("missing"))),
    };
    await new InteractiveCli({ session, view, host }).start();

    view.submitText("/resume session-2");
    await flush();

    expect(session.subscribed).toBe(false);
    expect(next.subscribed).toBe(true);
    expect(view.state?.status).toBe("已切换到会话 session-2");
    expect(view.state?.messages).toEqual([
      expect.objectContaining({ id: "resumed", text: "resumed history" }),
    ]);

    view.submitText("follow up");
    await flush();
    expect(next.sent).toEqual(["follow up"]);
    expect(session.sent).toEqual([]);
  });

  it("keeps the terminal usable and refuses sends when replacement fails", async () => {
    const session = new FakeSession("session-1");
    const view = new FakeView();
    const host: InteractiveHost = {
      describeModel: () => undefined,
      resumeSession: () => Promise.reject(new Error("session unknown does not exist")),
    };
    await new InteractiveCli({ session, view, host }).start();

    view.submitText("/resume unknown");
    await flush();
    expect(view.state?.status).toBe("resume 失败：session unknown does not exist");

    view.submitText("still typing");
    await flush();
    expect(session.sent).toEqual([]);
    expect(view.state?.status).toContain("helios --resume");
  });

  it("refuses branch and resume commands while a run is in flight", async () => {
    const session = new FakeSession();
    session.branches = [{ leafId: "saved", depth: 1 }];
    const view = new FakeView();
    await new InteractiveCli({ session, view }).start();

    session.emit({ type: "agent_start", runId: "run-1" });
    view.submitText("/tree");
    await flush();
    expect(view.questions).toEqual([]);
    expect(view.state?.status).toBe("Agent 正在运行，/tree 已忽略");

    view.submitText("plain prompt");
    await flush();
    expect(session.sent).toEqual([]);
  });
});
