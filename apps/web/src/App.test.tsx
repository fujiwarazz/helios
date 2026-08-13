// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, render, fireEvent, screen } from "@testing-library/react";
import type { AgentEvent } from "@helios/kernel";
import type { Message } from "@helios/ports";
import type { IChatClient } from "@helios/ui-chat";
import { App, launchForComposer } from "./App";

function mockClient(): { client: IChatClient; sent: string[] } {
  const sent: string[] = [];
  const client: IChatClient = {
    getHistory: async (): Promise<Message[]> => [],
    sendMessage: async (t) => {
      sent.push(t);
    },
    onEvent: (_cb: (e: AgentEvent) => void) => () => {},
    onState: () => () => {},
  };
  return { client, sent };
}

describe("App", () => {
  it("defaults new conversations to Chat and launches Code by stable ids", () => {
    expect(launchForComposer({ mode: "chat", locked: false })).toEqual({ mode: "chat" });
    expect(
      launchForComposer({
        mode: "code",
        locked: false,
        workspaceId: "ws_1",
        rootId: "root_1",
        strategy: "direct",
      }),
    ).toEqual({
      mode: "code",
      workspaceId: "ws_1",
      roots: [{ rootId: "root_1", strategy: "direct" }],
    });
  });

  it("注入 mock client 时渲染 ChatView 并能发送", async () => {
    const { client, sent } = mockClient();
    render(<App client={client} />);
    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "hi" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("send-button"));
    });
    expect(sent).toEqual(["hi"]);
  });
});
