// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { connectElectronTransport } from "./electronRpc";

describe("electron workspace connection", () => {
  it("sends only stable ids in the launch request", async () => {
    const connect = vi.fn(async () => undefined);
    Object.defineProperty(window, "helios", {
      configurable: true,
      value: {
        connect,
        send() {},
        onMessage: () => ({ dispose() {} }),
        onClose: () => ({ dispose() {} }),
        close() {},
      },
    });

    const transport = await connectElectronTransport(undefined, {
      mode: "code",
      workspaceId: "ws_1",
      roots: [{ rootId: "root_1", strategy: "direct" }],
    });
    transport.close();

    expect(connect).toHaveBeenCalledWith({
      connectionId: expect.any(String),
      launch: {
        mode: "code",
        workspaceId: "ws_1",
        roots: [{ rootId: "root_1", strategy: "direct" }],
      },
    });
    expect(JSON.stringify(connect.mock.calls)).not.toContain("path");
  });
});
