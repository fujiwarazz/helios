// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { wsUrlFor } from "./rpc";

describe("web workspace RPC helpers", () => {
  it("encodes only stable workspace ids in a Code launch", () => {
    const url = new URL(
      wsUrlFor(undefined, {
        mode: "code",
        workspaceId: "ws_1",
        roots: [{ rootId: "root_1", strategy: "direct" }],
      }),
    );
    const launch = JSON.parse(url.searchParams.get("launch") ?? "{}") as Record<string, unknown>;

    expect(launch).toEqual({
      mode: "code",
      workspaceId: "ws_1",
      roots: [{ rootId: "root_1", strategy: "direct" }],
    });
    expect(JSON.stringify(launch)).not.toContain("path");
  });

  it("uses resumeSessionId without a competing launch", () => {
    const url = new URL(wsUrlFor("sess_1", { mode: "chat" }));
    expect(url.searchParams.get("resumeSessionId")).toBe("sess_1");
    expect(url.searchParams.has("launch")).toBe(false);
  });
});
