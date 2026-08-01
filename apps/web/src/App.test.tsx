// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, render, fireEvent, screen } from "@testing-library/react";
import type { AgentEvent } from "@helios/kernel";
import type { Message } from "@helios/ports";
import type { IChatClient } from "@helios/ui-chat";
import { App } from "./App";

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
