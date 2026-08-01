// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, render, fireEvent, screen } from "@testing-library/react";
import type { AgentEvent } from "@helios/kernel";
import type { Message } from "@helios/ports";
import { ChatView } from "./ChatView";
import type { IChatClient, ConnectionState } from "./types";

function makeMockClient(): {
  client: IChatClient;
  emit: (e: AgentEvent) => void;
  setState: (s: ConnectionState) => void;
  sent: string[];
} {
  const eventCbs = new Set<(e: AgentEvent) => void>();
  const stateCbs = new Set<(s: ConnectionState) => void>();
  const sent: string[] = [];
  const client: IChatClient = {
    getHistory: async (): Promise<Message[]> => [],
    sendMessage: async (t) => {
      sent.push(t);
      eventCbs.forEach((cb) => cb({ type: "message_start", messageId: "u", role: "user", turnId: "t" }));
    },
    onEvent: (cb) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    onState: (cb) => (stateCbs.add(cb), () => stateCbs.delete(cb)),
  };
  return {
    client,
    emit: (e) => eventCbs.forEach((cb) => cb(e)),
    setState: (s) => stateCbs.forEach((cb) => cb(s)),
    sent,
  };
}

describe("ChatView", () => {
  it("输入并发送 → 调用 sendMessage", async () => {
    const { client, sent } = makeMockClient();
    render(<ChatView client={client} />);
    const input = screen.getByTestId("chat-input") as HTMLInputElement;
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
      emit({ type: "message_start", messageId: "m1", role: "assistant", turnId: "t1" });
      emit({ type: "tool_execution_start", toolUseId: "u1", name: "Read", input: {} });
    });
    const card = screen.getByTestId("tool-card");
    expect(card.getAttribute("data-status")).toBe("running");
    expect(card.textContent).toContain("工具:Read");
  });
});
