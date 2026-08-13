// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { SessionList } from "./SessionList";
import type { SessionMetaView } from "../lib/rpc";

afterEach(cleanup);

const now = new Date("2026-08-07T12:00:00").getTime();
const DAY = 24 * 60 * 60 * 1000;

function meta(id: string, title: string, updatedAt: number): SessionMetaView {
  return {
    schemaVersion: 1,
    id,
    title,
    createdAt: updatedAt,
    updatedAt,
    lastRunIndex: 0,
    lastTurnIndex: 0,
  };
}

describe("SessionList", () => {
  it("空列表显示占位", () => {
    render(<SessionList sessions={[]} activeSessionId={undefined} now={now} onSelect={() => {}} />);
    expect(screen.getByText("还没有会话")).toBeTruthy();
  });

  it("按时间分组并高亮当前", () => {
    const sessions = [
      meta("s1", "今天的会话", now - 60_000),
      meta("s2", "昨天的会话", now - DAY),
    ];
    render(<SessionList sessions={sessions} activeSessionId="s2" now={now} onSelect={() => {}} />);
    expect(screen.getByText("今天")).toBeTruthy();
    expect(screen.getByText("昨天")).toBeTruthy();
    const items = screen.getAllByTestId("session-item");
    const active = items.find((el) => el.getAttribute("data-active") === "true");
    expect(active?.textContent).toContain("昨天的会话");
  });

  it("点击回调选中 id", async () => {
    const picked: string[] = [];
    const sessions = [meta("s1", "会话一", now - 60_000)];
    render(
      <SessionList sessions={sessions} activeSessionId={undefined} now={now} onSelect={(id) => picked.push(id)} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("session-item"));
    });
    expect(picked).toEqual(["s1"]);
  });
});
