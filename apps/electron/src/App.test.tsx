// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@helios/kernel";
import type { Message } from "@helios/ports";
import type { IChatClient } from "@helios/ui-chat";
import {
  App,
  launchForComposer,
  shouldResetFailedResume,
  shouldShowModeComposer,
} from "./App";

describe("Electron App", () => {
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

  it("falls back to a new Chat when a persisted Electron session cannot resume", () => {
    expect(shouldResetFailedResume("closed", "sess_missing")).toBe(true);
    expect(shouldResetFailedResume("connecting", "sess_missing")).toBe(false);
    expect(shouldResetFailedResume("closed", undefined)).toBe(false);
  });

  it("hides mode and workspace controls after a conversation is bound", () => {
    expect(shouldShowModeComposer(true, { mode: "chat", locked: false }, undefined)).toBe(true);
    expect(
      shouldShowModeComposer(
        true,
        { mode: "code", locked: false, strategy: "direct" },
        undefined,
      ),
    ).toBe(true);
    expect(shouldShowModeComposer(true, { mode: "chat", locked: true }, undefined)).toBe(false);
    expect(
      shouldShowModeComposer(true, {
        mode: "code",
        locked: true,
        workspaceId: "ws_1",
        rootId: "root_1",
        strategy: "direct",
      }, undefined),
    ).toBe(false);
    expect(shouldShowModeComposer(true, { mode: "chat", locked: false }, "sess_1")).toBe(false);
  });

  it("keeps injected ChatView behavior working", async () => {
    const sent: string[] = [];
    const client: IChatClient = {
      getHistory: async (): Promise<Message[]> => [],
      sendMessage: async (text) => {
        sent.push(text);
      },
      onEvent: (_callback: (event: AgentEvent) => void) => () => {},
    };
    render(<App client={client} />);
    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "hello" } });
    await act(async () => fireEvent.click(screen.getByTestId("send-button")));
    expect(sent).toEqual(["hello"]);
  });
});
