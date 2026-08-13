// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, render, fireEvent, screen, cleanup } from "@testing-library/react";
import type { AgentEvent } from "@helios/kernel";
import type { Message } from "@helios/ports";
import { ChatView } from "./ChatView";
import type { IChatClient, ConnectionState, AskQuestion } from "./types";

afterEach(cleanup);

function makeMockClient(): {
  client: IChatClient;
  emit: (e: AgentEvent) => void;
  setState: (s: ConnectionState) => void;
  ask: (q: AskQuestion) => void;
  answered: { questionId: string; answers: string[] }[];
  sent: string[];
} {
  const eventCbs = new Set<(e: AgentEvent) => void>();
  const stateCbs = new Set<(s: ConnectionState) => void>();
  const askCbs = new Set<(q: AskQuestion) => void>();
  const answered: { questionId: string; answers: string[] }[] = [];
  const sent: string[] = [];
  const client: IChatClient = {
    getHistory: async (): Promise<Message[]> => [],
    sendMessage: async (t) => {
      sent.push(t);
      eventCbs.forEach((cb) => cb({ type: "message_start", messageId: "u", role: "user", turnId: "" }));
    },
    onEvent: (cb) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    onState: (cb) => (stateCbs.add(cb), () => stateCbs.delete(cb)),
    onAsk: (cb) => (askCbs.add(cb), () => askCbs.delete(cb)),
    answer: async (questionId, answers) => {
      answered.push({ questionId, answers });
    },
  };
  return {
    client,
    emit: (e) => eventCbs.forEach((cb) => cb(e)),
    setState: (s) => stateCbs.forEach((cb) => cb(s)),
    ask: (q) => askCbs.forEach((cb) => cb(q)),
    answered,
    sent,
  };
}

describe("ChatView", () => {
  it("renders a composer header above the textarea", () => {
    const { client } = makeMockClient();
    render(
      <ChatView
        client={client}
        composerHeader={<div data-testid="workspace-composer">repo</div>}
      />,
    );

    const header = screen.getByTestId("workspace-composer");
    const input = screen.getByTestId("chat-input");
    expect(header.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("can disable submit from both the button and Enter", async () => {
    const { client, sent } = makeMockClient();
    render(<ChatView client={client} canSubmit={false} />);
    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "hello" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(screen.getByTestId("send-button"));
    });

    expect((screen.getByTestId("send-button") as HTMLButtonElement).disabled).toBe(true);
    expect(sent).toEqual([]);
    expect(input.value).toBe("hello");
  });

  it("awaits onBeforeSubmit before sending", async () => {
    const { client, sent } = makeMockClient();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = vi.fn(() => gate);
    render(<ChatView client={client} onBeforeSubmit={before} />);
    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("send-button"));

    expect(before).toHaveBeenCalledWith("hello");
    expect(sent).toEqual([]);
    await act(async () => release());
    expect(sent).toEqual(["hello"]);
    expect(input.value).toBe("");
  });

  it("retains the textarea when onBeforeSubmit fails", async () => {
    const { client, sent } = makeMockClient();
    render(
      <ChatView
        client={client}
        onBeforeSubmit={async () => {
          throw new Error("workspace unavailable");
        }}
      />,
    );
    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => fireEvent.click(screen.getByTestId("send-button")));

    expect(sent).toEqual([]);
    expect(input.value).toBe("hello");
  });

  it("calls onFirstSubmitted once after the first successful send", async () => {
    const { client } = makeMockClient();
    const onFirstSubmitted = vi.fn();
    render(<ChatView client={client} onFirstSubmitted={onFirstSubmitted} />);
    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "one" } });
    await act(async () => fireEvent.click(screen.getByTestId("send-button")));
    fireEvent.change(input, { target: { value: "two" } });
    await act(async () => fireEvent.click(screen.getByTestId("send-button")));

    expect(onFirstSubmitted).toHaveBeenCalledTimes(1);
  });

  it("notifies the shell when sending fails so provisional workspace locks can be released", async () => {
    const { client } = makeMockClient();
    client.sendMessage = async () => {
      throw new Error("first submit failed");
    };
    const onSubmitFailed = vi.fn();
    render(<ChatView client={client} onSubmitFailed={onSubmitFailed} />);
    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "retry me" } });
    await act(async () => fireEvent.click(screen.getByTestId("send-button")));

    expect(onSubmitFailed).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("retry me");
  });

  it("输入并发送 → 调用 sendMessage", async () => {
    const { client, sent } = makeMockClient();
    render(<ChatView client={client} />);
    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("send-button"));
    });
    expect(sent).toEqual(["hello"]);
    expect(input.value).toBe(""); // 发送后清空
  });

  it("断开时显示连接状态条", async () => {
    const { client, setState } = makeMockClient();
    render(<ChatView client={client} />);
    expect(screen.queryByTestId("connection-banner")).toBeNull();
    await act(async () => setState("closed"));
    const banner = screen.getByTestId("connection-banner");
    expect(banner.getAttribute("data-state")).toBe("closed");
  });

  it("渲染工具卡片(带 descriptor)", async () => {
    const { client, emit } = makeMockClient();
    render(
      <ChatView
        client={client}
        renderTool={(name, _i, status) => ({ label: `工具:${name}`, status })}
      />,
    );
    await act(async () => {
      emit({ type: "message_start", messageId: "m1", role: "assistant", turnId: "sess-0-0" });
      emit({ type: "tool_execution_start", toolUseId: "u1", name: "Read", input: {} });
    });
    const card = screen.getByTestId("tool-card");
    expect(card.getAttribute("data-status")).toBe("running");
    expect(card.textContent).toContain("工具:Read");
  });

  it("空态显示示例,点击填入输入框", async () => {
    const { client } = makeMockClient();
    render(<ChatView client={client} examplePrompts={["示例A"]} />);
    expect(screen.getByTestId("empty-state")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("示例A"));
    });
    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    expect(input.value).toBe("示例A");
  });

  it("run 结束后显示唯一回溯入口,确认后 rollback 到该 run 首 turn", async () => {
    const rolled: string[] = [];
    const { client, emit } = makeMockClient();
    client.rollback = async (id) => {
      rolled.push(id);
    };
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try {
      render(<ChatView client={client} />);
      await act(async () => {
        emit({ type: "message_start", messageId: "m1", role: "assistant", turnId: "sess-0-0" });
        emit({ type: "message_update", messageId: "m1", delta: { type: "text-delta", text: "step1" } });
        emit({ type: "turn_end", turnId: "sess-0-0", toolResults: [] });
        emit({ type: "message_start", messageId: "m2", role: "assistant", turnId: "sess-0-1" });
        emit({ type: "message_update", messageId: "m2", delta: { type: "text-delta", text: "step2" } });
        emit({ type: "turn_end", turnId: "sess-0-1", toolResults: [] });
        emit({ type: "agent_end", runId: "r1", turnIds: ["sess-0-0", "sess-0-1"], newMessages: [] });
      });
      const btns = screen.getAllByTestId("rollback-button");
      expect(btns).toHaveLength(1);
      await act(async () => {
        fireEvent.click(btns[0]);
      });
      expect(rolled).toEqual(["sess-0-0"]);
    } finally {
      window.confirm = realConfirm;
    }
  });

  it("describes workspace rollback as conversation-only", async () => {
    const rolled: string[] = [];
    const { client, emit } = makeMockClient();
    client.rollback = async (id) => {
      rolled.push(id);
    };
    const realConfirm = window.confirm;
    window.confirm = vi.fn(() => true);
    try {
      render(<ChatView client={client} rollbackMode="conversation-only" />);
      await act(async () => {
        emit({ type: "message_start", messageId: "m1", role: "assistant", turnId: "sess-0-0" });
        emit({ type: "turn_end", turnId: "sess-0-0", toolResults: [] });
        emit({ type: "agent_end", runId: "r1", turnIds: ["sess-0-0"], newMessages: [] });
      });
      const button = screen.getByTestId("rollback-button");
      expect(button.getAttribute("title")).toContain("回退对话，不修改文件");
      await act(async () => fireEvent.click(button));
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("不修改文件"));
      expect(rolled).toEqual(["sess-0-0"]);
    } finally {
      window.confirm = realConfirm;
    }
  });

  it("审批提问:单选点击即回传答案并清卡片", async () => {
    const { client, ask, answered } = makeMockClient();
    render(<ChatView client={client} />);
    await act(async () => {
      ask({
        questionId: "q1",
        question: "选哪个版本?",
        options: [
          { label: "MVP 优先", description: "最快落地" },
          { label: "风险优先", description: "先堵坑" },
        ],
      });
    });
    expect(screen.getByTestId("approval-card")).toBeTruthy();
    const opts = screen.getAllByTestId("approval-option");
    expect(opts).toHaveLength(2);
    await act(async () => {
      fireEvent.click(opts[0]);
    });
    expect(answered).toEqual([{ questionId: "q1", answers: ["MVP 优先"] }]);
    expect(screen.queryByTestId("approval-card")).toBeNull();
  });

  it("审批提问:多选累积后提交", async () => {
    const { client, ask, answered } = makeMockClient();
    render(<ChatView client={client} />);
    await act(async () => {
      ask({
        questionId: "q2",
        question: "启用哪些?",
        multiSelect: true,
        options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      });
    });
    const opts = screen.getAllByTestId("approval-option");
    await act(async () => {
      fireEvent.click(opts[0]);
      fireEvent.click(opts[2]);
    });
    expect(answered).toEqual([]); // 多选点击只累积
    await act(async () => {
      fireEvent.click(screen.getByTestId("approval-submit"));
    });
    expect(answered).toEqual([{ questionId: "q2", answers: ["A", "C"] }]);
  });

  it("sendMessage 抛错 → 界面显示错误文案,且发送框恢复可用(不卡在停止态)", async () => {
    const client: IChatClient = {
      getHistory: async (): Promise<Message[]> => [],
      sendMessage: async () => {
        throw new Error("402 quota exceeded for user");
      },
      onEvent: () => () => {},
    };
    render(<ChatView client={client} />);
    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "hi" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("send-button"));
    });
    expect(screen.getByText("402 quota exceeded for user")).toBeTruthy();
    expect(screen.queryByTestId("stop-button")).toBeNull(); // 没卡在"流式中"态
    await act(async () => {
      fireEvent.change(input, { target: { value: "再试一次" } });
    });
    expect((screen.getByTestId("send-button") as HTMLButtonElement).disabled).toBe(false); // 发送框恢复可用
  });
});
